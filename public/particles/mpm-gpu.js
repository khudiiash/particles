export const MPM_ENTRY_POINTS = ["clearMpmGrid", "mpmP2G1", "mpmP2G2", "mpmUpdateGrid", "mpmG2P"];
export const FLUID_SUBSTEPS = 1;
/** Match three.js: clamp dt to 1/60, never advance too far. */
export const FLUID_DT_CLAMP = 1 / 60;

export function fluidFrameDt(rawDt) {
    const dt = rawDt > 0 ? rawDt : 1 / 60;
    return Math.min(dt, FLUID_DT_CLAMP);
}

export function mpmGridDim(gridSize = 32) {
    return Math.max(8, Math.round(gridSize));
}

export function mpmCellCount(gridSize = 32) {
    const g = mpmGridDim(gridSize);
    return g * g * g;
}

export function calcDispatch(count, workgroupSize = 64) {
    const wg = workgroupSize || 64;
    const groupsX = Math.max(1, Math.ceil(count / (wg * 1024)));
    return { x: groupsX, y: 1024 };
}

export function createMpmBuffers(device, particleCount, gridSize = 32) {
    const cellCount = mpmCellCount(gridSize);
    return {
        gridDim: mpmGridDim(gridSize),
        cellCount,
        mpmC: device.createBuffer({
            label: "mpmC",
            size: particleCount * 48,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        mpmCells: device.createBuffer({
            label: "mpmCells",
            size: cellCount * 16,
            usage: GPUBufferUsage.STORAGE,
        }),
        mpmCellsFloat: device.createBuffer({
            label: "mpmCellsFloat",
            size: cellCount * 16,
            usage: GPUBufferUsage.STORAGE,
        }),
    };
}

export function createSimBindGroupLayout(device, uniformBytes = 448) {
    const visibility = GPUShaderStage.COMPUTE;
    return device.createBindGroupLayout({
        label: "simBindGroup",
        entries: [
            { binding: 0, visibility, buffer: { type: "uniform", minBindingSize: uniformBytes } },
            { binding: 1, visibility, buffer: { type: "storage" } },
            { binding: 2, visibility, buffer: { type: "read-only-storage" } },
            { binding: 3, visibility, buffer: { type: "storage" } },
            { binding: 4, visibility, buffer: { type: "storage" } },
            { binding: 5, visibility, buffer: { type: "storage" } },
        ],
    });
}

export function createSimBindGroupEntries(buffers) {
    return [
        { binding: 0, resource: { buffer: buffers.simUniformBuffer } },
        { binding: 1, resource: { buffer: buffers.particleBuffer } },
        { binding: 2, resource: { buffer: buffers.pathBuffer } },
        { binding: 3, resource: { buffer: buffers.mpmC } },
        { binding: 4, resource: { buffer: buffers.mpmCells } },
        { binding: 5, resource: { buffer: buffers.mpmCellsFloat } },
    ];
}

export async function createMpmPipelines(device, simModule, pipelineLayout, entryPoint = "updateParticles") {
    const pipeline = await device.createComputePipelineAsync({
        layout: pipelineLayout,
        compute: { module: simModule, entryPoint },
        label: entryPoint,
    });
    return pipeline;
}

export function encodeMpmFluidPasses(encoder, mpm, bindGroup) {
    const { pipelines, particleDispatch, gridDispatch } = mpm;
    for (const entry of MPM_ENTRY_POINTS) {
        const pass = encoder.beginComputePass({ label: entry });
        pass.setPipeline(pipelines[entry]);
        pass.setBindGroup(0, bindGroup);
        const dispatch = entry === "clearMpmGrid" || entry === "mpmUpdateGrid"
            ? gridDispatch
            : particleDispatch;
        pass.dispatchWorkgroups(dispatch.x, dispatch.y, 1);
        pass.end();
    }
}

export async function setupMpmGpu(device, cfg, buffers, uniformBytes = 448) {
    const simModule = device.createShaderModule({ code: cfg.simulation.wgsl, label: "sim" });
    const simInfo = await simModule.getCompilationInfo();
    simInfo.messages.filter((m) => m.type === "error").forEach((m) => {
        throw new Error(`Sim WGSL (${m.lineNum}:${m.linePos}): ${m.message}`);
    });

    const bindGroupLayout = createSimBindGroupLayout(device, uniformBytes);
    const pipelineLayout = device.createPipelineLayout({
        label: "simPipeline",
        bindGroupLayouts: [bindGroupLayout],
    });

    const entryPoints = ["updateParticles", ...MPM_ENTRY_POINTS];
    const pipelines = {};
    for (const entry of entryPoints) {
        pipelines[entry] = await createMpmPipelines(device, simModule, pipelineLayout, entry);
    }

    const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: createSimBindGroupEntries(buffers),
    });

    const wg = cfg.workgroupSize || 64;
    const particleDispatch = calcDispatch(cfg.maxParticles, wg);
    const gridDispatch = calcDispatch(buffers.cellCount, wg);

    return { simModule, pipelines, bindGroup, particleDispatch, gridDispatch };
}
