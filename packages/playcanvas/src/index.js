/**
 * @khudiiash/particles-playcanvas
 *
 * Plays a `@khudiiash/particles-core` effect config inside a PlayCanvas
 * application on the WebGPU backend. The simulation runs as a WebGPU compute
 * pass on PlayCanvas's own `GPUDevice` (`graphicsDevice.wgpu`); particles are
 * drawn from the shared GPU storage buffer with the canonical PlayCanvas WGSL
 * material — no CPU readback for rendering.
 *
 * Supports the full canonical feature set: disc / sphere / cube / cylinder /
 * cone shapes, scene lighting (directional + omni + spot), and cast + receive
 * shadows (the material compiles a shadow-pass variant and samples scene shadow
 * maps).
 *
 * Requires PlayCanvas Engine v2 with a WebGPU device (DEVICETYPE_WEBGPU).
 *
 * Usage:
 *   import * as pc from 'playcanvas';
 *   import { ParticleSystem } from '@khudiiash/particles-playcanvas';
 *   const ps = await ParticleSystem.create(app, effectConfig, { camera });
 *   app.on('update', (dt) => ps.update(dt));
 */
import * as pc from "playcanvas";
import {
	ParticleSimulation,
	PARTICLE_BYTES,
	resolveEffect,
	mergeRender,
	mergePath,
	packPathBuffer,
} from "@khudiiash/particles-core";
import { getParticleIndices, particleShapeIndex } from "./shapes.js";
import {
	applySceneLighting,
	installDrawTimeShadowSync,
	bindFallbackShadowMaps,
} from "./lighting.js";
import { applyRotationRenderUniforms, applyColorRenderUniforms } from "./render-uniforms.js";

const FRAME_DT_CLAMP = 1 / 60;

const BLEND_BY_ID = {
	additiveAlpha: pc.BLEND_ADDITIVEALPHA,
	additive: pc.BLEND_ADDITIVE,
	normal: pc.BLEND_NORMAL,
	premultiplied: pc.BLEND_PREMULTIPLIED,
	multiply: pc.BLEND_MULTIPLICATIVE,
	screen: pc.BLEND_SCREEN ?? pc.BLEND_ADDITIVEALPHA,
};

function motionModeIndex(mode) {
	if (mode === "spline") return 1;
	if (mode === "boids") return 2;
	if (mode === "hair") return 3;
	if (mode === "fluid") return 4;
	return 0;
}

const FALLBACK_COLOR_MAP_CACHE = new WeakMap();

function getFallbackColorMap(device) {
	if (!FALLBACK_COLOR_MAP_CACHE.has(device)) {
		const tex = new pc.Texture(device, {
			width: 1,
			height: 1,
			format: pc.PIXELFORMAT_RGBA8,
			mipmaps: false,
		});
		if (typeof document !== "undefined") {
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = 1;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#ffffff";
			ctx.fillRect(0, 0, 1, 1);
			tex.setSource(canvas);
			// Upload immediately so the engine never lazily uploads it mid-render-pass
			// (WebGPU forbids texture uploads inside an active pass).
			tex.upload?.();
		}
		FALLBACK_COLOR_MAP_CACHE.set(device, tex);
	}
	return FALLBACK_COLOR_MAP_CACHE.get(device);
}

function bindColorMapParameters(material, texture) {
	material.setParameter("colorMap", texture);
	material.setParameter("colorMapSampler", texture);
}

function shadowBoundsHalfExtents(params = {}) {
	const size = params.boundsSize ?? 1;
	const bx = params.boundsWidth ?? params.boundsHalfX ?? size;
	const by = params.boundsHeight ?? params.boundsHalfY ?? size;
	const bz = params.boundsDepth ?? params.boundsHalfZ ?? size;
	const br = params.boundsRadius ?? size;
	const boundsSize = Math.max(bx, by, bz, br, 0.1);
	const spawnRadius = Math.max(params.spawnRadius ?? 0, 0);
	const h = Math.max(boundsSize, spawnRadius, 1) + 0.5;
	return new pc.Vec3(h, h + 3, h);
}

