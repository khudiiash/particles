/** WGSL Particle struct uses vec3+f32 slots (16-byte aligned). Total 64 bytes = 16 floats. */
export const PARTICLE_STRIDE_FLOATS = 16;

export const PARTICLE_F = {
    px: 0,
    py: 1,
    pz: 2,
    life: 3,
    vx: 4,
    vy: 5,
    vz: 6,
    maxLife: 7,
    size: 8,
    opacity: 9,
    pathPhase: 10,
    pathSpread: 11,
    cr: 12,
    cg: 13,
    cb: 14,
    seed: 15,
};
