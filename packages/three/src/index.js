/**
 * @khudiiash/particles-three
 *
 * Plays a `@khudiiash/particles-core` effect config inside a three.js scene
 * using the WebGPU backend. The simulation runs as a compute pass on the
 * renderer's own `GPUDevice`, and particles are drawn straight from the GPU
 * storage buffer — there is no CPU readback.
 *
 * Usage:
 *   import * as THREE from 'three';
 *   import { WebGPURenderer } from 'three/webgpu';
 *   import { ParticleSystem } from '@khudiiash/particles-three';
 *
 *   const renderer = new WebGPURenderer({ antialias: true });
 *   await renderer.init();
 *   const ps = await ParticleSystem.create(effectConfig, { renderer, scene, camera });
 *   renderer.setAnimationLoop((t) => { ps.update(dt); renderer.render(scene, camera); });
 */
import * as THREE from "three";
import {
	ParticleSimulation,
	PARTICLE_BYTES,
	resolveEffect,
	mergeRender,
	PARTICLE_STRIDE_FLOATS,
} from "@khudiiash/particles-core";
import { buildParticleMesh } from "./mesh.js";

const FRAME_DT_CLAMP = 1 / 60;

export class ParticleSystem {
	/**
	 * Async factory — preferred entry point.
	 * @param {object} config effect config (raw or resolved)
	 * @param {object} opts
	 * @param {import('three').WebGPURenderer} opts.renderer initialized WebGPU renderer
	 * @param {import('three').Object3D} [opts.scene] object to add the particle mesh to
	 * @param {import('three').Camera} [opts.camera]
	 */
	static async create(config, opts) {
		const system = new ParticleSystem(config, opts);
		await system.init();
		return system;
	}

	constructor(config, { renderer, scene, camera } = {}) {
		if (!renderer) throw new Error("ParticleSystem requires a three.js WebGPURenderer");
		this.renderer = renderer;
		this.scene = scene || null;
		this.camera = camera || null;
		this._rawConfig = config;
		this.config = null;
		this.mesh = null;
		this.sim = null;
		this._lastTime = 0;
		this._playing = true;
		this._disposed = false;
	}

	async init() {
		const device = getDevice(this.renderer);
		if (!device) {
			throw new Error(
				"WebGPU device unavailable — call `await renderer.init()` before creating the ParticleSystem",
			);
		}
		this.config = resolveEffect(this._rawConfig);
		this.sim = new ParticleSimulation(device, this.config);
		await this.sim.init();

		this.mesh = buildParticleMesh({
			renderer: this.renderer,
			particleBuffer: this.sim.particleBuffer,
			maxParticles: this.config.maxParticles,
			render: mergeRender(this.config.render),
		});
		if (this.scene) this.scene.add(this.mesh);
		return this;
	}

	/** Swap to a new effect config at runtime. */
	async setConfig(config) {
		this.config = resolveEffect(config);
		await this.sim.setConfig(this.config);
		// Rebuild the mesh so it points at the (possibly new) particle buffer.
		if (this.mesh) {
			this.mesh.parent?.remove(this.mesh);
			this.mesh.geometry.dispose();
			this.mesh.material.dispose();
		}
		this.mesh = buildParticleMesh({
			renderer: this.renderer,
			particleBuffer: this.sim.particleBuffer,
			maxParticles: this.config.maxParticles,
			render: mergeRender(this.config.render),
		});
		if (this.scene) this.scene.add(this.mesh);
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

	/**
	 * Advance the simulation. Call once per frame before `renderer.render`.
	 * @param {number} [dt] seconds since last update; clamped to 1/60 for stability
	 */
	update(dt) {
		if (this._disposed || !this._playing || !this.sim) return;
		const clamped = Math.min(dt > 0 ? dt : 1 / 60, FRAME_DT_CLAMP);
		this.sim.step(clamped);
		this.mesh?.onSimStep?.();
	}

	dispose() {
		this._disposed = true;
		if (this.mesh) {
			this.mesh.parent?.remove(this.mesh);
			this.mesh.geometry.dispose();
			this.mesh.material.dispose();
			this.mesh = null;
		}
		this.sim?.dispose(true);
		this.sim = null;
	}
}

/** Resolve the underlying GPUDevice from a three WebGPURenderer across versions. */
function getDevice(renderer) {
	return (
		renderer?.backend?.device ||
		renderer?.backend?.data?.device ||
		renderer?._device ||
		null
	);
}

export { PARTICLE_BYTES, PARTICLE_STRIDE_FLOATS };
