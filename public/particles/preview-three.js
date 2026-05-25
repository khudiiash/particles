import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { mergePath, MAX_PATH_POINTS, samplePath, samplePathTangent } from "./path.js";
import { PARTICLE_F, PARTICLE_STRIDE_FLOATS } from "./layout.js";
import { evaluateRotationCurve, mergeRotationCurve, mergeColorCurve, hexToRgb } from "./curves.js";
import { createPreviewShapeGeometry } from "./particleShapes.js";
import { createFluidVolumeMesh, resizeFluidVolumeTexture, applyFluidVolumeUniforms, applyFluidVolumeTransform, packSmokeVolumeBytes } from "./fluid-volume-material.js";

const POINT_COLORS = [0xff00ff, 0x00ff00, 0x0000ff, 0x00ffff, 0xffff00, 0xff8800];

/**
 * Unified Three.js viewport: grid, particles, path spline, gizmo, orbit camera.
 * @param {HTMLElement} container
 * @param {{ onPathChange?: () => void }} opts
 */
export function createThreePreview(container, opts = {}) {
    const canvas = document.createElement("canvas");
    canvas.id = "preview";
    canvas.style.cssText = "flex:1;width:100%;display:block;touch-action:none;";
    container.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0a0a12, 1);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
    camera.position.set(0, 3, 10);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 1, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.update();

    const grid = new THREE.GridHelper(20, 20, 0x444466, 0x333344);
    scene.add(grid);

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const previewLight = new THREE.DirectionalLight(0xffffff, 0.85);
    previewLight.position.set(4, 8, 6);
    scene.add(previewLight);

    const axes = new THREE.AxesHelper(2);
    scene.add(axes);

    const emitterMarker = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 12, 12),
        new THREE.MeshBasicMaterial({ color: 0xf0a500 }),
    );
    scene.add(emitterMarker);

    const spawnPlaneRoot = new THREE.Group();
    scene.add(spawnPlaneRoot);

    let spawnPlaneWire = null;

    function rebuildSpawnPlaneWire() {
        if (spawnPlaneWire) {
            spawnPlaneRoot.remove(spawnPlaneWire);
            spawnPlaneWire.geometry.dispose();
            spawnPlaneWire.material.dispose();
            spawnPlaneWire = null;
        }
        if (motionMode !== "hair" || spawnPlaneRadius <= 0) return;

        const r = spawnPlaneRadius;
        const [ex, ey, ez] = lastEmitterPos;
        const mat = new THREE.LineBasicMaterial({ color: 0x66cc88, transparent: true, opacity: 0.85 });
        const pts = [
            new THREE.Vector3(ex - r, ey, ez - r),
            new THREE.Vector3(ex + r, ey, ez - r),
            new THREE.Vector3(ex + r, ey, ez + r),
            new THREE.Vector3(ex - r, ey, ez + r),
            new THREE.Vector3(ex - r, ey, ez - r),
        ];
        spawnPlaneWire = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
        spawnPlaneRoot.add(spawnPlaneWire);
    }

    function setSpawnPlaneVisible(visible) {
        spawnPlaneRoot.visible = visible;
        rebuildSpawnPlaneWire();
    }

    const boundsRoot = new THREE.Group();
    scene.add(boundsRoot);

    const pathRoot = new THREE.Group();
    scene.add(pathRoot);

    const lineMat = new THREE.LineBasicMaterial({ color: 0xf0a500, linewidth: 2 });
    let curveLine = new THREE.Line(new THREE.BufferGeometry(), lineMat);
    pathRoot.add(curveLine);

    const pointMeshes = [];
    let selectedIndex = 0;
    let pathConfig = mergePath(null);

    const transform = new TransformControls(camera, canvas);
    transform.setMode("translate");
    transform.setSize(0.75);
    scene.add(transform);

    transform.addEventListener("dragging-changed", (e) => {
        controls.enabled = !e.value;
        if (!e.value && selectedIndex === 0) {
            rebakeAnchorToRoot();
        }
    });

    transform.addEventListener("objectChange", () => {
        const mesh = transform.object;
        if (!mesh || mesh.userData.pointIndex === undefined) return;
        const i = mesh.userData.pointIndex;
        pathConfig.points[i] = { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z };
        rebuildCurveLine();
        updateEmitterVisuals();
        opts.onPathChange?.();
    });

    const maxParticles = 10000;
    const iPos = new Float32Array(maxParticles * 3);
    const iColor = new Float32Array(maxParticles * 3);
    const iSize = new Float32Array(maxParticles);
    const iOpacity = new Float32Array(maxParticles);
    const iRotation = new Float32Array(maxParticles);
    const iMotion = new Float32Array(maxParticles * 3);
    const iLifeT = new Float32Array(maxParticles);
    let rotationCurve = mergeRotationCurve(null);
    let stretchAlongMotion = 0;
    let motionMode = "velocity";
    let hairLength = 0.6;
    let hairGrowth = 0.65;
    let hairRandomTilt = 0.35;
    let spawnPlaneRadius = 0;
    let colorCurve = mergeColorCurve(null);
    let depthSortEnabled = false;
    let depthWriteEnabled = false;
    let useMeshLighting = false;
    let particleShape = "disc";
    let shapeWidth = 1;
    let shapeHeight = 1;
    let shapeDepth = 1;

    const _camPos = new THREE.Vector3();
    const _partPos = new THREE.Vector3();
    const _dummy = new THREE.Object3D();
    let lastRenderSettings = {};

    const quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute("position", new THREE.Float32BufferAttribute([
        -1, 1, 0,
        1, 1, 0,
        -1, -1, 0,
        1, -1, 0,
    ], 3));
    quadGeo.setIndex([0, 2, 1, 1, 2, 3]);
    quadGeo.setAttribute("iPos", new THREE.InstancedBufferAttribute(iPos, 3));
    quadGeo.setAttribute("iColor", new THREE.InstancedBufferAttribute(iColor, 3));
    quadGeo.setAttribute("iSize", new THREE.InstancedBufferAttribute(iSize, 1));
    quadGeo.setAttribute("iOpacity", new THREE.InstancedBufferAttribute(iOpacity, 1));
    quadGeo.setAttribute("iRotation", new THREE.InstancedBufferAttribute(iRotation, 1));
    quadGeo.setAttribute("iMotion", new THREE.InstancedBufferAttribute(iMotion, 3));
    quadGeo.setAttribute("iLifeT", new THREE.InstancedBufferAttribute(iLifeT, 1));

    const textureLoader = new THREE.TextureLoader();
    let colorMapTexture = null;
    let colorMapRequestId = 0;

    const particleMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        uniforms: {
            scale: { value: 1.0 },
            viewportSize: { value: new THREE.Vector2(1, 1) },
            stretchAlongMotion: { value: 0.0 },
            motionMode: { value: 0.0 },
            hairLength: { value: 0.6 },
            hairGrowth: { value: 0.65 },
            hairRandomTilt: { value: 0.35 },
            colorMap: { value: null },
            colorMapMix: { value: 1.0 },
            useColorMap: { value: 0 },
            alphaCutoff: { value: 0.05 },
            depthWrite: { value: 0 },
            colorKeyCount: { value: 2 },
            colorKey0: { value: new THREE.Vector4(0, 1, 1, 1) },
            colorKey1: { value: new THREE.Vector4(1, 1, 1, 1) },
            colorKey2: { value: new THREE.Vector4(1, 1, 1, 1) },
            colorKey3: { value: new THREE.Vector4(1, 1, 1, 1) },
        },
        vertexShader: `
            attribute vec3 iPos;
            attribute vec3 iColor;
            attribute float iSize;
            attribute float iOpacity;
            attribute float iRotation;
            attribute vec3 iMotion;
            attribute float iLifeT;
            uniform float scale;
            uniform vec2 viewportSize;
            uniform float stretchAlongMotion;
            uniform float motionMode;
            uniform float hairLength;
            uniform float hairGrowth;
            uniform float hairRandomTilt;
            varying vec3 vColor;
            varying float vOpacity;
            varying float vRotation;
            varying vec2 vCorner;
            varying float vStrandSeed;

            float hash1(float seed) {
                return fract(sin(seed * 12.9898) * 43758.5453);
            }

            vec3 hairRestDir(float seed) {
                float r0 = hash1(seed);
                float r1 = hash1(seed * 7.13);
                float yaw = r0 * 6.2831853;
                float tilt = mix(0.05, hairRandomTilt + 0.05, r1);
                return normalize(vec3(sin(yaw) * sin(tilt), cos(tilt), cos(yaw) * sin(tilt)));
            }

            void main() {
                vColor = iColor;
                vOpacity = iOpacity;
                vRotation = iRotation;
                vStrandSeed = iRotation;
                vec2 corner = position.xy;
                float c = cos(iRotation);
                float s = sin(iRotation);
                corner = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
                vec2 fragCorner = corner;
                vec2 clipCorner = corner;

                if (motionMode > 2.5) {
                    float growth = pow(clamp(iLifeT, 0.0, 1.0), max(hairGrowth, 0.05));
                    float len = max(iSize, 0.001) * hairLength * max(growth, 0.01);
                    vec3 dir = hairRestDir(iRotation * 100.0 + iSize * 17.0);
                    dir = normalize(dir + vec3(iMotion.x, iMotion.y * 0.5, iMotion.z));
                    float along = corner.y * 0.5 + 0.5;
                    vec3 side = cross(dir, vec3(0.0, 1.0, 0.0));
                    if (length(side) < 0.001) side = vec3(1.0, 0.0, 0.0);
                    else side = normalize(side);
                    float width = iSize * mix(1.0, 0.25, along);
                    vec3 worldPos = iPos + dir * len * along + side * corner.x * width * 0.5;
                    vec4 mvCenter = modelViewMatrix * vec4(worldPos, 1.0);
                    vCorner = fragCorner * 0.5 + 0.5;
                    gl_Position = projectionMatrix * mvCenter;
                    return;
                }

                vec4 mvCenter = modelViewMatrix * vec4(iPos, 1.0);
                vec3 motion = iMotion;

                if (stretchAlongMotion > 0.001 && length(motion) > 0.0001) {
                    vec3 viewMotion = (modelViewMatrix * vec4(motion, 0.0)).xyz;
                    vec2 motion2 = viewMotion.xy;
                    if (length(motion2) > 0.0001) {
                        float angle = atan(motion2.y, motion2.x);
                        float cs = cos(angle);
                        float sn = sin(angle);
                        float lx = clipCorner.x * cs + clipCorner.y * sn;
                        float ly = -clipCorner.x * sn + clipCorner.y * cs;
                        lx *= 1.0 + stretchAlongMotion * length(motion);
                        clipCorner = vec2(lx * cs - ly * sn, lx * sn + ly * cs);
                    }
                }

                vCorner = fragCorner * 0.5 + 0.5;
                vec4 clipPos = projectionMatrix * mvCenter;
                float depth = max(-mvCenter.z, 0.001);
                float pixelDiameter = iSize * scale / depth;
                vec2 clipExpand = clipCorner * pixelDiameter / viewportSize * clipPos.w;
                gl_Position = clipPos + vec4(clipExpand, 0.0, 0.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D colorMap;
            uniform float colorMapMix;
            uniform float useColorMap;
            uniform float alphaCutoff;
            uniform float depthWrite;
            uniform float motionMode;
            uniform float colorKeyCount;
            uniform vec4 colorKey0;
            uniform vec4 colorKey1;
            uniform vec4 colorKey2;
            uniform vec4 colorKey3;
            varying vec3 vColor;
            varying float vOpacity;
            varying float vRotation;
            varying vec2 vCorner;
            varying float vStrandSeed;

            vec4 colorKeyAt(int i) {
                if (i == 0) return colorKey0;
                if (i == 1) return colorKey1;
                if (i == 2) return colorKey2;
                return colorKey3;
            }

            vec3 sampleStrandColor(float t) {
                int count = max(int(colorKeyCount), 2);
                int seg = 0;
                for (int i = 0; i < 3; i++) {
                    if (i + 1 >= count) break;
                    vec4 a = colorKeyAt(i);
                    vec4 b = colorKeyAt(i + 1);
                    if (t >= a.x && t <= b.x) { seg = i; break; }
                    if (i == count - 2) seg = i;
                }
                vec4 ka = colorKeyAt(seg);
                vec4 kb = colorKeyAt(min(seg + 1, count - 1));
                float localT = (t - ka.x) / max(kb.x - ka.x, 0.0001);
                return mix(ka.yzw, kb.yzw, localT);
            }

            vec2 rotatePointCoord(vec2 coord) {
                vec2 uv = coord - 0.5;
                float c = cos(vRotation);
                float s = sin(vRotation);
                return vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y) + 0.5;
            }
            void main() {
                vec3 rgb = vColor;
                if (motionMode > 2.5) {
                    rgb = sampleStrandColor(vCorner.y);
                }
                if (useColorMap > 0.5) {
                    vec2 tuv = rotatePointCoord(vec2(vCorner.x, 1.0 - vCorner.y));
                    vec4 tex = texture2D(colorMap, tuv);
                    if (tex.a < alphaCutoff) discard;
                    rgb = mix(rgb, rgb * tex.rgb, colorMapMix);
                    float alpha = tex.a * vOpacity;
                    gl_FragColor = vec4(rgb, alpha);
                    return;
                }
                vec2 uv = rotatePointCoord(vCorner) * 2.0 - 1.0;
                float r2 = dot(uv, uv);
                if (r2 > 1.0) discard;
                float soft = 1.0 - r2;
                float alpha = soft * vOpacity;
                if (depthWrite > 0.5) {
                    alpha *= smoothstep(0.0, 0.35, soft);
                    if (alpha < alphaCutoff) discard;
                }
                gl_FragColor = vec4(rgb, alpha);
            }
        `,
    });

    const particles = new THREE.InstancedMesh(quadGeo, particleMat, maxParticles);
    particles.frustumCulled = false;
    scene.add(particles);

    let fluidModeActive = false;
    let fluidVolumeMesh = null;
    let fluidVolumeTex = null;
    let fluidVolumeMat = null;
    let fluidVolumeGrid = 0;
    let fluidDomainWire = null;

    function ensureFluidDomainWire() {
        if (fluidDomainWire) return;
        const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
        fluidDomainWire = new THREE.LineSegments(
            edges,
            new THREE.LineBasicMaterial({ color: 0x5588cc, transparent: true, opacity: 0.65 }),
        );
        scene.add(fluidDomainWire);
    }

    function ensureFluidVolume(gridSize, stepLength = 0.025) {
        if (fluidVolumeMesh && fluidVolumeGrid === gridSize) {
            if (fluidVolumeMat) {
                fluidVolumeMat.uniforms.stepLength.value = stepLength;
                fluidVolumeMat.uniforms.gridSize.value = gridSize;
            }
            return;
        }
        if (fluidVolumeMesh) {
            scene.remove(fluidVolumeMesh);
            fluidVolumeMesh.geometry.dispose();
            fluidVolumeMat.dispose();
            fluidVolumeTex.dispose();
        }
        const built = createFluidVolumeMesh(stepLength, gridSize);
        fluidVolumeMesh = built.mesh;
        fluidVolumeTex = built.tex;
        fluidVolumeMat = built.mat;
        fluidVolumeGrid = gridSize;
        resizeFluidVolumeTexture(fluidVolumeTex, gridSize);
        scene.add(fluidVolumeMesh);
    }

    let meshParticles = null;
    let meshGeo = null;
    let meshInstanceColors = null;

    function shapeScaleFor(size) {
        if (particleShape === "cylinder" || particleShape === "cone") {
            return new THREE.Vector3(shapeWidth * size, shapeHeight * size, shapeWidth * size);
        }
        if (particleShape === "sphere") {
            return new THREE.Vector3(shapeWidth * size, shapeHeight * size, shapeDepth * size);
        }
        return new THREE.Vector3(shapeWidth * size, shapeHeight * size, shapeDepth * size);
    }

    function createMeshParticleMaterial(render = {}) {
        const useLighting = render.useLighting === true;
        const hasTexture = Boolean((render.colorMap || "").trim());
        const common = {
            color: 0xffffff,
            vertexColors: true,
            transparent: true,
            depthWrite: !!render.depthWrite,
            depthTest: true,
            side: THREE.DoubleSide,
            toneMapped: false,
        };
        const mat = useLighting
            ? new THREE.MeshLambertMaterial({ ...common })
            : new THREE.MeshBasicMaterial({ ...common });
        mat.opacity = 1;
        if (hasTexture && colorMapTexture) {
            mat.map = colorMapTexture;
            mat.map.colorSpace = THREE.SRGBColorSpace;
        }
        applyBlendMode(mat, render.blendMode || "normal", hasTexture, !!render.depthWrite);
        return mat;
    }

    function applyColorMapToMeshMaterial() {
        if (!meshParticles?.material) return;
        const mat = meshParticles.material;
        const hasTexture = Boolean((lastRenderSettings.colorMap || "").trim()) && colorMapTexture;
        mat.map = hasTexture ? colorMapTexture : null;
        mat.needsUpdate = true;
    }

    function rebuildMeshParticles() {
        if (meshParticles) {
            scene.remove(meshParticles);
            meshGeo?.dispose();
            meshParticles.geometry?.dispose();
            meshParticles.material?.dispose();
            meshParticles = null;
            meshGeo = null;
        }
        if (particleShape === "disc") return;

        meshGeo = createPreviewShapeGeometry(particleShape);
        if (!meshGeo) return;

        meshParticles = new THREE.InstancedMesh(
            meshGeo,
            createMeshParticleMaterial(lastRenderSettings),
            maxParticles,
        );
        meshParticles.frustumCulled = false;
        meshParticles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        meshInstanceColors = new Float32Array(maxParticles * 3);
        meshParticles.instanceColor = new THREE.InstancedBufferAttribute(meshInstanceColors, 3);
        meshParticles.instanceColor.setUsage(THREE.DynamicDrawUsage);
        scene.add(meshParticles);
    }

    rebuildMeshParticles();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function selectPoint(i) {
        selectedIndex = Math.max(0, Math.min(pathConfig.points.length - 1, i));
        const mesh = pointMeshes[selectedIndex];
        if (mesh) transform.attach(mesh);
        pointMeshes.forEach((m, idx) => m.scale.setScalar(idx === selectedIndex ? 1.35 : 1));
    }

    function rebuildPointMeshes() {
        pointMeshes.forEach((m) => {
            pathRoot.remove(m);
            m.geometry.dispose();
            m.material.dispose();
        });
        pointMeshes.length = 0;

        pathConfig.points.forEach((pt, i) => {
            const mat = new THREE.MeshBasicMaterial({ color: POINT_COLORS[i % POINT_COLORS.length] });
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.18), mat);
            mesh.position.set(pt.x, pt.y, pt.z);
            mesh.userData.pointIndex = i;
            pathRoot.add(mesh);
            pointMeshes.push(mesh);
        });
        selectPoint(selectedIndex);
    }

    function pathCurvePoints(count = 128) {
        const samples = [];
        for (let i = 0; i <= count; i++) {
            const p = samplePath(pathConfig.points, i / count, pathConfig.tension);
            samples.push(new THREE.Vector3(p.x, p.y, p.z));
        }
        return samples;
    }

    function rebuildCurveLine() {
        pathConfig.points.forEach((pt, i) => {
            if (pointMeshes[i]) pointMeshes[i].position.set(pt.x, pt.y, pt.z);
        });
        curveLine.geometry.dispose();
        curveLine.geometry = new THREE.BufferGeometry().setFromPoints(pathCurvePoints());
    }

    function syncEmitter(pos) {
        pathRoot.position.set(pos[0], pos[1], pos[2]);
        updateEmitterVisuals();
    }

    function getEmitterRoot() {
        return [pathRoot.position.x, pathRoot.position.y, pathRoot.position.z];
    }

    function getEmitterWorldPos() {
        const pt = pathConfig.points[0] || { x: 0, y: 0, z: 0 };
        return [
            pathRoot.position.x + pt.x,
            pathRoot.position.y + pt.y,
            pathRoot.position.z + pt.z,
        ];
    }

    function updateEmitterVisuals() {
        const w = getEmitterWorldPos();
        emitterMarker.position.set(w[0], w[1], w[2]);
        lastEmitterPos = w;
        rebuildBoundsWire(lastCollisionParams);
        rebuildSpawnPlaneWire();
    }

    let lastCollisionParams = {};
    let lastEmitterPos = [0, 0, 0];
    let showBoundsVisible = true;

    function clearBoundsWire() {
        while (boundsRoot.children.length) {
            const child = boundsRoot.children[0];
            boundsRoot.remove(child);
            child.geometry?.dispose();
            child.material?.dispose();
        }
    }

    function rebuildBoundsWire(params = {}) {
        clearBoundsWire();
        boundsRoot.visible = showBoundsVisible;
        if (!showBoundsVisible) return;

        const mode = params.collisionMode || (params.groundPlane ? "plane" : "none");
        if (mode === "none") return;

        const mat = new THREE.LineBasicMaterial({ color: 0x4488ff, transparent: true, opacity: 0.75 });
        const [ex, ey, ez] = lastEmitterPos;

        if (mode === "plane") {
            const groundY = params.groundY ?? 0;
            const bx = params.boundsWidth ?? params.boundsSize ?? 3;
            const bz = params.boundsDepth ?? params.boundsSize ?? 3;
            const spanX = Math.max(bx, 3) * 2;
            const spanZ = Math.max(bz, 3) * 2;
            const pts = [
                new THREE.Vector3(ex - spanX, groundY, ez - spanZ),
                new THREE.Vector3(ex + spanX, groundY, ez - spanZ),
                new THREE.Vector3(ex + spanX, groundY, ez + spanZ),
                new THREE.Vector3(ex - spanX, groundY, ez + spanZ),
                new THREE.Vector3(ex - spanX, groundY, ez - spanZ),
            ];
            boundsRoot.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
            return;
        }

        const size = params.boundsSize ?? 1;
        const halfX = Math.max(params.boundsWidth ?? size, 0.1);
        const halfY = Math.max(params.boundsHeight ?? size, 0.1);
        const halfZ = Math.max(params.boundsDepth ?? size, 0.1);
        const radius = Math.max(params.boundsRadius ?? size, 0.1);
        const floorY = params.groundY ?? 0;
        if (mode === "box") {
            const geo = new THREE.BoxGeometry(halfX * 2, halfY * 2, halfZ * 2);
            const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
            lines.position.set(ex, floorY + halfY, ez);
            geo.dispose();
            boundsRoot.add(lines);
            return;
        }

        if (mode === "sphere") {
            const geo = new THREE.SphereGeometry(radius, 24, 16);
            const lines = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat);
            lines.position.set(ex, floorY + radius, ez);
            geo.dispose();
            boundsRoot.add(lines);
        }
    }

    function setCollisionBounds(params = {}, showBounds = true) {
        lastCollisionParams = params;
        showBoundsVisible = showBounds;
        rebuildBoundsWire(params);
    }

    function rebakeAnchorToRoot() {
        const anchor = pathConfig.points[0];
        if (!anchor) return;
        if (Math.hypot(anchor.x, anchor.y, anchor.z) < 1e-6) return;

        pathRoot.position.x += anchor.x;
        pathRoot.position.y += anchor.y;
        pathRoot.position.z += anchor.z;
        pathConfig.points = pathConfig.points.map((pt) => ({
            x: pt.x - anchor.x,
            y: pt.y - anchor.y,
            z: pt.z - anchor.z,
        }));
        rebuildPointMeshes();
        rebuildCurveLine();
        updateEmitterVisuals();
        opts.onPathChange?.();
    }

    function setPath(path, params) {
        pathConfig = mergePath(path, params);
        if (selectedIndex >= pathConfig.points.length) {
            selectedIndex = pathConfig.points.length - 1;
        }
        rebuildPointMeshes();
        rebuildCurveLine();
        updateEmitterVisuals();
    }

    function applyPathParams(params = {}) {
        const next = mergePath(pathConfig, params);
        const metaChanged = next.tension !== pathConfig.tension
            || next.divergence !== pathConfig.divergence
            || next.divergenceStart !== pathConfig.divergenceStart
            || next.divergenceEnd !== pathConfig.divergenceEnd
            || next.followMode !== pathConfig.followMode
            || next.spiralTurns !== pathConfig.spiralTurns
            || next.spiralRadius !== pathConfig.spiralRadius;
        pathConfig = next;
        if (metaChanged) rebuildCurveLine();
    }

    function getPath() {
        return structuredClone(pathConfig);
    }

    function addPoint() {
        if (pathConfig.points.length >= MAX_PATH_POINTS) return;
        const pts = pathConfig.points;
        const insertAt = selectedIndex < pts.length - 1 ? selectedIndex + 1 : pts.length - 1;
        const a = pts[insertAt - 1];
        const b = pts[insertAt];
        pts.splice(insertAt, 0, {
            x: (a.x + b.x) * 0.5,
            y: (a.y + b.y) * 0.5,
            z: (a.z + b.z) * 0.5,
        });
        selectedIndex = insertAt;
        rebuildPointMeshes();
        rebuildCurveLine();
        opts.onPathChange?.();
    }

    function removePoint() {
        if (pathConfig.points.length <= 2) return;
        pathConfig.points.splice(selectedIndex, 1);
        selectedIndex = Math.min(selectedIndex, pathConfig.points.length - 1);
        rebuildPointMeshes();
        rebuildCurveLine();
        opts.onPathChange?.();
    }

    function updateParticles(f32, count) {
        const max = Math.min(count, maxParticles);
        const pts = pathConfig.points;
        const tension = pathConfig.tension;
        const spline = motionMode === "spline";
        const hair = motionMode === "hair";
        const entries = [];

        for (let i = 0; i < max; i++) {
            const o = i * PARTICLE_STRIDE_FLOATS;
            const life = f32[o + PARTICLE_F.life];
            if (life <= 0) continue;
            entries.push({
                px: f32[o + PARTICLE_F.px],
                py: f32[o + PARTICLE_F.py],
                pz: f32[o + PARTICLE_F.pz],
                pathPhase: f32[o + PARTICLE_F.pathPhase],
                pathSpread: f32[o + PARTICLE_F.pathSpread],
                cr: f32[o + PARTICLE_F.cr],
                cg: f32[o + PARTICLE_F.cg],
                cb: f32[o + PARTICLE_F.cb],
                size: f32[o + PARTICLE_F.size],
                opacity: f32[o + PARTICLE_F.opacity],
                life: f32[o + PARTICLE_F.life],
                maxLife: f32[o + PARTICLE_F.maxLife],
                seed: f32[o + PARTICLE_F.seed],
                vx: f32[o + PARTICLE_F.vx],
                vy: f32[o + PARTICLE_F.vy],
                vz: f32[o + PARTICLE_F.vz],
            });
        }

        if (depthSortEnabled && entries.length > 1) {
            camera.getWorldPosition(_camPos);
            entries.sort((a, b) => {
                _partPos.set(a.px, a.py, a.pz);
                const da = _partPos.distanceToSquared(_camPos);
                _partPos.set(b.px, b.py, b.pz);
                const db = _partPos.distanceToSquared(_camPos);
                return db - da;
            });
        }

        let n = 0;
        const [ex, ey, ez] = lastEmitterPos;
        const useMesh = particleShape !== "disc" && motionMode !== "hair";
        for (const p of entries) {
            if (hair) {
                iPos[n * 3] = ex + p.pathPhase;
                iPos[n * 3 + 1] = ey;
                iPos[n * 3 + 2] = ez + p.pathSpread;
            } else {
                const px = Number.isFinite(p.px) ? p.px : 0;
                const py = Number.isFinite(p.py) ? p.py : 0;
                const pz = Number.isFinite(p.pz) ? p.pz : 0;
                iPos[n * 3] = px;
                iPos[n * 3 + 1] = py;
                iPos[n * 3 + 2] = pz;
            }
            iColor[n * 3] = p.cr;
            iColor[n * 3 + 1] = p.cg;
            iColor[n * 3 + 2] = p.cb;
            iSize[n] = p.size;
            iOpacity[n] = p.opacity;
            const lifeT = p.maxLife > 0 ? 1 - p.life / p.maxLife : 0;
            iLifeT[n] = lifeT;
            iRotation[n] = hair ? p.seed : evaluateRotationCurve(rotationCurve, lifeT, p.seed);
            if (spline) {
                const tan = samplePathTangent(pts, lifeT, tension);
                iMotion[n * 3] = tan.x;
                iMotion[n * 3 + 1] = tan.y;
                iMotion[n * 3 + 2] = tan.z;
            } else {
                iMotion[n * 3] = p.vx;
                iMotion[n * 3 + 1] = p.vy;
                iMotion[n * 3 + 2] = p.vz;
            }

            if (useMesh && meshParticles && meshInstanceColors) {
                _dummy.position.set(iPos[n * 3], iPos[n * 3 + 1], iPos[n * 3 + 2]);
                _dummy.rotation.set(0, iRotation[n], 0);
                _dummy.scale.copy(shapeScaleFor(p.size));
                _dummy.updateMatrix();
                meshParticles.setMatrixAt(n, _dummy.matrix);
                const ci = n * 3;
                meshInstanceColors[ci] = p.cr;
                meshInstanceColors[ci + 1] = p.cg;
                meshInstanceColors[ci + 2] = p.cb;
            }
            n++;
        }

        if (useMesh && meshParticles) {
            particles.visible = false;
            meshParticles.visible = n > 0;
            meshParticles.count = n;
            meshParticles.instanceMatrix.needsUpdate = true;
            if (meshParticles.instanceColor) {
                meshParticles.instanceColor.needsUpdate = true;
            }
        } else {
            particles.visible = n > 0;
            if (meshParticles) meshParticles.visible = false;
            particles.count = n;
            quadGeo.attributes.iPos.needsUpdate = true;
            quadGeo.attributes.iColor.needsUpdate = true;
            quadGeo.attributes.iSize.needsUpdate = true;
            quadGeo.attributes.iOpacity.needsUpdate = true;
            quadGeo.attributes.iRotation.needsUpdate = true;
            quadGeo.attributes.iMotion.needsUpdate = true;
            quadGeo.attributes.iLifeT.needsUpdate = true;
        }
    }

    function syncColorUniforms() {
        const keys = colorCurve.keys || [];
        particleMat.uniforms.colorKeyCount.value = Math.max(keys.length, 2);
        for (let i = 0; i < 4; i++) {
            const k = keys[i] || keys[keys.length - 1] || { t: 1, color: "#ffffff" };
            const rgb = hexToRgb(k.color);
            particleMat.uniforms[`colorKey${i}`].value.set(k.t, rgb[0], rgb[1], rgb[2]);
        }
    }

    function setColorCurve(curve) {
        colorCurve = mergeColorCurve(curve);
        syncColorUniforms();
    }

    function setRotationCurve(curve) {
        rotationCurve = mergeRotationCurve(curve);
    }

    function setMotionSettings(params = {}) {
        motionMode = params.motionMode === "spline" ? "spline"
            : params.motionMode === "hair" ? "hair"
                : "velocity";
        hairLength = params.hairLength ?? 0.6;
        hairGrowth = params.hairGrowth ?? 0.65;
        hairRandomTilt = params.hairRandomTilt ?? 0.35;
        spawnPlaneRadius = params.spawnRadius ?? 0;
        particleMat.uniforms.motionMode.value = motionMode === "hair" ? 3 : motionMode === "spline" ? 1 : 0;
        particleMat.uniforms.hairLength.value = hairLength;
        particleMat.uniforms.hairGrowth.value = hairGrowth;
        particleMat.uniforms.hairRandomTilt.value = hairRandomTilt;
        rebuildSpawnPlaneWire();
    }

    function colorMapUrl(relativePath) {
        if (!relativePath) return "";
        if (/^https?:\/\//i.test(relativePath)) return relativePath;
        return `/${relativePath.replace(/^\//, "")}`;
    }

    function applyBlendMode(material, blendMode = "normal", hasTexture = false, depthWrite = false) {
        material.transparent = true;
        material.depthWrite = !!depthWrite;
        material.depthTest = true;
        if (hasTexture || blendMode === "normal") {
            material.blending = THREE.NormalBlending;
        } else if (blendMode === "additive") {
            material.blending = THREE.AdditiveBlending;
        } else if (blendMode === "multiply") {
            material.blending = THREE.MultiplyBlending;
        } else {
            material.blending = THREE.CustomBlending;
            material.blendSrc = THREE.SrcAlphaFactor;
            material.blendDst = THREE.OneFactor;
            material.blendEquation = THREE.AddEquation;
        }
        material.needsUpdate = true;
    }

    function setRenderSettings(render = {}) {
        lastRenderSettings = { ...render };
        stretchAlongMotion = render.stretchAlongMotion ?? 0;
        const hasTexture = Boolean((render.colorMap || "").trim());
        depthSortEnabled = !!render.depthSort || (!!render.depthWrite && !hasTexture);
        depthWriteEnabled = !!render.depthWrite;
        useMeshLighting = render.useLighting === true;
        const nextShape = render.particleShape || "disc";
        shapeWidth = render.shapeWidth ?? 1;
        shapeHeight = render.shapeHeight ?? 1;
        shapeDepth = render.shapeDepth ?? 1;
        const shapeChanged = nextShape !== particleShape;
        const lightingChanged = useMeshLighting !== (meshParticles?.material?.isMeshLambertMaterial === true);
        if (shapeChanged) {
            particleShape = nextShape;
            rebuildMeshParticles();
        } else if (lightingChanged && particleShape !== "disc") {
            rebuildMeshParticles();
        }
        particleMat.uniforms.stretchAlongMotion.value = stretchAlongMotion;
        const blendMode = render.blendMode || "normal";
        applyBlendMode(particleMat, blendMode, hasTexture, depthWriteEnabled);
        if (meshParticles?.material) {
            meshParticles.material.transparent = true;
            meshParticles.material.depthWrite = !!depthWriteEnabled;
            applyBlendMode(meshParticles.material, blendMode, hasTexture, depthWriteEnabled);
        }
        particleMat.uniforms.colorMapMix.value = render.colorMapMix ?? 1;
        particleMat.uniforms.alphaCutoff.value = render.alphaCutoff ?? 0.05;
        particleMat.uniforms.depthWrite.value = depthWriteEnabled ? 1 : 0;

        const path = (render.colorMap || "").trim();
        if (!path) {
            colorMapRequestId += 1;
            particleMat.uniforms.useColorMap.value = 0;
            particleMat.uniforms.colorMap.value = null;
            if (colorMapTexture) {
                colorMapTexture.dispose();
                colorMapTexture = null;
            }
            applyColorMapToMeshMaterial();
            return;
        }

        const url = colorMapUrl(path);
        const requestId = ++colorMapRequestId;
        textureLoader.load(
            url,
            (tex) => {
                if (requestId !== colorMapRequestId) {
                    tex.dispose();
                    return;
                }
                tex.colorSpace = THREE.SRGBColorSpace;
                colorMapTexture?.dispose();
                colorMapTexture = tex;
                particleMat.uniforms.colorMap.value = tex;
                particleMat.uniforms.useColorMap.value = 1;
                applyColorMapToMeshMaterial();
            },
            undefined,
            (err) => {
                if (requestId !== colorMapRequestId) return;
                console.warn("[particle-preview] color map failed:", url, err);
                particleMat.uniforms.useColorMap.value = 0;
                particleMat.uniforms.colorMap.value = null;
                applyColorMapToMeshMaterial();
            },
        );
    }

    function resize(w, h) {
        if (w <= 0 || h <= 0) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        const dpr = renderer.getPixelRatio();
        const pixelW = w * dpr;
        const pixelH = h * dpr;
        particleMat.uniforms.scale.value = pixelH * 0.5;
        particleMat.uniforms.viewportSize.value.set(pixelW, pixelH);
    }

    function setFluidMode(active, gridSize = 32, stepLength = 0.025) {
        fluidModeActive = active;
        particles.visible = !active;
        if (meshParticles) meshParticles.visible = !active;
        if (active) {
            pointMeshes.forEach((m) => { m.visible = false; });
            curveLine.visible = false;
            transform.detach();
            emitterMarker.visible = true;
            ensureFluidDomainWire();
            ensureFluidVolume(gridSize, stepLength);
            fluidVolumeMesh.visible = true;
        } else {
            if (fluidDomainWire) fluidDomainWire.visible = false;
            if (fluidVolumeMesh) fluidVolumeMesh.visible = false;
        }
    }

    function setFluidRenderSettings({
        stepLength = 0.025,
        gridSize = 32,
        boundsHalf = [0.5, 0.5, 0.5],
        volumeCenter = [0, 0.5, 0],
        densityScale = 1,
        volumeOpacity = 1,
        colorTint = [1, 1, 1],
        showVolumeWire = false,
    } = {}) {
        if (!fluidModeActive) return;
        ensureFluidVolume(gridSize, stepLength);
        applyFluidVolumeTransform(fluidVolumeMesh, fluidDomainWire, { boundsHalf, volumeCenter });
        if (fluidDomainWire) fluidDomainWire.visible = showVolumeWire;
        applyFluidVolumeUniforms(fluidVolumeMat, fluidVolumeMesh, {
            stepLength,
            densityScale,
            opacity: volumeOpacity,
            colorTint,
            gridSize,
        });
    }

    function isFluidModeActive() {
        return fluidModeActive;
    }

    function updateFluidVolume(smokeData, gridSize, byteScale = 32) {
        if (!smokeData || !gridSize) return;
        ensureFluidVolume(gridSize, fluidVolumeMat?.uniforms.stepLength.value ?? 0.025);
        const packed = packSmokeVolumeBytes(smokeData, gridSize, byteScale);
        const texData = fluidVolumeTex.image.data;
        if (texData.length !== packed.length) {
            resizeFluidVolumeTexture(fluidVolumeTex, gridSize, packed);
        } else {
            texData.set(packed);
            fluidVolumeTex.needsUpdate = true;
        }
        if (fluidVolumeMat) fluidVolumeMat.uniforms.gridSize.value = gridSize;
    }

    function getPreviewPixelSize() {
        const dpr = renderer.getPixelRatio();
        return {
            width: Math.max(1, Math.floor(canvas.clientWidth * dpr)),
            height: Math.max(1, Math.floor(canvas.clientHeight * dpr)),
        };
    }

    function render() {
        controls.update();
        if (fluidModeActive && fluidVolumeMesh && fluidVolumeMat) {
            applyFluidVolumeUniforms(fluidVolumeMat, fluidVolumeMesh, {
                stepLength: fluidVolumeMat.uniforms.stepLength.value,
                densityScale: fluidVolumeMat.uniforms.densityScale.value,
                opacity: fluidVolumeMat.uniforms.opacity.value,
                gridSize: fluidVolumeGrid || fluidVolumeMat.uniforms.gridSize.value,
                colorTint: [
                    fluidVolumeMat.uniforms.colorTint.value.r,
                    fluidVolumeMat.uniforms.colorTint.value.g,
                    fluidVolumeMat.uniforms.colorTint.value.b,
                ],
            });
        }
        renderer.render(scene, camera);
    }

    function setPathVisible(splineMode) {
        curveLine.visible = splineMode;
        pointMeshes.forEach((m, i) => {
            m.visible = splineMode || i === 0;
        });
        emitterMarker.visible = true;
        if (pointMeshes[0]) {
            if (!splineMode) {
                selectedIndex = 0;
                transform.attach(pointMeshes[0]);
                pointMeshes.forEach((m, idx) => m.scale.setScalar(idx === 0 ? 1.35 : 1));
            } else if (transform.object == null && pointMeshes[selectedIndex]) {
                transform.attach(pointMeshes[selectedIndex]);
            }
        } else if (!splineMode) {
            transform.detach();
        }
        updateEmitterVisuals();
    }

    function resetCamera() {
        camera.position.set(0, 3, 10);
        controls.target.set(0, 1, 0);
        controls.update();
    }

    function isGizmoDragging() {
        return transform.dragging;
    }

    canvas.addEventListener("pointerdown", (e) => {
        if (transform.dragging) return;
        const rect = canvas.getBoundingClientRect();
        pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(pointMeshes);
        if (hits.length) {
            selectPoint(hits[0].object.userData.pointIndex);
            e.stopPropagation();
        }
    });

    const ro = new ResizeObserver(() => {
        resize(container.clientWidth, container.clientHeight);
    });
    ro.observe(container);

    setPath(null, {});
    syncEmitter([0, 0, 0]);
    setPathVisible(false);
    updateEmitterVisuals();
    applyBlendMode(particleMat, "normal", false);
    resize(container.clientWidth, container.clientHeight);

    function getEmitterPos() {
        return getEmitterWorldPos();
    }

    return {
        canvas,
        camera,
        controls,
        setPath,
        getPath,
        applyPathParams,
        addPoint,
        removePoint,
        syncEmitter,
        getEmitterRoot,
        getEmitterWorldPos,
        updateEmitterVisuals,
        getEmitterPos,
        setPathVisible,
        setSpawnPlaneVisible,
        updateParticles,
        setRotationCurve,
        setColorCurve,
        setMotionSettings,
        setCollisionBounds,
        setRenderSettings,
        resize,
        render,
        resetCamera,
        isGizmoDragging,
        setFluidMode,
        isFluidModeActive,
        setFluidRenderSettings,
        getPreviewPixelSize,
        updateFluidVolume,
        dispose() {
            ro.disconnect();
            fluidVolumeMesh?.geometry?.dispose();
            fluidVolumeMat?.dispose();
            fluidVolumeTex?.dispose();
            fluidDomainWire?.geometry?.dispose();
            fluidDomainWire?.material?.dispose();
            renderer.dispose();
        },
    };
}
