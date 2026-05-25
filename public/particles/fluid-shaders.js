/** Original WGSL for grid-based smoke/fire fluid (Stam-style projection on a 3D grid). */

import { noiseCoreWgsl } from "./noiseWgsl.js";

export const FLUID_COMMON = /* wgsl */ `
struct FluidUniforms {
    gridSize: u32,
    dt: f32,
    time: f32,
    rdx: f32,
    smokeDecay: f32,
    velocityDecay: f32,
    temperatureDecay: f32,
    buoyancy: f32,
    ignitionTemp: f32,
    burnRate: f32,
    burnHeat: f32,
    burnSmoke: f32,
    enclosed: u32,
    vorticityEnabled: u32,
    vorticityAmount: f32,
    emitterStrength: f32,
    brushActive: u32,
    brushSize: f32,
    brushSmoke: f32,
    brushTemp: f32,
    brushVel: f32,
    brushAx: f32,
    brushAy: f32,
    brushAz: f32,
    brushBx: f32,
    brushBy: f32,
    brushBz: f32,
    canvasW: f32,
    canvasH: f32,
    camTheta: f32,
    camPhi: f32,
    camRadius: f32,
    camSpin: f32,
    stepLength: f32,
    emitShape: u32,
    emitPosX: f32,
    emitPosY: f32,
    emitPosZ: f32,
    emitRadius: f32,
    emitVelX: f32,
    emitVelY: f32,
    emitVelZ: f32,
    colorTintR: f32,
    colorTintG: f32,
    colorTintB: f32,
    densityScale: f32,
    noiseType: u32,
    noiseFrequency: f32,
    noiseAmplitude: f32,
    noiseSpeed: f32,
    noiseOctaves: u32,
    noiseSeed: f32,
    noiseTargets: u32,
    gravity: f32,
    lifeRate: f32,
};

fn cellCount(u: FluidUniforms) -> u32 {
    let g = u.gridSize;
    return g * g * g;
}

fn toIndex(id: vec3u, g: u32) -> u32 {
    return id.x + id.y * g + id.z * g * g;
}

fn worldPos(id: vec3u, g: u32) -> vec3f {
    return (vec3f(id) + 0.5) / f32(g) - 0.5;
}

fn inBounds(id: vec3u, g: u32) -> bool {
    return id.x > 0u && id.y > 0u && id.z > 0u
        && id.x < g - 1u && id.y < g - 1u && id.z < g - 1u;
}

fn sample1(field: ptr<storage, array<f32>, read_write>, pos: vec3f, g: u32) -> f32 {
    let p = (pos + 0.5) * f32(g) - 0.5;
    let i0 = vec3u(clamp(floor(p), vec3f(0.0), vec3f(f32(g) - 1.001)));
    let f = fract(p);
    let i1 = min(i0 + vec3u(1u), vec3u(g - 1u));
    let c000 = (*field)[toIndex(vec3u(i0.x, i0.y, i0.z), g)];
    let c100 = (*field)[toIndex(vec3u(i1.x, i0.y, i0.z), g)];
    let c010 = (*field)[toIndex(vec3u(i0.x, i1.y, i0.z), g)];
    let c110 = (*field)[toIndex(vec3u(i1.x, i1.y, i0.z), g)];
    let c001 = (*field)[toIndex(vec3u(i0.x, i0.y, i1.z), g)];
    let c101 = (*field)[toIndex(vec3u(i1.x, i0.y, i1.z), g)];
    let c011 = (*field)[toIndex(vec3u(i0.x, i1.y, i1.z), g)];
    let c111 = (*field)[toIndex(vec3u(i1.x, i1.y, i1.z), g)];
    let c00 = mix(c000, c100, f.x);
    let c10 = mix(c010, c110, f.x);
    let c01 = mix(c001, c101, f.x);
    let c11 = mix(c011, c111, f.x);
    let c0 = mix(c00, c10, f.y);
    let c1 = mix(c01, c11, f.y);
    return mix(c0, c1, f.z);
}

fn sample4(field: ptr<storage, array<vec4f>, read_write>, pos: vec3f, g: u32) -> vec4f {
    let p = (pos + 0.5) * f32(g) - 0.5;
    let i0 = vec3u(clamp(floor(p), vec3f(0.0), vec3f(f32(g) - 1.001)));
    let f = fract(p);
    let i1 = min(i0 + vec3u(1u), vec3u(g - 1u));
    let c000 = (*field)[toIndex(vec3u(i0.x, i0.y, i0.z), g)];
    let c100 = (*field)[toIndex(vec3u(i1.x, i0.y, i0.z), g)];
    let c010 = (*field)[toIndex(vec3u(i0.x, i1.y, i0.z), g)];
    let c110 = (*field)[toIndex(vec3u(i1.x, i1.y, i0.z), g)];
    let c001 = (*field)[toIndex(vec3u(i0.x, i0.y, i1.z), g)];
    let c101 = (*field)[toIndex(vec3u(i1.x, i0.y, i1.z), g)];
    let c011 = (*field)[toIndex(vec3u(i0.x, i1.y, i1.z), g)];
    let c111 = (*field)[toIndex(vec3u(i1.x, i1.y, i1.z), g)];
    let c00 = mix(c000, c100, f.x);
    let c10 = mix(c010, c110, f.x);
    let c01 = mix(c001, c101, f.x);
    let c11 = mix(c011, c111, f.x);
    let c0 = mix(c00, c10, f.y);
    let c1 = mix(c01, c11, f.y);
    return mix(c0, c1, f.z);
}

fn addSmoke(old: vec4f, add: vec4f) -> vec4f {
    // vec4: .rg = tint, .z = temperature, .w = density
    let na = old.w + add.w;
    if (na < 1e-6) { return vec4f(0.0); }
    let rg = (vec2f(old.r, old.g) * old.w + vec2f(add.r, add.g) * add.w) / na;
    let tz = (old.z * old.w + add.z * add.w) / na;
    return vec4f(rg.x, rg.y, tz, na);
}

fn blackbody(t: f32) -> vec3f {
    let x = clamp(t / 3000.0, 0.0, 1.0);
    return mix(vec3f(1.0, 0.25, 0.05), vec3f(1.0, 0.95, 0.85), x);
}
`;

