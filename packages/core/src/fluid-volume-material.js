import * as THREE from "three";

const VOLUME_VERT = /* glsl */ `
uniform mat4 modelMatrixInverse;

varying vec3 vOrigin;
varying vec3 vDirection;

void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vOrigin = (modelMatrixInverse * vec4(cameraPosition, 1.0)).xyz;
    vDirection = position - vOrigin;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const VOLUME_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;

uniform sampler3D smokeVolume;
uniform float stepLength;
uniform float densityScale;
uniform float opacity;
uniform vec3 colorTint;
uniform float gridSize;

varying vec3 vOrigin;
varying vec3 vDirection;

vec3 blackbody(float t) {
    float x = clamp(t / 3000.0, 0.0, 1.0);
    return mix(vec3(1.0, 0.25, 0.05), vec3(1.0, 0.95, 0.85), x);
}

vec2 rayBox(vec3 origin, vec3 dir, vec3 bmin, vec3 bmax) {
    vec3 inv = 1.0 / (dir + vec3(1e-6));
    vec3 t0 = (bmin - origin) * inv;
    vec3 t1 = (bmax - origin) * inv;
    vec3 tmin = min(t0, t1);
    vec3 tmax = max(t0, t1);
    float near = max(max(tmin.x, tmin.y), tmin.z);
    float far = min(min(tmax.x, tmax.y), tmax.z);
    return vec2(near, far);
}

void main() {
    vec3 rayDir = normalize(vDirection);
    vec2 hit = rayBox(vOrigin, rayDir, vec3(-0.5), vec3(0.5));
    if (hit.y <= max(hit.x, 0.0)) {
        discard;
    }

    float t = max(hit.x, 0.0);
    float tEnd = hit.y;
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    const int STEPS = 88;
    float span = tEnd - t;
    float dt = span / float(STEPS);
    float voxelStep = 1.0 / max(gridSize, 8.0);
    float marchStep = max(stepLength, voxelStep * 0.35) * densityScale;

    for (int i = 0; i < STEPS; i++) {
        float ft = t + dt * (float(i) + 0.5);
        vec3 p = vOrigin + rayDir * ft;
        if (any(lessThan(p, vec3(-0.5))) || any(greaterThan(p, vec3(0.5)))) {
            continue;
        }
        vec3 uvw = p + 0.5;
        vec4 smoke = texture(smokeVolume, uvw);
        float temp = smoke.z * 4000.0;
        vec3 sampleCol = vec3(smoke.r, smoke.g, mix(smoke.r, smoke.g, 0.4)) * colorTint;
        if (temp > 280.0) {
            float hot = clamp((temp - 280.0) / 900.0, 0.0, 1.0);
            sampleCol += blackbody(temp) * hot * 0.55;
        }
        float density = smoke.w * marchStep;
        float a = 1.0 - exp(-density);
        col += (1.0 - alpha) * a * sampleCol;
        alpha += (1.0 - alpha) * a;
        if (alpha > 0.97) {
            break;
        }
    }

    alpha *= opacity;
    if (alpha < 0.01) {
        discard;
    }
    gl_FragColor = vec4(col, alpha);
}
`;

/** Fixed-scale pack — no per-frame max normalize (that was forcing a white blob). */
export function packSmokeVolumeBytes(floatData, gridSize, byteScale = 32) {
    const n = gridSize ** 3;
    const out = new Uint8Array(n * 4);
    const scale = Math.max(6, byteScale);
    for (let i = 0; i < n; i++) {
        const j = i * 4;
        out[j] = Math.min(255, Math.round(floatData[j] * 255));
        out[j + 1] = Math.min(255, Math.round(floatData[j + 1] * 255));
        out[j + 2] = Math.min(255, Math.round(floatData[j + 2] / 4000 * 255));
        const d = Math.min(1, floatData[j + 3] * scale);
        out[j + 3] = Math.min(255, Math.round(d * 255));
    }
    return out;
}

export function createFluidVolumeMesh(stepLength = 0.025, gridSize = 64) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const tex = new THREE.Data3DTexture(new Uint8Array(4), 1, 1, 1);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.unpackAlignment = 1;

    const mat = new THREE.ShaderMaterial({
        uniforms: {
            smokeVolume: { value: tex },
            stepLength: { value: stepLength },
            densityScale: { value: 1 },
            opacity: { value: 1 },
            colorTint: { value: new THREE.Color(1, 1, 1) },
            gridSize: { value: gridSize },
            modelMatrixInverse: { value: new THREE.Matrix4() },
        },
        vertexShader: VOLUME_VERT,
        fragmentShader: VOLUME_FRAG,
        transparent: true,
        depthWrite: false,
        side: THREE.BackSide,
        toneMapped: false,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    return { mesh, tex, mat };
}

export function resizeFluidVolumeTexture(tex, gridSize, data = null) {
    const g = gridSize;
    const size = g * g * g * 4;
    const buf = data instanceof Uint8Array && data.length === size
        ? data
        : new Uint8Array(size);
    tex.image = { data: buf, width: g, height: g, depth: g };
    tex.needsUpdate = true;
    return buf;
}

export function applyFluidVolumeUniforms(mat, mesh, {
    stepLength = 0.025,
    densityScale = 1,
    opacity = 1,
    colorTint = [1, 1, 1],
    gridSize = 64,
} = {}) {
    if (!mat || !mesh) return;
    mat.uniforms.stepLength.value = stepLength;
    mat.uniforms.densityScale.value = densityScale;
    mat.uniforms.opacity.value = opacity;
    mat.uniforms.gridSize.value = gridSize;
    mat.uniforms.colorTint.value.set(colorTint[0], colorTint[1], colorTint[2]);
    mesh.updateMatrixWorld(true);
    mat.uniforms.modelMatrixInverse.value.copy(mesh.matrixWorld).invert();
}

export function applyFluidVolumeTransform(mesh, wire, { boundsHalf = [0.5, 0.5, 0.5], volumeCenter = [0, 0.5, 0] } = {}) {
    if (!mesh) return;
    const [hx, hy, hz] = boundsHalf;
    mesh.scale.set(Math.max(hx, 0.05) * 2, Math.max(hy, 0.05) * 2, Math.max(hz, 0.05) * 2);
    mesh.position.set(volumeCenter[0], volumeCenter[1], volumeCenter[2]);
    if (wire) {
        wire.scale.copy(mesh.scale);
        wire.position.copy(mesh.position);
    }
}
