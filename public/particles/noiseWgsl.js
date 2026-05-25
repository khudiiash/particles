/** WGSL noise library — injected into defaultEffect.js simulation shader. */

export function noiseCoreWgsl() {
    return `
const NOISE_TARGET_VELOCITY: i32 = 1;
const NOISE_TARGET_COLOR: i32 = 2;
const NOISE_TARGET_SIZE: i32 = 4;
const NOISE_TARGET_OPACITY: i32 = 8;
const NOISE_TARGET_POSITION: i32 = 16;

fn hash33(p: vec3f) -> vec3f {
    var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
    q += dot(q, q.yxz + 33.33);
    return fract((q.xxy + q.yxx) * q.zyx);
}

fn hash13(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

fn fade3(t: vec3f) -> vec3f {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn fade2(t: vec2f) -> vec2f {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn vec3mod(v: vec3f, m: f32) -> vec3f {
    return v - floor(v / m) * m;
}

fn grad3(hash: f32, x: f32, y: f32, z: f32) -> f32 {
    let h = i32(hash * 16.0);
    let u = select(y, x, (h & 1) == 0);
    let v = select(select(x, z, (h & 2) == 0), y, (h & 1) != 0);
    return select(u, -u, (h & 4) != 0) + select(v, -v, (h & 8) != 0);
}

fn grad2(hash: f32, x: f32, y: f32) -> f32 {
    let h = i32(hash * 4.0);
    let u = select(y, x, (h & 1) == 0);
    let v = select(x, y, (h & 1) != 0);
    return select(u, -u, (h & 2) != 0) + select(v, -v, (h & 2) != 0);
}

fn noisePerlin3(p: vec3f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = fade3(f);
    let n000 = grad3(hash13(i + vec3f(0.0, 0.0, 0.0)), f.x, f.y, f.z);
    let n100 = grad3(hash13(i + vec3f(1.0, 0.0, 0.0)), f.x - 1.0, f.y, f.z);
    let n010 = grad3(hash13(i + vec3f(0.0, 1.0, 0.0)), f.x, f.y - 1.0, f.z);
    let n110 = grad3(hash13(i + vec3f(1.0, 1.0, 0.0)), f.x - 1.0, f.y - 1.0, f.z);
    let n001 = grad3(hash13(i + vec3f(0.0, 0.0, 1.0)), f.x, f.y, f.z - 1.0);
    let n101 = grad3(hash13(i + vec3f(1.0, 0.0, 1.0)), f.x - 1.0, f.y, f.z - 1.0);
    let n011 = grad3(hash13(i + vec3f(0.0, 1.0, 1.0)), f.x, f.y - 1.0, f.z - 1.0);
    let n111 = grad3(hash13(i + vec3f(1.0, 1.0, 1.0)), f.x - 1.0, f.y - 1.0, f.z - 1.0);
    let x0 = mix(n000, n100, u.x);
    let x1 = mix(n010, n110, u.x);
    let x2 = mix(n001, n101, u.x);
    let x3 = mix(n011, n111, u.x);
    return mix(mix(x0, x1, u.y), mix(x2, x3, u.y), u.z);
}

fn noisePerlin2(p: vec2f) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = fade2(f);
    let n00 = grad2(hash13(vec3f(i.x, i.y, 0.0)), f.x, f.y);
    let n10 = grad2(hash13(vec3f(i.x + 1.0, i.y, 0.0)), f.x - 1.0, f.y);
    let n01 = grad2(hash13(vec3f(i.x, i.y + 1.0, 0.0)), f.x, f.y - 1.0);
    let n11 = grad2(hash13(vec3f(i.x + 1.0, i.y + 1.0, 0.0)), f.x - 1.0, f.y - 1.0);
    return mix(mix(n00, n10, u.x), mix(n01, n11, u.x), u.y);
}

fn noiseSimplex2(p: vec2f) -> f32 {
    let s = (p.x + p.y) * 0.366025403;
    let i = floor(p + s);
    let t = (i.x + i.y) * 0.211324865;
    let x0 = p - (i - t);
    let i1 = select(vec2f(0.0, 1.0), vec2f(1.0, 0.0), x0.x > x0.y);
    let x1 = x0 - i1 + 0.211324865;
    let x2 = x0 - 0.577350269;
    let h0 = hash13(vec3f(i.x, i.y, 0.0));
    let h1 = hash13(vec3f(i.x + i1.x, i.y + i1.y, 0.0));
    let h2 = hash13(vec3f(i.x + 1.0, i.y + 1.0, 0.0));
    let g0 = grad2(h0, x0.x, x0.y);
    let g1 = grad2(h1, x1.x, x1.y);
    let g2 = grad2(h2, x2.x, x2.y);
    let m0 = max(0.5 - dot(x0, x0), 0.0);
    let m1 = max(0.5 - dot(x1, x1), 0.0);
    let m2 = max(0.5 - dot(x2, x2), 0.0);
    return 70.0 * (m0 * m0 * m0 * m0 * g0 + m1 * m1 * m1 * m1 * g1 + m2 * m2 * m2 * m2 * g2);
}

fn noiseSimplex3(p: vec3f) -> f32 {
    let K1 = 0.333333333;
    let K2 = 0.166666667;
    let i = floor(p + dot(p, vec3f(K1)));
    let t = dot(i, vec3f(K2));
    let x0 = p - i + t;
    let g = step(x0.yzx, x0.xyz);
    let l = 1.0 - g;
    let i1 = min(g.xyz, l.zxy);
    let i2 = max(g.xyz, l.zxy);
    let x1 = x0 - i1 + K2;
    let x2 = x0 - i2 + 2.0 * K2;
    let x3 = x0 - 1.0 + 3.0 * K2;
    let ii = vec3mod(i, 289.0);
    let m0 = max(0.6 - dot(x0, x0), 0.0);
    let m1 = max(0.6 - dot(x1, x1), 0.0);
    let m2 = max(0.6 - dot(x2, x2), 0.0);
    let m3 = max(0.6 - dot(x3, x3), 0.0);
    let m = vec4f(m0 * m0 * m0 * m0, m1 * m1 * m1 * m1, m2 * m2 * m2 * m2, m3 * m3 * m3 * m3);
    let g0 = hash33(ii) * 2.0 - 1.0;
    let g1 = hash33(ii + i1) * 2.0 - 1.0;
    let g2 = hash33(ii + i2) * 2.0 - 1.0;
    let g3 = hash33(ii + 1.0) * 2.0 - 1.0;
    return 42.0 * (
        m.x * dot(g0, x0) + m.y * dot(g1, x1) + m.z * dot(g2, x2) + m.w * dot(g3, x3)
    );
}

fn voronoi3(p: vec3f) -> f32 {
    let n = floor(p);
    let f = fract(p);
    var md = 8.0;
    for (var k = -1; k <= 1; k++) {
        for (var j = -1; j <= 1; j++) {
            for (var i = -1; i <= 1; i++) {
                let g = vec3f(f32(i), f32(j), f32(k));
                let o = hash33(n + g);
                let r = g + o - f;
                md = min(md, dot(r, r));
            }
        }
    }
    return sqrt(md) * 2.0 - 1.0;
}

fn noiseByType(noiseKind: i32, p3: vec3f, p2: vec2f) -> f32 {
    if (noiseKind == 1) { return noiseSimplex3(p3); }
    if (noiseKind == 2) { return noiseSimplex2(p2); }
    if (noiseKind == 3) { return noisePerlin3(p3); }
    if (noiseKind == 4) { return noisePerlin2(p2); }
    if (noiseKind == 5) { return voronoi3(p3); }
    return 0.0;
}

fn noiseFbmScalar(p: vec3f, noiseKind: i32, octaves: i32) -> f32 {
    var amp = 0.5;
    var freq = 1.0;
    var sum = 0.0;
    var norm = 0.0;
    let p2 = p.xy;
    for (var o = 0; o < 4; o++) {
        if (o >= octaves) { break; }
        let n = noiseByType(noiseKind, p * freq, p2 * freq);
        sum += n * amp;
        norm += amp;
        amp *= 0.5;
        freq *= 2.0;
    }
    return sum / max(norm, 0.0001);
}

fn noiseFbmVec3(p: vec3f, noiseKind: i32, octaves: i32) -> vec3f {
    return vec3f(
        noiseFbmScalar(p, noiseKind, octaves),
        noiseFbmScalar(p + vec3f(19.19, 7.7, 3.1), noiseKind, octaves),
        noiseFbmScalar(p + vec3f(5.5, 13.3, 27.9), noiseKind, octaves),
    );
}
`;
}