export const FLUID_PASS_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> u : FluidUniforms;

@group(0) @binding(1) var<storage, read_write> velocityIn : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> smokeIn : array<vec4f>;
@group(0) @binding(3) var<storage, read_write> velocityOut : array<vec4f>;
@group(0) @binding(4) var<storage, read_write> smokeOut : array<vec4f>;
@group(0) @binding(5) var<storage, read_write> pressure : array<f32>;
@group(0) @binding(6) var<storage, read_write> divergence : array<f32>;
@group(0) @binding(7) var<storage, read_write> pressureTmp : array<f32>;
@group(0) @binding(8) var outputTex: texture_storage_2d<rgba8unorm, write>;

fn fluidTint(base: vec3f) -> vec3f {
    return base * vec3f(u.colorTintR, u.colorTintG, u.colorTintB);
}

fn fluidDensityMul(d: f32) -> f32 {
    return max(d, 0.0);
}

fn fluidNoiseVel(wp: vec3f, vel: vec4f) -> vec4f {
    if (u.noiseType == 0u || u.noiseAmplitude < 0.0001 || (u.noiseTargets & 1u) == 0u) {
        return vel;
    }
    let kind = i32(u.noiseType);
    let oct = i32(clamp(f32(u.noiseOctaves), 1.0, 4.0));
    let seedOff = vec3f(u.noiseSeed * 0.173, u.noiseSeed * 0.319, u.noiseSeed * 0.547);
    let sampleP = wp * u.noiseFrequency + seedOff
        + vec3f(u.time * u.noiseSpeed, u.time * u.noiseSpeed * 0.71, 0.0);
    let n = noiseFbmVec3(sampleP, kind, oct);
    return vec4f(vel.xyz + n * u.noiseAmplitude * 0.65, vel.w);
}

