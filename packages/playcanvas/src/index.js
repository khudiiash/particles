/**
 * @khudiiash/particles-playcanvas
 *
 * Plays a `@khudiiash/particles-core` effect config inside a PlayCanvas
 * application using the WebGPU backend. The simulation runs as a WebGPU compute
 * pass on PlayCanvas's own `GPUDevice` (`graphicsDevice.wgpu`); particles are
 * drawn from the shared GPU storage buffer with a PlayCanvas WGSL material — no
 * CPU readback.
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
} from "@khudiiash/particles-core";
import { particleVertexWgsl, particleFragmentWgsl } from "./render-wgsl.js";

const FRAME_DT_CLAMP = 1 / 60;

export class ParticleSystem {
	/**
	 * @param {pc.AppBase} app
	 * @param {object} config effect config (raw or resolved)
	 * @param {object} [opts]
	 * @param {pc.Entity} [opts.camera] camera entity (defaults to first scene camera)
	 * @param {pc.Entity} [opts.parent] entity to parent the particle render to
	 */
	static async create(app, config, opts = {}) {
		const system = new ParticleSystem(app, config, opts);
		await system.init();
		return system;
	}

	constructor(app, config, opts = {}) {
		this.app = app;
		this.device = app.graphicsDevice;
		this.gpu = this.device.wgpu;
		if (!this.gpu) {
			throw new Error(
				"@khudiiash/particles-playcanvas requires a WebGPU graphics device (DEVICETYPE_WEBGPU)",
			);
		}
		this._rawConfig = config;
		this.camera = opts.camera || null;
		this.parent = opts.parent || app.root;
		this.config = null;
		this.sim = null;
		this.entity = null;
		this.storageBuffer = null;
		this._playing = true;
		this._disposed = false;
	}

	async init() {
		this.config = resolveEffect(this._rawConfig);
		this.sim = new ParticleSimulation(this.gpu, this.config);
		await this.sim.init();
		this._buildRender();
		return this;
	}

	_buildRender() {
		const pcLib = pc;
		const count = this.config.maxParticles;
		const render = mergeRender(this.config.render);

		// PlayCanvas-managed storage buffer that the material reads from; we copy
		// the simulation output into it each frame (GPU -> GPU).
		this.storageBuffer = new pcLib.StorageBuffer(
			this.device,
			count * PARTICLE_BYTES,
			pcLib.BUFFERUSAGE_COPY_DST | pcLib.BUFFERUSAGE_STORAGE,
		);

		const shader = pcLib.ShaderMaterial
			? new pcLib.ShaderMaterial({
					uniqueName: "particles-core",
					vertexGLSL: undefined,
					fragmentGLSL: undefined,
					vertexWGSL: particleVertexWgsl(),
					fragmentWGSL: particleFragmentWgsl(),
					attributes: {},
			  })
			: new pcLib.Material();

		shader.cull = pcLib.CULLFACE_NONE;
		shader.blendType = blendType(pcLib, render.blendMode);
		shader.depthWrite = !!render.depthWrite;
		shader.depthTest = true;
		shader.setParameter("particles", this.storageBuffer);
		shader.setParameter("uSizeScale", 1);
		shader.setParameter("uAlphaCutoff", render.alphaCutoff ?? 0.05);
		shader.update();
		this.material = shader;

		// A vertex-only mesh: 6 verts per particle, no vertex buffers (the shader
		// reads everything from the storage buffer via vertex_index).
		const mesh = new pcLib.Mesh(this.device);
		mesh.vertexBuffer = null;
		mesh.primitive[0] = {
			type: pcLib.PRIMITIVE_TRIANGLES,
			base: 0,
			count: count * 6,
			indexed: false,
		};
		mesh.aabb = new pcLib.BoundingBox(new pcLib.Vec3(), new pcLib.Vec3(1e4, 1e4, 1e4));

		const node = new pcLib.GraphNode();
		const instance = new pcLib.MeshInstance(mesh, shader, node);
		instance.cull = false;

		this.entity = new pcLib.Entity("particles-core");
		this.entity.addComponent("render", { meshInstances: [instance] });
		this.parent.addChild(this.entity);
		this.meshInstance = instance;
	}

	_updateMatrices() {
		const cam = this.camera || this.app.root.findComponent("camera")?.entity;
		if (!cam) return;
		const camComp = cam.camera;
		if (!camComp) return;
		const vp = camComp.viewProjectionMatrix || camComp._viewProjMat;
		const view = camComp.viewMatrix || camComp._viewMat;
		if (vp) this.material.setParameter("matrix_viewProjection", vp.data);
		if (view) this.material.setParameter("matrix_view", view.data);
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

	/** Advance the simulation and mirror the buffer. Call once per frame. */
	update(dt) {
		if (this._disposed || !this._playing || !this.sim) return;
		const clamped = Math.min(dt > 0 ? dt : 1 / 60, FRAME_DT_CLAMP);
		this.sim.step(clamped);
		this._copyToStorage();
		this._updateMatrices();
	}

	_copyToStorage() {
		const dst = this.storageBuffer?.impl?.buffer;
		if (!dst) return;
		const enc = this.gpu.createCommandEncoder();
		enc.copyBufferToBuffer(
			this.sim.particleBuffer,
			0,
			dst,
			0,
			this.config.maxParticles * PARTICLE_BYTES,
		);
		this.gpu.queue.submit([enc.finish()]);
	}

	async setConfig(config) {
		this.config = resolveEffect(config);
		await this.sim.setConfig(this.config);
	}

	dispose() {
		this._disposed = true;
		this.entity?.destroy();
		this.entity = null;
		this.storageBuffer?.destroy?.();
		this.storageBuffer = null;
		this.sim?.dispose(true);
		this.sim = null;
	}
}

function blendType(pcLib, mode) {
	switch (mode) {
		case "additive":
		case "additiveAlpha":
		case "screen":
			return pcLib.BLEND_ADDITIVEALPHA ?? pcLib.BLEND_ADDITIVE;
		case "multiply":
			return pcLib.BLEND_MULTIPLICATIVE;
		case "premultiplied":
			return pcLib.BLEND_PREMULTIPLIED;
		default:
			return pcLib.BLEND_NORMAL;
	}
}

export { PARTICLE_BYTES };