export function particleNoiseWgsl() {
    return `${noiseCoreWgsl()}
fn applyParticleNoise(p: ptr<function, Particle>, lifeT: f32, mode: i32) {
    if (ub.noiseType < 0.5 || ub.noiseAmplitude < 0.0001) {
        return;
    }
    let targets = i32(round(ub.noiseTargets));
    if (targets == 0) {
        return;
    }

    let noiseKind = i32(round(ub.noiseType));
    let octaves = i32(clamp(round(ub.noiseOctaves), 1.0, 4.0));
    let seedOff = vec3f(ub.noiseSeed * 0.173, ub.noiseSeed * 0.319, ub.noiseSeed * 0.547);
    let anim = vec3f(
        ub.time * ub.noiseSpeed,
        ub.time * ub.noiseSpeed * 0.71,
        lifeT * ub.noiseSpeed * 0.37,
    );
    let sampleP = (*p).position * ub.noiseFrequency + seedOff + anim;
    let n = noiseFbmVec3(sampleP, noiseKind, octaves);
    let amp = ub.noiseAmplitude;

    if ((targets & NOISE_TARGET_VELOCITY) != 0 && mode != 3 && mode != 4) {
        (*p).velocity += n * amp;
    }
    if ((targets & NOISE_TARGET_COLOR) != 0 && mode != 3) {
        (*p).color = clamp((*p).color + n * amp * 0.35, vec3f(0.0), vec3f(3.0));
    }
    if ((targets & NOISE_TARGET_SIZE) != 0) {
        (*p).size = max(0.0001, (*p).size + n.x * amp * 0.015);
    }
    if ((targets & NOISE_TARGET_OPACITY) != 0) {
        (*p).opacity = clamp((*p).opacity + n.y * amp * 0.3, 0.0, 1.0);
    }
    if ((targets & NOISE_TARGET_POSITION) != 0 && mode != 3 && mode != 4) {
        (*p).position += n * amp * ub.dt * 3.0;
    }
}
`;
}