fn fluidNoiseDensityMul(wp: vec3f, density: f32) -> f32 {
    if (u.noiseType == 0u || u.noiseAmplitude < 0.0001 || (u.noiseTargets & 8u) == 0u) {
        return density;
    }
    let kind = i32(u.noiseType);
    let oct = i32(clamp(f32(u.noiseOctaves), 1.0, 4.0));
    let seedOff = vec3f(u.noiseSeed * 0.11, u.noiseSeed * 0.23, u.noiseSeed * 0.37);
    let sampleP = wp * u.noiseFrequency + seedOff
        + vec3f(u.time * u.noiseSpeed * 0.5, 0.0, u.time * u.noiseSpeed * 0.3);
    let n = noiseFbmScalar(sampleP, kind, oct);
    return max(density * (1.0 + n * u.noiseAmplitude * 0.45), 0.0);
}

@compute @workgroup_size(4, 4, 4)
fn fluidAdvect(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (gid.x >= g || gid.y >= g || gid.z >= g) { return; }
    let idx = toIndex(gid, g);
    let wp = worldPos(gid, g);
    let vel = sample4(&velocityIn, wp, g);
    let smokeHere = sample4(&smokeIn, wp, g);
    let rise = smokeHere.w * u.buoyancy * 5.0 + smokeHere.z * u.buoyancy * 0.015;
    let fall = u.gravity;
    let advectVel = vec3f(vel.x, vel.y + rise - fall, vel.z);
    let back = wp - u.dt * u.rdx * advectVel;
    if (u.enclosed == 0u && (back.x < -0.5 || back.y < -0.5 || back.z < -0.5
        || back.x > 0.5 || back.y > 0.5 || back.z > 0.5)) {
        velocityOut[idx] = vec4f(0.0);
        smokeOut[idx] = vec4f(0.0);
        return;
    }
    var smoke = sample4(&smokeIn, back, g);
    smoke.w *= exp(-u.smokeDecay * u.dt);
    smoke.z *= exp(-u.temperatureDecay * u.dt);
    var temp = smoke.z;
    var outVel = sample4(&velocityIn, back, g);
    let velDecay = exp(-u.velocityDecay * u.dt);
    outVel = vec4f(outVel.xyz * velDecay, outVel.w);
    let burn = select(0.0, u.burnRate * u.dt, temp > u.ignitionTemp);
    let fuel = max(outVel.w - burn, 0.0);
    let burnt = outVel.w - fuel;
    temp += burnt * u.burnHeat;
    smoke = addSmoke(smoke, vec4f(0.35, 0.35, burnt * u.burnHeat * 0.001, burnt * u.burnSmoke));
    smoke.z = temp;
    let velRise = smoke.w * u.buoyancy * 0.8 + temp * u.buoyancy * 0.003;
    outVel = vec4f(outVel.x, outVel.y + (velRise - u.gravity * 0.35) * u.dt, outVel.z, fuel);
    outVel = fluidNoiseVel(wp, outVel);
    velocityOut[idx] = outVel;
    smokeOut[idx] = smoke;
}

@compute @workgroup_size(4, 4, 4)
fn fluidDivergence(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (!inBounds(gid, g)) { return; }
    let idx = toIndex(gid, g);
    let l = toIndex(gid - vec3u(1u, 0u, 0u), g);
    let r = toIndex(gid + vec3u(1u, 0u, 0u), g);
    let d = toIndex(gid - vec3u(0u, 1u, 0u), g);
    let t = toIndex(gid + vec3u(0u, 1u, 0u), g);
    let b = toIndex(gid - vec3u(0u, 0u, 1u), g);
    let f = toIndex(gid + vec3u(0u, 0u, 1u), g);
    let vx = velocityIn[r].x - velocityIn[l].x;
    let vy = velocityIn[t].y - velocityIn[d].y;
    let vz = velocityIn[f].z - velocityIn[b].z;
    divergence[idx] = 0.5 * u.rdx * (vx + vy + vz);
}

