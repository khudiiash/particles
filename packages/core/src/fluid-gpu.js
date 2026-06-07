import {
    buildFluidShaderCode,
    FLUID_UNIFORM_BYTES,
} from "./fluid-shaders.js";

export { fluidFrameDt, FLUID_DT_CLAMP } from "./mpm-gpu.js";

const COMPUTE_ENTRIES = [
    "fluidAdvect",
    "fluidDivergence",
    "fluidClearPressure",
    "fluidJacobi",
    "fluidSwapPressure",
    "fluidGradientSubtract",
    "fluidBuoyancy",
    "fluidEmit",
    "fluidRender",
];

export function fluidGridDim(size = 64) {
    const g = Math.round(Number(size) || 64);
    return Math.max(16, Math.min(192, g));
}

export function smokeGridByteSize(gridSize) {
    return fluidGridDim(gridSize) ** 3 * 16;
}

export function fluidDeviceLimits(gridSize = 64) {
    const g = fluidGridDim(gridSize);
    const cellCount = g ** 3;
    const minBuffer = cellCount * 16 * 4;
    return {
        maxStorageBufferBindingSize: Math.max(minBuffer * 8, 64 * 1024 * 1024),
        maxBufferSize: Math.max(minBuffer * 8, 64 * 1024 * 1024),
    };
}

export function packFluidUniforms(cfg) {
    const buf = new ArrayBuffer(FLUID_UNIFORM_BYTES);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    const g = fluidGridDim(cfg.gridSize);
    const rdx = g * (cfg.simulationScale ?? 4);
    const emitShape = cfg.emitShape ?? 1;

    u32[0] = g;
    f32[1] = cfg.dt ?? 0.016;
    f32[2] = cfg.time ?? 0;
    f32[3] = rdx;
    f32[4] = cfg.smokeDecay ?? 0.5;
    f32[5] = cfg.velocityDecay ?? 0.015;
    f32[6] = cfg.temperatureDecay ?? 1.0;
    f32[7] = cfg.buoyancy ?? 0.5;
    f32[8] = cfg.ignitionTemp ?? 400;
    f32[9] = cfg.burnRate ?? 0.8;
    f32[10] = cfg.burnHeat ?? 20000;
    f32[11] = cfg.burnSmoke ?? 1;
    u32[12] = cfg.enclosed ? 1 : 0;
    u32[13] = cfg.vorticityEnabled ? 1 : 0;
    f32[14] = cfg.vorticityAmount ?? 1;
    f32[15] = cfg.emitterStrength ?? 1;
    u32[16] = 0;
    f32[17] = cfg.brushSize ?? 0.12;
    f32[18] = cfg.brushSmoke ?? 3;
    f32[19] = cfg.brushTemp ?? 500;
    f32[20] = cfg.brushVel ?? 2;
    f32[21] = 0;
    f32[22] = 0;
    f32[23] = 0;
    f32[24] = 0;
    f32[25] = 0;
    f32[26] = 0;
    f32[27] = 1;
    f32[28] = 1;
    f32[29] = 0;
    f32[30] = 0;
    f32[31] = 2.5;
    f32[32] = cfg.camSpin ?? 0;
    f32[33] = cfg.stepLength ?? 0.025;
    u32[34] = emitShape;
    f32[35] = cfg.emitPos?.[0] ?? 0;
    f32[36] = cfg.emitPos?.[1] ?? -0.42;
    f32[37] = cfg.emitPos?.[2] ?? 0;
    f32[38] = cfg.emitRadius ?? 0.08;
    f32[39] = cfg.emitVel?.[0] ?? 0;
    f32[40] = cfg.emitVel?.[1] ?? 2.5;
    f32[41] = cfg.emitVel?.[2] ?? 0;
    const tint = cfg.colorTint ?? [0.72, 0.75, 0.78];
    f32[42] = tint[0];
    f32[43] = tint[1];
    f32[44] = tint[2];
    f32[45] = cfg.densityScale ?? 1;
    const noise = cfg.noise ?? {};
    u32[46] = Math.round(noise.noiseType ?? 0);
    f32[47] = noise.noiseFrequency ?? 1;
    f32[48] = noise.noiseAmplitude ?? 0;
    f32[49] = noise.noiseSpeed ?? 1;
    u32[50] = Math.round(noise.noiseOctaves ?? 1);
    f32[51] = noise.noiseSeed ?? 0;
    u32[52] = Math.round(noise.noiseTargets ?? 0);
    f32[53] = cfg.gravity ?? 0;
    f32[54] = 0;
    return buf;
}

