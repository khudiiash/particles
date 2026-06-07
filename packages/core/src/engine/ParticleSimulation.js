/**
 * Headless WebGPU particle compute runner.
 *
 * Owns the particle storage buffer, simulation uniform buffer, path buffer and
 * compute pipelines. It is device-agnostic: pass in any `GPUDevice` (e.g. the
 * one created by a three.js `WebGPURenderer` or a PlayCanvas graphics device) so
 * the resulting `particleBuffer` can be rendered directly with no CPU readback.
 *
 * The engine handles the particle motion modes (velocity / spline / boids /
 * hair, plus the MPM passes baked into the canonical sim shader). The grid
 * volume "fluid" mode is editor-preview only and is not run here.
 */
import { PARTICLE_STRIDE_FLOATS } from "../layout.js";
import {
	SIM_UNIFORM_BYTES,
	mergeParams,
	mergeCurves,
	packSimUniforms,
} from "../curves.js";
import {
	PATH_BUFFER_BYTES,
	mergePath,
	normalizePathAnchor,
	packPathBuffer,
} from "../path.js";
import {
	createMpmBuffers,
	setupMpmGpu,
	calcDispatch,
} from "../mpm-gpu.js";

export const PARTICLE_BYTES = PARTICLE_STRIDE_FLOATS * 4;

export class ParticleSimulation {
	/**
	 * @param {GPUDevice} device
	 * @param {object} config resolved effect config (must include simulation.wgsl)
	 */
	constructor(device, config) {
		if (!device) throw new Error("ParticleSimulation requires a GPUDevice");
		this.device = device;
		this.config = null;
		this.time = 0;
		this._gpu = null;
		this._destroyed = false;
		if (config) this._pendingConfig = config;
	}

	get particleBuffer() {
		return this._gpu?.particleBuffer ?? null;
	}

	get maxParticles() {
		return this.config?.maxParticles ?? 0;
	}

	/** Build GPU resources for the current (or pending) config. */
	async init(config = this._pendingConfig) {
		if (!config) throw new Error("ParticleSimulation.init needs a config");
		if (!config.simulation?.wgsl) {
			throw new Error(
				"config.simulation.wgsl missing — call applyCanonicalShaders(config) first",
			);
		}
		this.config = normalizeConfig(config);
		await this._build();
		return this;
	}

	async _build() {
		const device = this.device;
		const cfg = this.config;
		const count = cfg.maxParticles;
		const gridSize = cfg.params?.fluidGridSize ?? 32;

		const particleBuffer = device.createBuffer({
			label: "particles",
			size: count * PARTICLE_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
		});
		const simUniformBuffer = device.createBuffer({
			label: "simUniforms",
			size: SIM_UNIFORM_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const pathBuffer = device.createBuffer({
			label: "path",
			size: PATH_BUFFER_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});

		const mpm = createMpmBuffers(device, count, gridSize);
		const mpmGpu = await setupMpmGpu(
			device,
			cfg,
			{ simUniformBuffer, particleBuffer, pathBuffer, ...mpm },
			SIM_UNIFORM_BYTES,
		);

		const dispatch = calcDispatch(count, cfg.workgroupSize || 64);
		this._gpu = {
			particleBuffer,
			simUniformBuffer,
			pathBuffer,
			dispatchX: dispatch.x,
			dispatchY: dispatch.y,
			...mpm,
			...mpmGpu,
		};
		this.reset();
	}

	/** Replace the config; rebuilds GPU resources only when the layout changes. */
	async setConfig(config) {
		const next = normalizeConfig(config);
		const prev = this.config;
		this.config = next;
		if (!this._gpu || needsRebuild(prev, next)) {
			this.dispose(/* keepDevice */ true);
			await this._build();
		}
	}

	/** Clear particles back to their unspawned state. */
	reset() {
		this.time = 0;
		if (this._gpu?.particleBuffer) {
			this.device.queue.writeBuffer(
				this._gpu.particleBuffer,
				0,
				new ArrayBuffer(this.maxParticles * PARTICLE_BYTES),
			);
		}
	}

	/**
	 * Advance the simulation by `dt` seconds and submit the compute pass.
	 * @param {number} dt seconds
	 * @param {object} [opts]
	 * @param {GPUCommandEncoder} [opts.encoder] reuse an external encoder instead of submitting
	 */
	step(dt, opts = {}) {
		if (this._destroyed || !this._gpu) return;
		const device = this.device;
		const cfg = this.config;
		const g = this._gpu;
		this.time += dt;

		const params = mergeParams(cfg.params);
		const curves = mergeCurves(cfg.curves);
		const root = [params.emitterX ?? 0, params.emitterY ?? 0, params.emitterZ ?? 0];
		const livePath = mergePath(cfg.path, params);
		const { path: gpuPath, emitterWorld } = normalizePathAnchor(livePath, root);

		device.queue.writeBuffer(
			g.simUniformBuffer,
			0,
			packSimUniforms({
				count: cfg.maxParticles,
				dt,
				time: this.time,
				emitterPos: emitterWorld,
				params,
				curves,
			}),
		);
		device.queue.writeBuffer(g.pathBuffer, 0, packPathBuffer(gpuPath));

		const enc = opts.encoder || device.createCommandEncoder();
		const pass = enc.beginComputePass({ label: "updateParticles" });
		pass.setPipeline(g.pipelines.updateParticles);
		pass.setBindGroup(0, g.bindGroup);
		pass.dispatchWorkgroups(g.dispatchX, g.dispatchY);
		pass.end();
		if (!opts.encoder) device.queue.submit([enc.finish()]);
	}

	/**
	 * Copy the particle buffer back to the CPU. Optional — the WebGPU render
	 * paths read `particleBuffer` directly on the GPU. Useful for WebGL fallbacks
	 * or debugging.
	 * @returns {Promise<Float32Array>}
	 */
	async readback() {
		if (!this._gpu) return new Float32Array(0);
		const device = this.device;
		const bytes = this.maxParticles * PARTICLE_BYTES;
		const staging = device.createBuffer({
			size: bytes,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
		});
		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer(this._gpu.particleBuffer, 0, staging, 0, bytes);
		device.queue.submit([enc.finish()]);
		await staging.mapAsync(GPUMapMode.READ);
		const data = new Float32Array(staging.getMappedRange().slice(0));
		staging.unmap();
		staging.destroy();
		return data;
	}

	dispose(keepDevice = false) {
		const g = this._gpu;
		if (g) {
			g.particleBuffer?.destroy();
			g.simUniformBuffer?.destroy();
			g.pathBuffer?.destroy();
			g.mpmC?.destroy();
			g.mpmCells?.destroy();
			g.mpmCellsFloat?.destroy();
		}
		this._gpu = null;
		if (!keepDevice) this._destroyed = true;
	}
}

function normalizeConfig(cfg) {
	return {
		...cfg,
		maxParticles: Math.max(1, cfg.maxParticles || 10000),
		workgroupSize: cfg.workgroupSize || 64,
		params: mergeParams(cfg.params),
		curves: mergeCurves(cfg.curves),
	};
}

function needsRebuild(prev, next) {
	if (!prev) return true;
	return (
		prev.maxParticles !== next.maxParticles ||
		(prev.workgroupSize || 64) !== (next.workgroupSize || 64) ||
		prev.simulation?.entryPoint !== next.simulation?.entryPoint ||
		prev.simulation?.wgsl !== next.simulation?.wgsl ||
		(prev.params?.fluidGridSize ?? 32) !== (next.params?.fluidGridSize ?? 32)
	);
}