@compute @workgroup_size(4, 4, 4)
fn fluidClearPressure(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (gid.x >= g || gid.y >= g || gid.z >= g) { return; }
    let idx = toIndex(gid, g);
    pressure[idx] = 0.0;
    pressureTmp[idx] = 0.0;
}

@compute @workgroup_size(4, 4, 4)
fn fluidJacobi(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (!inBounds(gid, g)) { return; }
    let idx = toIndex(gid, g);
    let l = toIndex(gid - vec3u(1u, 0u, 0u), g);
    let r = toIndex(gid + vec3u(1u, 0u, 0u), g);
    let d = toIndex(gid - vec3u(0u, 1u, 0u), g);
    let t = toIndex(gid + vec3u(0u, 1u, 0u), g);
    let b = toIndex(gid - vec3u(0u, 0u, 1u), g);
    let f = toIndex(gid + vec3u(0u, 0u, 1u), g);
    let div = divergence[idx];
    let p = (pressure[l] + pressure[r] + pressure[d] + pressure[t] + pressure[b] + pressure[f] - div) / 6.0;
    pressureTmp[idx] = p;
}

@compute @workgroup_size(4, 4, 4)
fn fluidSwapPressure(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (gid.x >= g || gid.y >= g || gid.z >= g) { return; }
    let idx = toIndex(gid, g);
    pressure[idx] = pressureTmp[idx];
}

@compute @workgroup_size(4, 4, 4)
fn fluidGradientSubtract(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (!inBounds(gid, g)) { return; }
    let idx = toIndex(gid, g);
    let l = toIndex(gid - vec3u(1u, 0u, 0u), g);
    let r = toIndex(gid + vec3u(1u, 0u, 0u), g);
    let d = toIndex(gid - vec3u(0u, 1u, 0u), g);
    let t = toIndex(gid + vec3u(0u, 1u, 0u), g);
    let b = toIndex(gid - vec3u(0u, 0u, 1u), g);
    let f = toIndex(gid + vec3u(0u, 0u, 1u), g);
    var vel = velocityIn[idx];
    let scale = 0.5 * u.rdx;
    vel = vec4f(
        vel.x - scale * (pressure[r] - pressure[l]),
        vel.y - scale * (pressure[t] - pressure[d]),
        vel.z - scale * (pressure[f] - pressure[b]),
        vel.w,
    );
    velocityOut[idx] = vel;
}

@compute @workgroup_size(4, 4, 4)
fn fluidCopyVelocity(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (gid.x >= g || gid.y >= g || gid.z >= g) { return; }
    velocityOut[toIndex(gid, g)] = velocityIn[toIndex(gid, g)];
}