function getWgpuDevice(device) {
	return device.gpuDevice || device._gpuDevice || device.wgpu?.device || device.wgpu || null;
}

const _sortCamPos = new pc.Vec3();
const _sortPartPos = new pc.Vec3();

function buildDrawOrderFromParticles(f32, count, camPos) {
	const alive = [];
	const dead = [];
	for (let i = 0; i < count; i++) {
		const o = i * 16;
		const life = f32[o + 3];
		if (life > 0) {
			_sortPartPos.set(f32[o], f32[o + 1], f32[o + 2]);
			alive.push({ index: i, dist: _sortPartPos.distance(camPos) });
		} else {
			dead.push(i);
		}
	}
	alive.sort((a, b) => b.dist - a.dist);
	const order = new Uint32Array(count);
	let slot = 0;
	for (const item of alive) order[slot++] = item.index;
	for (const index of dead) order[slot++] = index;
	for (let i = slot; i < count; i++) order[i] = i;
	return order;
}

export class ParticleSystem {
	/**
	 * @param {pc.AppBase} app
	 * @param {object} config effect config (raw or resolved)
	 * @param {object} [opts]
	 * @param {pc.Entity} [opts.camera] camera entity (for depth-sort + directional shadow selection)
	 * @param {pc.Entity} [opts.parent] entity to parent the particle render to
	 * @param {pc.Vec3|{x:number,y:number,z:number}} [opts.position] emitter world position
	 */
	static async create(app, config, opts = {}) {
		const system = new ParticleSystem(app, config, opts);
		await system.init();
		return system;
	}

	constructor(app, config, opts = {}) {
		this.app = app;
		this.device = app.graphicsDevice;
		this.gpu = getWgpuDevice(this.device);
		if (!this.gpu) {
			throw new Error(
				"@khudiiash/particles-playcanvas requires a WebGPU graphics device (DEVICETYPE_WEBGPU)",
			);
		}
		this._rawConfig = config;
		this.camera = opts.camera || null;
		this.parent = opts.parent || app.root;
		this._position = new pc.Vec3();
		if (opts.position) {
			this._position.set(opts.position.x ?? 0, opts.position.y ?? 0, opts.position.z ?? 0);
		}
		this.config = null;
		this.sim = null;
		this.entity = null;
		this.material = null;
		this.meshInstance = null;
		this.storageBuffer = null;
		this._pathBuffer = null;
		this._drawOrderBuffer = null;
		this._drawOrderData = null;
		this._sortReadback = null;
		this._sortReadbackPending = false;
		this._shadowMapFloat = false;
		this._sceneLightCount = 0;
		this._shadowBuffers = [];
		this._meshShape = "disc";
		this._colorMapLoaded = false;
		this._shadowAabb = new pc.BoundingBox();
		this._playing = true;
		this._disposed = false;
	}

	async init() {
		this.config = resolveEffect(this._rawConfig);
		const params = this.config.params || (this.config.params = {});
		if (this._positionSet()) {
			// Caller chose a spawn position: drive the sim emitter there too so the
			// particles (and their shadows) actually originate at that point.
			params.emitterX = this._position.x;
			params.emitterY = this._position.y;
			params.emitterZ = this._position.z;
		} else {
			this._position.set(params.emitterX ?? 0, params.emitterY ?? 0, params.emitterZ ?? 0);
		}
		this.sim = new ParticleSimulation(this.gpu, this.config);
		await this.sim.init();
		this._buildRender();
		return this;
	}

	_positionSet() {
		return this._position.x !== 0 || this._position.y !== 0 || this._position.z !== 0;
	}