function gridBufferSize(gridSize, floatsPerCell = 1) {
    return gridSize ** 3 * floatsPerCell * 4;
}

function createGridBuffer(device, label, gridSize, floatsPerCell, extraUsage = 0) {
    return device.createBuffer({
        label,
        size: gridBufferSize(gridSize, floatsPerCell),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | extraUsage,
    });
}

/**
 * Roquefort-style 3D grid fluid on the editor shared WebGPU device.
 * @see https://github.com/Bercon/roquefort
 */
export async function createFluidGpu(device, initialConfig = {}) {
    if (!device) throw new Error("FluidGpu requires a WebGPU device");
    const gpu = new FluidGpu(device);
    await gpu.init(initialConfig);
    return gpu;
}

export class FluidGpu {
    constructor(device) {
        this.device = device;
        this.gridSize = 64;
        this.buffers = null;
        this.pipelines = null;
        this.uniformBuffer = null;
        this.config = {};
        this.pressureIterations = 4;
        this.front = 0;
        this.outputView = null;
        this.readbackBuffers = [null, null];
        this.readbackWrite = 0;
        this.readbackMapping = [false, false];
        this.readbackPromises = [null, null];
        this.smokeReadbackBytes = 0;
        this.deferredGridSize = null;
    }

    async init(initialConfig = {}) {
        this.config = { ...initialConfig };
        this.gridSize = fluidGridDim(initialConfig.gridSize);
        this.pressureIterations = Math.max(2, Math.round(initialConfig.pressureIterations ?? 4));

        const module = this.device.createShaderModule({
            label: "fluid",
            code: buildFluidShaderCode(),
        });
        const info = await module.getCompilationInfo();
        for (const msg of info.messages) {
            if (msg.type === "error") throw new Error(`Fluid WGSL ${msg.lineNum}: ${msg.message}`);
        }

        const layout = this.device.createBindGroupLayout({
            label: "fluidBindLayout",
            entries: [
                ...Array.from({ length: 8 }, (_, i) => ({
                    binding: i,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: i === 0
                        ? { type: "uniform", minBindingSize: FLUID_UNIFORM_BYTES }
                        : { type: "storage" },
                })),
                {
                    binding: 8,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: { access: "write-only", format: "rgba8unorm", viewDimension: "2d" },
                },
            ],
        });
        this.bindGroupLayout = layout;

        const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [layout],
        });

        this.pipelines = {};
        for (const entry of COMPUTE_ENTRIES) {
            this.pipelines[entry] = await this.device.createComputePipelineAsync({
                layout: pipelineLayout,
                compute: { module, entryPoint: entry },
                label: entry,
            });
        }

        this.uniformBuffer = this.device.createBuffer({
            size: FLUID_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.dummyBuffers = {
            velIn: this.device.createBuffer({ label: "dummyVelIn", size: 256, usage: GPUBufferUsage.STORAGE }),
            velOut: this.device.createBuffer({ label: "dummyVelOut", size: 256, usage: GPUBufferUsage.STORAGE }),
            smokeIn: this.device.createBuffer({ label: "dummySmokeIn", size: 256, usage: GPUBufferUsage.STORAGE }),
            smokeOut: this.device.createBuffer({ label: "dummySmokeOut", size: 256, usage: GPUBufferUsage.STORAGE }),
        };

        const dummyTex = this.device.createTexture({
            label: "fluidDummyOutput",
            size: [1, 1],
            format: "rgba8unorm",
            usage: GPUTextureUsage.STORAGE_BINDING,
        });
        this.outputView = dummyTex.createView();

        this._applyGridResize(this.gridSize);
    }

    _destroyReadbackBuffers() {
        for (const buf of this.readbackBuffers) {
            try { buf?.unmap(); } catch { /* already unmapped */ }
            buf?.destroy();
        }
        this.readbackBuffers = [null, null];
        this.readbackMapping = [false, false];
        this.readbackPromises = [null, null];
        this.smokeReadbackBytes = 0;
        this.readbackWrite = 0;
    }

    _createReadbackBuffers(gridSize) {
        const size = smokeGridByteSize(gridSize);
        this.readbackBuffers = [0, 1].map((i) => this.device.createBuffer({
            label: `fluidSmokeReadback${i}`,
            size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }));
        this.smokeReadbackBytes = size;
        this.readbackWrite = 0;
        this.readbackMapping = [false, false];
        this.readbackPromises = [null, null];
    }

    _applyGridResize(gridSize) {
        this._destroyReadbackBuffers();
        this._destroyBuffers();
        this.gridSize = gridSize;
        const g = gridSize;
        const copySrc = GPUBufferUsage.COPY_SRC;
        this.buffers = {
            velocity: [
                createGridBuffer(this.device, "vel0", g, 4),
                createGridBuffer(this.device, "vel1", g, 4),
            ],
            smoke: [
                createGridBuffer(this.device, "smoke0", g, 4, copySrc),
                createGridBuffer(this.device, "smoke1", g, 4, copySrc),
            ],
            pressure: createGridBuffer(this.device, "pressure", g, 1),
            pressureTmp: createGridBuffer(this.device, "pressureTmp", g, 1),
            divergence: createGridBuffer(this.device, "divergence", g, 1),
        };
        this.front = 0;
        this._createReadbackBuffers(g);
        this.resetFields();
    }

    tryApplyDeferredResize() {
        if (this.deferredGridSize == null) return false;
        if (this.readbackMapping[0] || this.readbackMapping[1]) return false;
        const g = this.deferredGridSize;
        this.deferredGridSize = null;
        this._applyGridResize(g);
        return true;
    }

    isResizing() {
        return this.deferredGridSize != null;
    }

    _resolveFieldBindings(requestedIn, requestedOut, dummyIn, dummyOut) {
        if (requestedIn && !requestedOut) {
            return { in: requestedIn, out: dummyOut };
        }
        const out = requestedOut ?? dummyOut;
        const inp = (requestedIn && requestedIn !== out) ? requestedIn : dummyIn;
        return { in: inp, out };
    }

    _makeBindGroup({ velIn = null, smokeIn = null, velOut = null, smokeOut = null } = {}) {
        const dummy = this.dummyBuffers;
        const vel = this._resolveFieldBindings(velIn, velOut, dummy.velIn, dummy.velOut);
        const smoke = this._resolveFieldBindings(smokeIn, smokeOut, dummy.smokeIn, dummy.smokeOut);

        return this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.uniformBuffer } },
                { binding: 1, resource: { buffer: vel.in } },
                { binding: 2, resource: { buffer: smoke.in } },
                { binding: 3, resource: { buffer: vel.out } },
                { binding: 4, resource: { buffer: smoke.out } },
                { binding: 5, resource: { buffer: this.buffers.pressure } },
                { binding: 6, resource: { buffer: this.buffers.divergence } },
                { binding: 7, resource: { buffer: this.buffers.pressureTmp } },
                { binding: 8, resource: this.outputView },
            ],
        });
    }

    _destroyBuffers() {
        if (!this.buffers) return;
        for (const key of Object.keys(this.buffers)) {
            const val = this.buffers[key];
            if (Array.isArray(val)) val.forEach((b) => b.destroy());
            else val.destroy();
        }
        this.buffers = null;
    }

    applyConfig(next = {}) {
        const prevGrid = this.gridSize;
        const prevStructural = [
            this.config.emitShape,
            Math.round((this.config.emitRadius ?? 0) * 200),
            ...(this.config.emitPos ?? []).map((v) => Math.round(v * 200)),
        ].join(",");
        const prevBounds = this.config.boundsHalf?.join?.(",");
        Object.assign(this.config, next);
        const newGrid = fluidGridDim(this.config.gridSize ?? prevGrid);
        this.pressureIterations = Math.max(2, Math.round(this.config.pressureIterations ?? this.pressureIterations));
        const nextBounds = this.config.boundsHalf?.join?.(",");
        const nextStructural = [
            this.config.emitShape,
            Math.round((this.config.emitRadius ?? 0) * 200),
            ...(this.config.emitPos ?? []).map((v) => Math.round(v * 200)),
        ].join(",");
        if (newGrid !== prevGrid && this.device) {
            this.deferredGridSize = newGrid;
            this.tryApplyDeferredResize();
        } else if (nextStructural !== prevStructural || (nextBounds && nextBounds !== prevBounds)) {
            this.resetFields();
        }
    }

    resetFields() {
        if (!this.device || !this.buffers) return;
        const g = this.gridSize;
        const n = g ** 3 * 4;
        const zero = new Float32Array(n);
        for (const buf of this.buffers.smoke) {
            this.device.queue.writeBuffer(buf, 0, zero);
        }
        for (const buf of this.buffers.velocity) {
            this.device.queue.writeBuffer(buf, 0, zero);
        }
        for (const buf of [this.buffers.pressure, this.buffers.pressureTmp, this.buffers.divergence]) {
            this.device.queue.writeBuffer(buf, 0, new Float32Array(g ** 3));
        }
        this.front = 0;
    }

    pickReadbackIndex() {
        if (this.deferredGridSize != null) return -1;
        let idx = this.readbackWrite;
        if (this.readbackMapping[idx]) idx = 1 - idx;
        return this.readbackMapping[idx] ? -1 : idx;
    }

    step({ dt, time, config, readbackIndex = -1 }) {
        if (!this.device || !this.buffers) return;
        Object.assign(this.config, config ?? {});

        const simDt = Math.max(dt || 0, 1 / 120);
        this.device.queue.writeBuffer(this.uniformBuffer, 0, packFluidUniforms({
            ...this.config,
            gridSize: this.gridSize,
            dt: simDt,
            time,
        }));

        const g = this.gridSize;
        const wg = Math.ceil(g / 4);
        const enc = this.device.createCommandEncoder({ label: "fluidStep" });
        const src = this.front;
        const dst = 1 - this.front;
        const v = this.buffers.velocity;
        const s = this.buffers.smoke;

        this._dispatch(enc, "fluidAdvect", wg, wg, wg,
            this._makeBindGroup({ velIn: v[src], smokeIn: s[src], velOut: v[dst], smokeOut: s[dst] }));
        this._dispatch(enc, "fluidEmit", wg, wg, wg,
            this._makeBindGroup({ velOut: v[dst], smokeOut: s[dst] }));
        this._dispatch(enc, "fluidDivergence", wg, wg, wg,
            this._makeBindGroup({ velIn: v[dst] }));
        this._dispatch(enc, "fluidClearPressure", wg, wg, wg, this._makeBindGroup());
        for (let i = 0; i < this.pressureIterations; i++) {
            this._dispatch(enc, "fluidJacobi", wg, wg, wg, this._makeBindGroup());
            this._dispatch(enc, "fluidSwapPressure", wg, wg, wg, this._makeBindGroup());
        }
        this._dispatch(enc, "fluidGradientSubtract", wg, wg, wg,
            this._makeBindGroup({ velIn: v[dst], velOut: v[src] }));
        this._dispatch(enc, "fluidBuoyancy", wg, wg, wg,
            this._makeBindGroup({ velOut: v[src], smokeOut: s[dst] }));

        if (readbackIndex >= 0 && this.readbackBuffers[readbackIndex]) {
            enc.copyBufferToBuffer(
                s[dst], 0,
                this.readbackBuffers[readbackIndex], 0,
                this.smokeReadbackBytes,
            );
        }

        this.device.queue.submit([enc.finish()]);
        this.front = dst;
        if (readbackIndex >= 0) {
            this.readbackWrite = 1 - readbackIndex;
        }
    }

    async drainReadbacks() {
        const pending = this.readbackPromises.filter(Boolean);
        if (pending.length) {
            await Promise.all(pending.map((p) => p.catch(() => {})));
        }
        for (const buf of this.readbackBuffers) {
            try { buf?.unmap(); } catch { /* already unmapped */ }
        }
        this.readbackMapping = [false, false];
        this.readbackPromises = [null, null];
        this.tryApplyDeferredResize();
    }

    _dispatch(encoder, pipelineName, x, y, z, bindGroup) {
        const pass = encoder.beginComputePass({ label: pipelineName });
        pass.setPipeline(this.pipelines[pipelineName]);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(x, y, z);
        pass.end();
    }

    destroy() {
        this.deferredGridSize = null;
        this._destroyReadbackBuffers();
        this._destroyBuffers();
        this.dummyBuffers?.velIn?.destroy();
        this.dummyBuffers?.velOut?.destroy();
        this.dummyBuffers?.smokeIn?.destroy();
        this.dummyBuffers?.smokeOut?.destroy();
        this.dummyBuffers = null;
        this.uniformBuffer?.destroy();
        this.device = null;
    }
}