@compute @workgroup_size(4, 4, 4)
fn fluidEmit(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (!inBounds(gid, g)) { return; }
    let idx = toIndex(gid, g);
    let wp = worldPos(gid, g);
    var vel = velocityOut[idx];
    var smoke = smokeOut[idx];
    let emitDt = max(u.dt, 1.0 / 120.0);
    let center = vec3f(u.emitPosX, u.emitPosY, u.emitPosZ);
    let d = wp - center;
    let radius = max(u.emitRadius, 0.02);
    var mask = 0.0;
    if (u.emitShape == 0u) {
        mask = max(0.0, 1.0 - length(d) / radius);
    } else if (u.emitShape == 1u) {
        mask = max(0.0, 1.0 - length(d) / radius);
    } else if (u.emitShape == 2u) {
        let edge = max(abs(d.x), max(abs(d.y), abs(d.z)));
        mask = max(0.0, 1.0 - edge / radius);
    } else {
        let radial = max(0.0, 1.0 - length(d.xz) / radius);
        mask = radial;
    }
    // Floor emitters: only upper hemisphere / above disk — no dome stuck to ground
    if (center.y < -0.3 && u.emitShape <= 1u) {
        mask *= smoothstep(-0.01, 0.06, d.y);
    }
    if (mask > 0.0) {
        mask = mask * mask;
        let spot = mask * u.emitterStrength * emitDt;
        let tint = fluidTint(vec3f(u.colorTintR, u.colorTintG, u.colorTintB));
        let heat = u.ignitionTemp * spot;
        let emitVel = vec3f(u.emitVelX, u.emitVelY, u.emitVelZ);
        var densityAdd = spot * (1.2 + u.emitterStrength * 1.8);
        let cap = 0.05 + spot * 2.5;
        densityAdd = min(densityAdd, max(0.0, cap - smoke.w));
        if (densityAdd > 0.0) {
            smoke = addSmoke(smoke, vec4f(tint.r, tint.g, heat, densityAdd));
        }
        let velScale = 6.0 + u.emitterStrength * 3.0;
        vel = vec4f(
            vel.x + emitVel.x * spot * velScale,
            vel.y + emitVel.y * spot * velScale,
            vel.z + emitVel.z * spot * velScale,
            min(vel.w + spot * 0.15, 1.0),
        );
    }
    vel = fluidNoiseVel(wp, vel);
    velocityOut[idx] = vel;
    smokeOut[idx] = smoke;
}

@compute @workgroup_size(4, 4, 4)
fn fluidBuoyancy(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (!inBounds(gid, g)) { return; }
    let idx = toIndex(gid, g);
    let smoke = smokeOut[idx];
    if (smoke.w < 1e-5) { return; }
    var vel = velocityOut[idx];
    let rise = smoke.w * u.buoyancy * 1.8 + smoke.z * u.buoyancy * 0.005;
    vel.y += (rise - u.gravity) * u.dt;
    velocityOut[idx] = vel;
}

@compute @workgroup_size(4, 4, 4)
fn fluidBrush(@builtin(global_invocation_id) gid: vec3u) {
    let g = u.gridSize;
    if (u.brushActive == 0u || !inBounds(gid, g)) { return; }
    let idx = toIndex(gid, g);
    let wp = worldPos(gid, g);
    let a = vec3f(u.brushAx, u.brushAy, u.brushAz);
    let b = vec3f(u.brushBx, u.brushBy, u.brushBz);
    let pa = wp - a;
    let ba = b - a;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    let dist = length(pa - ba * h);
    let spot = max(0.0, u.brushSize - dist) * u.dt;
    if (spot <= 0.0) { return; }
    var vel = velocityOut[idx];
    var smoke = smokeOut[idx];
    var temp = smoke.z;
    let dir = normalize(b - a + vec3f(1e-4));
    smoke = addSmoke(smoke, vec4f(0.85, 0.35, spot * u.brushTemp, spot * u.brushSmoke));
    let velDelta = dir * spot * u.brushVel;
    vel = vec4f(vel.x + velDelta.x, vel.y + velDelta.y, vel.z + velDelta.z, min(vel.w + spot * 0.5, 1.0));
    smoke.z = max(smoke.z, temp);
    velocityOut[idx] = vel;
    smokeOut[idx] = smoke;
}

fn camBasis(theta: f32, phi: f32) -> mat3x3f {
    let ct = cos(theta);
    let st = sin(theta);
    let cp = cos(phi);
    let sp = sin(phi);
    let forward = normalize(vec3f(cp * ct, sp, cp * st));
    let worldUp = vec3f(0.0, 1.0, 0.0);
    let right = normalize(cross(forward, worldUp));
    let up = cross(right, forward);
    return mat3x3f(right, up, -forward);
}