	_buildRender() {
		const count = this.config.maxParticles;
		const render = mergeRender(this.config.render);
		this.config.render = render;
		const r = this.config.render;
		const shared = r.wgslShared || "";

		this.storageBuffer = new pc.StorageBuffer(
			this.device,
			count * PARTICLE_BYTES,
			pc.BUFFERUSAGE_COPY_DST | pc.BUFFERUSAGE_STORAGE,
		);

		this._pathBuffer = new pc.StorageBuffer(this.device, 256, pc.BUFFERUSAGE_COPY_DST);
		this._uploadPath();

		this._initDrawOrder(count);

		const material = new pc.ShaderMaterial({
			uniqueName: `ParticlesCore_${this.config.name || "effect"}`,
			vertexWGSL: shared + r.vertexWgsl,
			fragmentWGSL: shared + r.fragmentWgsl,
		});
		this.material = material;
		material.setParameter("particles", this.storageBuffer);
		material.setParameter("pathData", this._pathBuffer);
		material.setParameter("drawOrder", this._drawOrderBuffer);
		this._fallbackColorMap = getFallbackColorMap(this.device);
		bindColorMapParameters(material, this._fallbackColorMap);
		// The shader declares a scene-depth texture (used only for soft-particle
		// fading); bind a pre-uploaded fallback so the engine doesn't substitute
		// and lazily upload its built-in white texture during the render pass.
		material.setParameter("uSceneDepthMap", this._fallbackColorMap);
		material.setParameter("uSceneDepthMapSampler", this._fallbackColorMap);
		bindFallbackShadowMaps(material, this.device, this._shadowMapFloat);
		material.cull = pc.CULLFACE_NONE;
		material.depthWrite = !!r.depthWrite;
		material.depthTest = r.depthTest !== false;
		this._applyViewportUniforms(material);
		this._applyRenderUniforms(material);
		material.update();

		const shapeId = r.particleShape || "disc";
		this._meshShape = shapeId;
		const mesh = new pc.Mesh(this.device);
		mesh.setIndices(getParticleIndices(count, shapeId));
		mesh.update();
		mesh.aabb = new pc.BoundingBox(new pc.Vec3(), new pc.Vec3(1e4, 1e4, 1e4));

		const instance = new pc.MeshInstance(mesh, material);
		instance.cull = false;
		this.meshInstance = instance;

		this.entity = new pc.Entity(`ParticlesCore_${this.config.name || "effect"}`);
		this.entity.addComponent("render", {
			meshInstances: [instance],
			layers: [pc.LAYERID_WORLD],
			castShadows: !!r.castShadow,
			receiveShadows: !!r.receiveShadow,
		});
		this._layerIds = [...(this.entity.render?.layers ?? [pc.LAYERID_WORLD])];
		this._applyCastShadow(r);
		this._applyReceiveShadow(r);
		installDrawTimeShadowSync(this, instance);
		this.parent.addChild(this.entity);

		this._loadColorMap(r.colorMap);

		this._onPreRender = this._onPreRender.bind(this);
		this.app.scene.on("prerender", this._onPreRender);

		this._updateShadowBounds();
		this._registerShadowCaster();
	}

	_uploadPath() {
		if (!this._pathBuffer?.write) return;
		const path = mergePath(this.config.path, this.config.params);
		const packed = new Uint8Array(packPathBuffer(path));
		this._pathBuffer.write(0, packed);
	}

	_initDrawOrder(count) {
		this._drawOrderData = new Uint32Array(count);
		for (let i = 0; i < count; i++) this._drawOrderData[i] = i;
		this._drawOrderBuffer = new pc.StorageBuffer(this.device, count * 4, pc.BUFFERUSAGE_COPY_DST);
		this._uploadDrawOrder();

		if (this.gpu) {
			this._sortReadback = this.gpu.createBuffer({
				label: "ParticlesCoreSortReadback",
				size: count * PARTICLE_BYTES,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
			});
		}
	}

	_uploadDrawOrder() {
		if (this._drawOrderBuffer?.write && this._drawOrderData) {
			const packed = new Uint8Array(
				this._drawOrderData.buffer,
				this._drawOrderData.byteOffset,
				this._drawOrderData.byteLength,
			);
			this._drawOrderBuffer.write(0, packed);
		}
	}

	_viewportMetrics() {
		const canvas = this.device.canvas;
		const w = canvas?.clientWidth || this.device.width;
		const h = canvas?.clientHeight || this.device.height;
		const dpr = Math.min(this.device.maxPixelRatio || 1, 2);
		const pixelW = w * dpr;
		const pixelH = h * dpr;
		return { pixelW, pixelH, particlePixelScale: pixelH * 0.5 };
	}

	_applyViewportUniforms(material) {
		const { pixelW, pixelH, particlePixelScale } = this._viewportMetrics();
		material.setParameter("particlePixelScale", particlePixelScale);
		material.setParameter("viewportSize", [pixelW, pixelH]);
		material.setParameter("screenViewportSize", [pixelW, pixelH]);
	}

	_applyShapeUniforms(material) {
		const r = this.config.render || {};
		const shapeId = r.particleShape || "disc";
		material.setParameter("particleShape", particleShapeIndex(shapeId));
		material.setParameter("shapeSize", [r.shapeWidth ?? 1, r.shapeHeight ?? 1, r.shapeDepth ?? 1]);
		this._updateMeshShape(shapeId);
	}

	_updateMeshShape(shapeId = "disc") {
		if (!this.meshInstance || this._meshShape === shapeId) return;
		this._meshShape = shapeId;
		const count = this.config.maxParticles;
		this.meshInstance.mesh.setIndices(getParticleIndices(count, shapeId));
		this.meshInstance.mesh.update();
	}

	_applyRenderUniforms(material, camera = null) {
		const params = this.config.params || {};
		const r = this.config.render || {};

		material.setParameter("motionMode", motionModeIndex(params.motionMode));
		material.setParameter("emitterPos", [this._position.x, this._position.y, this._position.z]);
		material.setParameter("hairLength", params.hairLength ?? 0.6);
		material.setParameter("hairGrowth", params.hairGrowth ?? 0.65);
		material.setParameter("hairRandomTilt", params.hairRandomTilt ?? 0.35);
		applyRotationRenderUniforms(material, this.config.curves);
		applyColorRenderUniforms(material, this.config.curves);
		material.setParameter("stretchAlongMotion", r.stretchAlongMotion ?? 0);
		material.setParameter("depthSoftness", r.depthSoftness ?? 0);
		// Force the shader's per-fragment sphere-cap depth OFF. That path writes
		// output.fragDepth = clipDepth - cap*0.02, but the 0.02 bias lives in
		// non-linear NDC space: at typical camera distances it shifts a particle
		// many world units toward the camera, so it wins the depth test against
		// geometry it is actually behind (renders "on top of everything"). It also
		// disables early-Z. The rasterizer's planar billboard depth plus
		// material.depthWrite / material.depthTest give correct in-world depth.
		material.setParameter("depthWrite", 0);
		material.setParameter("useSceneDepth", 0);
		this._applyShapeUniforms(material);
		material.setParameter("useLighting", r.useLighting ? 1 : 0);
		const lightIntensity = r.useLighting
			? (r.lightIntensity > 0 ? r.lightIntensity : 1)
			: (r.lightIntensity ?? 0);
		material.setParameter("lightIntensity", lightIntensity);
		material.setParameter("colorMapMix", r.colorMapMix ?? 1);
		material.setParameter("useColorMap", this._colorMapLoaded ? 1 : 0);
		material.setParameter("alphaCutoff", r.alphaCutoff ?? 0.05);

		// Depth state is driven straight from the config (matches the editor /
		// Photon reference): keep a real blend mode, write depth when `depthWrite`
		// is set, and test depth unless `depthTest` is explicitly disabled. This
		// is what makes particles render in the world (occluded by scene geometry)
		// instead of on top of everything.
		const blendType = this._colorMapLoaded
			? pc.BLEND_NORMAL
			: (BLEND_BY_ID[r.blendMode] ?? pc.BLEND_NORMAL);
		const depthWrite = !!r.depthWrite;
		const depthTest = r.depthTest !== false;

		let needsUpdate = false;
		if (material.blendType !== blendType) {
			material.blendType = blendType;
			needsUpdate = true;
		}
		if (material.depthWrite !== depthWrite) {
			material.depthWrite = depthWrite;
			needsUpdate = true;
		}
		if (material.depthTest !== depthTest) {
			material.depthTest = depthTest;
			needsUpdate = true;
		}

		this._sceneLightCount = 0;
		this._shadowBuffers = [];
		if (r.useLighting || r.receiveShadow) {
			const lighting = applySceneLighting(
				material,
				this.app,
				this.meshInstance?.mask ?? pc.MASK_AFFECT_DYNAMIC,
				this._layerIds,
				{ useLighting: !!r.useLighting, receiveShadow: !!r.receiveShadow, camera },
			);
			this._sceneLightCount = lighting.count;
			this._shadowBuffers = lighting.shadowBuffers;
			this._updateShadowShaderMode(!!lighting.shadowMapUsesFloat);
		} else {
			applySceneLighting(material, this.app, pc.MASK_AFFECT_DYNAMIC, this._layerIds, {
				useLighting: false,
				receiveShadow: false,
				camera,
			});
			this._updateShadowShaderMode(false);
		}

		this._applyCastShadow(r);
		this._applyReceiveShadow(r);
		if (needsUpdate) material.update();
	}