fn rayBox(origin: vec3f, dir: vec3f, bmin: vec3f, bmax: vec3f) -> vec2f {
    let inv = 1.0 / (dir + vec3f(1e-6));
    let t0 = (bmin - origin) * inv;
    let t1 = (bmax - origin) * inv;
    let tmin = min(t0, t1);
    let tmax = max(t0, t1);
    let near = max(max(tmin.x, tmin.y), tmin.z);
    let far = min(min(tmax.x, tmax.y), tmax.z);
    return vec2f(near, far);
}

@compute @workgroup_size(8, 8)
fn fluidRender(@builtin(global_invocation_id) gid: vec3u) {
    let dims = vec2u(u32(u.canvasW), u32(u.canvasH));
    if (gid.x >= dims.x || gid.y >= dims.y) { return; }
    let uv = (vec2f(gid.xy) + 0.5) / vec2f(dims) * 2.0 - 1.0;
    let aspect = u.canvasW / max(u.canvasH, 1.0);
    let screen = vec2f(uv.x * aspect, uv.y);
    let basis = camBasis(u.camTheta, u.camPhi + u.time * u.camSpin);
    let origin = basis * vec3f(0.0, 0.0, u.camRadius);
    let dir = normalize(basis * vec3f(screen, -1.8));
    let hit = rayBox(origin, dir, vec3f(-0.5), vec3f(0.5));
    if (hit.y <= max(hit.x, 0.0)) {
        textureStore(outputTex, vec2i(gid.xy), vec4f(0.04, 0.05, 0.08, 1.0));
        return;
    }
    var t = max(hit.x, 0.0);
    let tEnd = hit.y;
    var col = vec3f(0.0);
    var alpha = 0.0;
    let g = u.gridSize;
    let steps = 64;
    let dt = (tEnd - t) / f32(steps);
    for (var i = 0; i < steps; i++) {
        let p = origin + dir * (t + dt * (f32(i) + 0.5));
        if (p.x < -0.5 || p.y < -0.5 || p.z < -0.5 || p.x > 0.5 || p.y > 0.5 || p.z > 0.5) {
            continue;
        }
        let smoke = sample4(&smokeIn, p, g);
        let temp = smoke.z;
        var sampleCol = vec3f(smoke.r, smoke.g, smoke.r);
        if (temp > 200.0) {
            sampleCol += blackbody(temp) * clamp(temp / 1500.0, 0.0, 1.0);
        }
        let density = smoke.w * u.stepLength;
        let a = 1.0 - exp(-density);
        col += (1.0 - alpha) * a * sampleCol;
        alpha += (1.0 - alpha) * a;
        if (alpha > 0.98) { break; }
    }
    let bg = vec3f(0.04, 0.05, 0.08);
    let outCol = mix(bg, col, alpha);
    textureStore(outputTex, vec2i(gid.xy), vec4f(outCol, 1.0));
}
`;

export function buildFluidShaderCode() {
    return `${FLUID_COMMON}\n${noiseCoreWgsl()}\n${FLUID_PASS_WGSL}`;
}

export const FLUID_UNIFORM_BYTES = 256;

export const FLUID_BLIT_SHADER = /* wgsl */ `
struct BlitOut {
    @builtin(position) pos: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn blitVs(@builtin(vertex_index) vi: u32) -> BlitOut {
    let x = f32((vi << 1u) & 2u);
    let y = f32(vi & 2u);
    var out: BlitOut;
    out.pos = vec4f(x * 2.0 - 1.0, y * -2.0 + 1.0, 0.0, 1.0);
    out.uv = vec2f(x, 1.0 - y);
    return out;
}

@group(0) @binding(0) var blitTex: texture_2d<f32>;
@group(0) @binding(1) var blitSampler: sampler;

@fragment
fn blitFs(in: BlitOut) -> @location(0) vec4f {
    return textureSample(blitTex, blitSampler, in.uv);
}
`;