	_updateShadowShaderMode(useFloat) {
		if (!this.material || useFloat === this._shadowMapFloat) return;
		this._shadowMapFloat = useFloat;
		this.material.setDefine("SHADOW_MAP_FLOAT", useFloat ? "" : false);
		bindFallbackShadowMaps(this.material, this.device, useFloat);
		this.material.update();
	}

	_applyCastShadow(render = this.config.render || {}) {
		const cast = !!render.castShadow;
		if (this.meshInstance && this.meshInstance.castShadow !== cast) {
			this.meshInstance.castShadow = cast;
		}
		const renderComp = this.entity?.render;
		if (renderComp && renderComp.castShadows !== cast) renderComp.castShadows = cast;
		if (cast) {
			this._updateShadowBounds();
			this._registerShadowCaster();
		} else if (this.meshInstance) {
			this.meshInstance.setCustomAabb(null);
		}
	}

	_applyReceiveShadow(render = this.config.render || {}) {
		const receive = !!render.receiveShadow;
		if (this.meshInstance && this.meshInstance.receiveShadow !== receive) {
			this.meshInstance.receiveShadow = receive;
		}
		const renderComp = this.entity?.render;
		if (renderComp && renderComp.receiveShadows !== receive) renderComp.receiveShadows = receive;
	}

	_updateShadowBounds() {
		const render = this.config.render || {};
		if (!render.castShadow || !this.meshInstance) return;
		const half = shadowBoundsHalfExtents(this.config.params);
		this._shadowAabb.center.copy(this._position);
		this._shadowAabb.halfExtents.copy(half);
		this.meshInstance.setCustomAabb(this._shadowAabb);
	}

	_registerShadowCaster() {
		if (!this.config.render?.castShadow || !this.meshInstance) return;
		const renderComp = this.entity?.render;
		if (!renderComp) return;
		const layers = this.app.scene.layers;
		for (const layerId of renderComp.layers) {
			layers.getLayerById(layerId)?.addShadowCasters([this.meshInstance]);
		}
	}

	_loadColorMap(relativeUrl) {
		this._colorMapLoaded = false;
		this.material?.setParameter("useColorMap", 0);
		bindColorMapParameters(this.material, this._fallbackColorMap);
		const url = (relativeUrl || "").trim();
		if (!url) return;

		const img = new Image();
		img.crossOrigin = "anonymous";
		img.onload = () => {
			if (this._disposed) return;
			const tex = new pc.Texture(this.device, {
				width: img.width,
				height: img.height,
				format: pc.PIXELFORMAT_RGBA8,
				mipmaps: false,
			});
			tex.minFilter = pc.FILTER_LINEAR;
			tex.magFilter = pc.FILTER_LINEAR;
			tex.addressU = pc.ADDRESS_CLAMP_TO_EDGE;
			tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
			tex.setSource(img);
			if (tex.upload) tex.upload();
			bindColorMapParameters(this.material, tex);
			this._colorMapTexture = tex;
			this._colorMapLoaded = true;
			this._applyRenderUniforms(this.material);
			this.material.update();
		};
		img.onerror = () => {
			console.warn(`[particles-playcanvas] color map failed: ${url}`);
		};
		img.src = url;
	}

	_onPreRender(cameraComp) {
		if (this._disposed || !this.material) return;
		const r = this.config.render || {};
		this._applyViewportUniforms(this.material);
		if (r.receiveShadow || r.useLighting || r.castShadow) {
			bindFallbackShadowMaps(this.material, this.device, this._shadowMapFloat);
			this._applyRenderUniforms(this.material, cameraComp);
		}
	}

	play() {
		this._playing = true;
	}

	pause() {
		this._playing = false;
	}

	reset() {
		this.sim?.reset();
	}

	/** Advance the simulation and mirror its buffer to the render buffer. Call once per frame. */
	update(dt) {
		if (this._disposed || !this._playing || !this.sim) return;
		const clamped = Math.min(dt > 0 ? dt : 1 / 60, FRAME_DT_CLAMP);
		this.sim.step(clamped);
		this._copyToStorage();
		this._uploadPath();
		this._applyViewportUniforms(this.material);
		this._applyRenderUniforms(this.material, this.camera?.camera || null);
		this._requestDepthSort();
	}

	/** Resolve a GraphNode with getPosition() from the camera entity / component / scene. */
	_cameraNode() {
		const cam = this.camera || this.app.scene.activeCamera;
		if (!cam) return null;
		if (typeof cam.getPosition === "function") return cam;
		if (cam.entity?.getPosition) return cam.entity;
		if (cam._node?.getPosition) return cam._node;
		return null;
	}

	_copyToStorage() {
		const dst = this.storageBuffer?.impl?.buffer;
		const src = this.sim.particleBuffer;
		if (!dst || !src) return;
		const enc = this.gpu.createCommandEncoder();
		enc.copyBufferToBuffer(src, 0, dst, 0, this.config.maxParticles * PARTICLE_BYTES);
		this.gpu.queue.submit([enc.finish()]);
	}

	_requestDepthSort() {
		const r = this.config.render || {};
		const needsSort = r.depthSort || (r.depthWrite && !this._colorMapLoaded);
		if (!needsSort || this._disposed || this._sortReadbackPending) return;
		const src = this.sim.particleBuffer;
		if (!src || !this._sortReadback) return;

		const count = this.config.maxParticles;
		this._sortReadbackPending = true;
		const encoder = this.gpu.createCommandEncoder();
		encoder.copyBufferToBuffer(src, 0, this._sortReadback, 0, count * PARTICLE_BYTES);
		this.gpu.queue.submit([encoder.finish()]);

		this._sortReadback.mapAsync(GPUMapMode.READ).then(() => {
			if (this._disposed) return;
			try {
				const mapped = this._sortReadback.getMappedRange();
				const f32 = new Float32Array(mapped.slice(0));
				this._sortReadback.unmap();
				const camNode = this._cameraNode();
				if (camNode) {
					camNode.getPosition(_sortCamPos);
					this._drawOrderData = buildDrawOrderFromParticles(f32, count, _sortCamPos);
					this._uploadDrawOrder();
				}
			} catch (err) {
				console.warn("[particles-playcanvas] depth sort readback failed:", err);
			} finally {
				this._sortReadbackPending = false;
			}
		}).catch((err) => {
			this._sortReadbackPending = false;
			console.warn("[particles-playcanvas] depth sort map failed:", err);
		});
	}

	async setConfig(config) {
		this.config = resolveEffect(config);
		this.config.render = mergeRender(this.config.render);
		await this.sim.setConfig(this.config);
		this._uploadPath();
		this._applyRenderUniforms(this.material);
		this.material.update();
	}

	dispose() {
		this._disposed = true;
		this.app.scene.off("prerender", this._onPreRender);
		this.entity?.destroy();
		this.entity = null;
		this.storageBuffer?.destroy?.();
		this.storageBuffer = null;
		this._pathBuffer?.destroy?.();
		this._drawOrderBuffer?.destroy?.();
		this._sortReadback?.destroy?.();
		this.sim?.dispose(true);
		this.sim = null;
	}
}

export { PARTICLE_BYTES };
