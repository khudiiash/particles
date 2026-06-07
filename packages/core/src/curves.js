/** @typedef {{ t: number, min: number, max: number }} CurveKey */
/** @typedef {{ keys: CurveKey[], random: boolean, easing: string }} KeyframeCurve */
/** @typedef {{ start: string, end: string, random: boolean, randomBetween: boolean, easing: string }} ColorCurve */

import { collisionModeIndex, mergeRender, normalizeCollisionMode, mergeBoundsHalf } from "./render.js";
import { DEFAULT_NOISE, mergeNoiseParams, packNoiseLayers } from "./noise.js";

export const MAX_KEYS = 6;

export const EASINGS = [
    { id: "linear", label: "Linear" },
    { id: "easeIn", label: "Ease In" },
    { id: "easeOut", label: "Ease Out" },
    { id: "easeInOut", label: "Ease In Out" },
    { id: "easeInQuad", label: "Quad In" },
    { id: "easeOutQuad", label: "Quad Out" },
    { id: "easeInOutQuad", label: "Quad In Out" },
];

function keyframe(sMin, sMax, eMin, eMax, random, easing) {
    return {
        keys: [{ t: 0, min: sMin, max: sMax }, { t: 1, min: eMin, max: eMax }],
        random,
        easing,
        advanced: false,
    };
}

export function constantScalarCurve(value) {
    const v = Number(value) || 0;
    return {
        keys: [{ t: 0, min: v, max: v }, { t: 1, min: v, max: v }],
        random: false,
        easing: "linear",
        advanced: false,
    };
}

export function scalarSimpleValue(curve) {
    const keys = normalizeKeys(curve?.keys || []);
    const k0 = keys[0] || { min: 0, max: 0 };
    return (k0.min + k0.max) * 0.5;
}

export function inferScalarAdvanced(curve) {
    if (curve?.advanced === true) return true;
    if (curve?.advanced === false) return false;
    const keys = normalizeKeys(curve?.keys || []);
    if (keys.length > 2) return true;
    if (curve?.random) return true;
    if (curve?.easing && curve.easing !== "linear") return true;
    const k0 = keys[0] || { min: 0, max: 0 };
    const kN = keys[keys.length - 1] || k0;
    if (k0.min !== k0.max || kN.min !== kN.max) return true;
    if (k0.min !== kN.min || k0.max !== kN.max) return true;
    return false;
}

export function inferColorAdvanced(curve) {
    if (curve?.advanced === true) return true;
    if (curve?.advanced === false) return false;
    const keys = normalizeColorKeys(curve?.keys || []);
    if (keys.length > 2) return true;
    if (curve?.random || curve?.randomBetween) return true;
    if (curve?.easing && curve.easing !== "linear") return true;
    const k0 = keys[0];
    const kN = keys[keys.length - 1];
    if (k0 && kN && k0.color !== kN.color) return true;
    return false;
}

export const DEFAULT_VELOCITY = {
    random: true,
    easing: "linear",
    channels: {
        x: { keys: [{ t: 0, min: -0.5, max: 0.5 }, { t: 1, min: 0, max: 0 }] },
        y: { keys: [{ t: 0, min: 1, max: 3 }, { t: 1, min: -1, max: -1 }] },
        z: { keys: [{ t: 0, min: -0.5, max: 0.5 }, { t: 1, min: 0, max: 0 }] },
    },
};

export const SCALAR_CURVES = [
    { key: "life", label: "Lifetime", step: 0.1, default: constantScalarCurve(5) },
    { key: "size", label: "Scale", step: 0.001, default: constantScalarCurve(0.15) },
    { key: "opacity", label: "Opacity", step: 0.01, default: constantScalarCurve(1) },
];

export const ROTATION_CURVE = {
    key: "rotation",
    label: "Rotation",
    step: 1,
    default: {
        keys: [{ t: 0, min: 0, max: 0 }, { t: 1, min: 0, max: 0 }],
        random: false,
        easing: "linear",
        advanced: false,
    },
};

const DEG2RAD = Math.PI / 180;

export function rotationSimpleCurve(degrees) {
    const d = Number(degrees) || 0;
    return {
        keys: [{ t: 0, min: 0, max: 0 }, { t: 1, min: d, max: d }],
        random: false,
        easing: "linear",
        advanced: false,
    };
}

export function mergeRotationCurve(curve) {
    return mergeKeyframeCurve(curve, ROTATION_CURVE.default);
}

export function rotationCurveToRadians(curve) {
    const leg = keysToLegacy(mergeRotationCurve(curve));
    return {
        startMin: leg.startMin * DEG2RAD,
        startMax: leg.startMax * DEG2RAD,
        endMin: leg.endMin * DEG2RAD,
        endMax: leg.endMax * DEG2RAD,
        random: leg.random,
        easing: leg.easing,
    };
}

function fract01(x) {
    return x - Math.floor(x);
}

export function evaluateRotationCurve(curve, lifeT, seed = 0) {
    const c = rotationCurveToRadians(curve);
    const rnd = fract01(Math.sin(seed * 12.9898) * 43758.5453);
    const rnd2 = fract01(rnd * 7.13);
    const start = c.random
        ? c.startMin + (c.startMax - c.startMin) * rnd
        : c.startMin;
    const end = c.random
        ? c.endMin + (c.endMax - c.endMin) * rnd2
        : c.endMin;
    return start + (end - start) * evaluateEase(lifeT, c.easing);
}

/** Hard limits applied when editing curve keys. */
export const CURVE_CLAMP = {
    opacity: { min: 0, max: 1 },
    size: { min: 0 },
    life: { min: 0 },
    rotation: { min: -720, max: 720 },
};

export function clampKeyframe(curveKey, k) {
    const c = CURVE_CLAMP[curveKey];
    if (!c || !k) return;
    if (c.min != null) {
        k.min = Math.max(c.min, k.min);
        k.max = Math.max(c.min, k.max);
    }
    if (c.max != null) {
        k.min = Math.min(c.max, k.min);
        k.max = Math.min(c.max, k.max);
    }
    if (k.min > k.max) k.max = k.min;
}

export function computeGraphYRange(vals, curveKey, padding = 0.1) {
    let yMin = Math.min(...vals);
    let yMax = Math.max(...vals);
    if (curveKey === "opacity") {
        yMin = Math.max(0, yMin);
        yMax = Math.min(1, yMax);
    }
    if (curveKey === "size" || curveKey === "life") {
        yMin = Math.max(0, yMin);
    }
    if (Math.abs(yMax - yMin) < 1e-6) {
        yMin -= 1;
        yMax += 1;
    }
    const py = (yMax - yMin) * padding || 0.1;
    yMin -= py;
    yMax += py;
    if (curveKey === "opacity") {
        yMin = Math.max(0, yMin);
        yMax = Math.min(1, yMax);
    }
    if (curveKey === "size" || curveKey === "life") {
        yMin = Math.max(0, yMin);
    }
    return { yMin, yMax };
}

export const SPAWN_SHAPES = [
    { id: "point", label: "Point" },
    { id: "sphere", label: "Sphere" },
    { id: "box", label: "Box" },
    { id: "plane", label: "Plane" },
];

export const PARAM_FIELDS = [
    { key: "gravity", label: "Gravity", step: 0.1, min: -20, max: 20, default: 4 },
    { key: "drag", label: "Drag", step: 0.01, min: 0, max: 1, default: 0 },
    { key: "spawnShape", label: "Spawn shape", type: "select", options: SPAWN_SHAPES, default: "sphere" },
    { key: "spawnRadius", label: "Spawn radius", step: 0.05, min: 0, max: 10, default: 0 },
    { key: "emitSpread", label: "Emit spread (s)", step: 0.1, min: 0, max: 20, default: 3 },
];

export const DEFAULT_COLOR_CURVE = {
    keys: [{ t: 0, color: "#ffffff" }, { t: 1, color: "#ffffff" }],
    random: false,
    randomBetween: false,
    easing: "linear",
    advanced: false,
};

export const MAX_COLOR_KEYS = 6;

export const DEFAULT_PARAMS = Object.fromEntries(PARAM_FIELDS.map((f) => [f.key, f.default]));
export const DEFAULT_PARAMS_WITH_MOTION = {
    ...DEFAULT_PARAMS,
    motionMode: "velocity",
    pathTension: 0.5,
    pathDivergence: 0.25,
    pathDivergenceStart: 1.0,
    pathDivergenceEnd: 0.2,
    pathFollowMode: "tube",
    pathSpiralTurns: 1.5,
    pathSpiralRadius: 0.4,
    spawnShape: "sphere",
    spawnRadius: 0,
    collisionMode: "none",
    groundY: 0,
    boundsSize: 1,
    boundsWidth: 1,
    boundsHeight: 1,
    boundsDepth: 1,
    boundsRadius: 1,
    bounce: 0.35,
    groundFriction: 0.2,
    selfCollide: 0,
    boidsNeighborRadius: 2.0,
    boidsSeparation: 0.3,
    boidsAlignment: 2.0,
    boidsCohesion: 4.0,
    boidsMaxSpeed: 5.0,
    hairLength: 0.6,
    hairSegments: 8,
    hairStiffness: 0.78,
    hairGravity: 1.0,
    hairGrowth: 0.65,
    hairRandomTilt: 0.35,
    fluidGridSize: 128,
    fluidEmitStrength: 1,
    fluidEnclosed: true,
    fluidVorticity: false,
    fluidCameraSpin: true,
    fluidSpeed: 1,
    fluidSmokeDecay: 0.35,
    fluidPressureIterations: 4,
    fluidBuoyancy: 0.5,
    fluidBurnRate: 0.8,
    fluidIgnitionTemp: 0,
    fluidVorticityAmount: 1,
    fluidCameraDistance: 2.5,
    fluidStiffness: 30,
    fluidRestDensity: 1.5,
    fluidViscosity: 0.1,
    ...DEFAULT_NOISE,
};

// WGSL SimUniforms: scalar tail ends at noiseLayerCount (byte 420); the noise
// layer array (array<vec4f, 8> = 4 layers x 32 bytes) is 16-byte aligned at 432,
// ending at 560. Struct alignment (16) keeps the total at 560.
export const SIM_UNIFORM_BYTES = 560;

const EASING_INDEX = Object.fromEntries(EASINGS.map((e, i) => [e.id, i]));

const SIM_OFF = {
    count: 0, dt: 4, time: 8, gravity: 12, emitterPos: 16,
    spawnRadius: 28, drag: 32, emitSpread: 36, motionMode: 40,
    lifeStartMin: 44, sizeStartMin: 68, opacityStartMin: 92,
    velocityXStartMin: 116, velocityYStartMin: 140, velocityZStartMin: 164,
    colorStart: 192, colorEnd: 208, colorRandom: 220, colorRandomBetween: 224, colorEasing: 228,
    colorKeyCount: 232, colorKey0: 256,
    emitShape: 320, collisionMode: 324, groundY: 328, bounce: 332,
    groundFriction: 336, boundsHalfX: 340, boundsHalfY: 344, boundsHalfZ: 348, boundsRadius: 352,
    selfCollide: 356, boidsNeighborRadius: 360, boidsSeparation: 364, boidsAlignment: 368,
    boidsCohesion: 372, boidsMaxSpeed: 376,
    hairLength: 380, hairSegments: 384, hairStiffness: 388,
    hairGravity: 392, hairGrowth: 396, hairRandomTilt: 400,
    fluidGridSize: 404, fluidStiffness: 408, fluidRestDensity: 412, fluidViscosity: 416,
    noiseLayerCount: 420, noiseLayers: 432,
};

/** Bytes per packed noise layer in the uniform buffer (2 x vec4f). */
const NOISE_LAYER_STRIDE = 32;

export function motionModeIndex(mode) {
    if (mode === "spline") return 1;
    if (mode === "boids") return 2;
    if (mode === "hair") return 3;
    if (mode === "fluid") return 4;
    return 0;
}

export function easingIndex(id) {
    return EASING_INDEX[id] ?? 0;
}

export function evaluateEase(t, easingId) {
    const c = Math.max(0, Math.min(1, t));
    switch (easingId) {
        case "easeIn":
        case "easeInQuad": return c * c;
        case "easeOut":
        case "easeOutQuad": { const u = 1 - c; return 1 - u * u; }
        case "easeInOut":
        case "easeInOutQuad":
            if (c < 0.5) return 2 * c * c;
            { const u = -2 * c + 2; return 1 - u * u * 0.5; }
        default: return c;
    }
}

export function normalizeKeys(keys) {
    const sorted = [...keys]
        .map((k) => ({ t: Number(k.t), min: Number(k.min), max: Number(k.max) }))
        .sort((a, b) => a.t - b.t);
    if (sorted.length) {
        sorted[0].t = 0;
        sorted[sorted.length - 1].t = 1;
    }
    return sorted.slice(0, MAX_KEYS);
}

export function keysToLegacy(curve) {
    const keys = normalizeKeys(curve.keys || []);
    const k0 = keys[0] || { min: 0, max: 0 };
    const kN = keys[keys.length - 1] || k0;
    return {
        keys,
        startMin: k0.min,
        startMax: k0.max,
        endMin: kN.min,
        endMax: kN.max,
        random: !!curve.random,
        easing: curve.easing || "linear",
    };
}

export function legacyToKeys(curve) {
    if (curve.keys?.length) {
        return mergeKeyframeCurve(curve, keyframe(0, 0, 0, 0, false, "linear"));
    }
    return mergeKeyframeCurve({
        keys: [
            { t: 0, min: curve.startMin ?? 0, max: curve.startMax ?? 0 },
            { t: 1, min: curve.endMin ?? 0, max: curve.endMax ?? 0 },
        ],
        random: curve.random,
        easing: curve.easing,
    }, keyframe(0, 0, 0, 0, false, "linear"));
}

export function mergeKeyframeCurve(curve, fallback) {
    const base = { ...fallback, ...(curve || {}) };
    const merged = {
        keys: normalizeKeys(base.keys || fallback.keys),
        random: !!base.random,
        easing: EASING_INDEX[base.easing] !== undefined ? base.easing : fallback.easing,
    };
    merged.advanced = inferScalarAdvanced({ ...merged, advanced: base.advanced });
    return merged;
}

/** @deprecated use mergeKeyframeCurve */
export function mergeScalarCurve(curve, fallback) {
    return keysToLegacy(legacyToKeys(curve || fallback));
}

export function mergeVelocityCurve(velocity) {
    const base = { ...DEFAULT_VELOCITY, ...(velocity || {}) };
    const channels = {};
    for (const ch of ["x", "y", "z"]) {
        const src = base.channels?.[ch] || DEFAULT_VELOCITY.channels[ch];
        if (src.keys?.length) {
            channels[ch] = { keys: normalizeKeys(src.keys) };
        } else {
            channels[ch] = { keys: normalizeKeys([
                { t: 0, min: src.startMin ?? 0, max: src.startMax ?? 0 },
                { t: 1, min: src.endMin ?? 0, max: src.endMax ?? 0 },
            ]) };
        }
    }
    return {
        random: base.random ?? DEFAULT_VELOCITY.random,
        easing: EASING_INDEX[base.easing] !== undefined ? base.easing : DEFAULT_VELOCITY.easing,
        channels,
    };
}

export function velocityToLegacy(velocity) {
    const v = mergeVelocityCurve(velocity);
    const mk = (keys) => keysToLegacy({ keys, random: v.random, easing: v.easing });
    return {
        velocityX: mk(v.channels.x.keys),
        velocityY: mk(v.channels.y.keys),
        velocityZ: mk(v.channels.z.keys),
    };
}

export function normalizeColorKeys(keys, opts = {}) {
    const { lockEndpoints = true } = opts;
    const sorted = [...keys]
        .map((k) => ({ t: Number(k.t), color: k.color || "#ffffff" }))
        .sort((a, b) => a.t - b.t);
    if (sorted.length && lockEndpoints) {
        sorted[0].t = 0;
        sorted[sorted.length - 1].t = 1;
    }
    return sorted.slice(0, MAX_COLOR_KEYS);
}

export function mergeColorCurve(curve) {
    const base = { ...DEFAULT_COLOR_CURVE, ...(curve || {}) };
    let keys = base.keys;
    if (!keys?.length) {
        keys = [
            { t: 0, color: base.start || DEFAULT_COLOR_CURVE.keys[0].color },
            { t: 1, color: base.end || DEFAULT_COLOR_CURVE.keys[1].color },
        ];
    }
    return {
        keys: normalizeColorKeys(keys),
        random: !!base.random,
        randomBetween: !!base.randomBetween,
        easing: EASING_INDEX[base.easing] !== undefined ? base.easing : DEFAULT_COLOR_CURVE.easing,
        advanced: inferColorAdvanced({ ...base, keys: normalizeColorKeys(keys) }),
    };
}

export function mergeParams(params = {}) {
    const merged = { ...DEFAULT_PARAMS_WITH_MOTION, ...(params || {}) };
    for (const field of PARAM_FIELDS) {
        if (merged[field.key] === undefined) merged[field.key] = field.default;
    }
    if (!["velocity", "spline", "boids", "hair", "fluid"].includes(merged.motionMode)) merged.motionMode = "velocity";
    merged.collisionMode = normalizeCollisionMode(merged);
    if (merged.motionMode === "hair") {
        if (!merged.spawnShape || merged.spawnShape === "sphere") merged.spawnShape = "plane";
        if (!merged.spawnRadius) merged.spawnRadius = 1;
    }
    if (merged.boundsSize === undefined) merged.boundsSize = 1;
    Object.assign(merged, mergeBoundsHalf(merged));
    if (merged.spawnShape === undefined) merged.spawnShape = merged.emitShape ?? "sphere";
    if (merged.spawnRadius === undefined) merged.spawnRadius = merged.emitShapeSize ?? 0;
    if (merged.bounce === undefined) merged.bounce = merged.groundBounce ?? 0.35;
    return { ...merged, ...mergeNoiseParams(merged) };
}

export function mergeCurves(curves = {}) {
    const merged = {};
    for (const def of SCALAR_CURVES) {
        merged[def.key] = legacyToKeys(curves[def.key] || def.default);
    }
    merged.color = mergeColorCurve(curves.color);
    merged.velocity = mergeVelocityCurve(curves.velocity);
    merged.rotation = mergeRotationCurve(curves.rotation);
    return merged;
}

export function migrateEffect(effect) {
    const out = { ...effect, version: 2 };
    out.params = mergeParams(effect.params);
    out.curves = mergeCurves(effect.curves);
    if (!out.path) {
        out.path = {
            points: [{ x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }],
            tension: 0.5,
            divergence: 0.25,
            divergenceStart: 1.0,
            divergenceEnd: 0.2,
            followMode: "tube",
            spiralTurns: 1.5,
            spiralRadius: 0.4,
        };
    }
    if (!out.curves.velocity) {
        out.curves.velocity = mergeVelocityCurve(null);
    }
    if (!out.curves.rotation) {
        out.curves.rotation = mergeRotationCurve(null);
    }
    if (effect.render?.particleRotation) {
        const deg = Number(effect.render.particleRotation) * (180 / Math.PI);
        if (deg !== 0) {
            out.curves.rotation = rotationSimpleCurve(deg);
        }
    }
    if (!out.params.motionMode) {
        out.params.motionMode = "velocity";
    }
    out.render = mergeRender(effect.render);

    if (effect.version === 1 || !effect.curves) {
        const p = effect.params || {};
        if (p.spawnLifeMin !== undefined) {
            out.curves.life.keys[0].min = p.spawnLifeMin;
            out.curves.life.keys[0].max = p.spawnLifeMax ?? p.spawnLifeMin;
        }
        if (p.spawnUpMin !== undefined) {
            /* legacy velocity — path editor replaces this */
        }
        if (p.particleSize !== undefined) {
            out.curves.size.keys[0].min = p.particleSize;
            out.curves.size.keys[0].max = p.particleSize;
        }
        if (p.colorR !== undefined) {
            out.curves.color.keys[0].color = rgbToHex(p.colorR, p.colorG ?? 0.55, p.colorB ?? 0.12);
        }
    }
    return out;
}

function writeColorKeys(view, offset, curve) {
    const keys = normalizeColorKeys(curve.keys).slice(0, 4);
    view.setFloat32(SIM_OFF.colorKeyCount, keys.length, true);
    for (let i = 0; i < 4; i++) {
        const k = keys[i] || keys[keys.length - 1] || { t: 0, color: "#ffffff" };
        const rgb = hexToRgb(k.color);
        const o = SIM_OFF.colorKey0 + i * 16;
        view.setFloat32(o, k.t, true);
        view.setFloat32(o + 4, rgb[0], true);
        view.setFloat32(o + 8, rgb[1], true);
        view.setFloat32(o + 12, rgb[2], true);
    }
}

function writeScalarCurve(view, offset, curve) {
    const leg = keysToLegacy(curve);
    view.setFloat32(offset, leg.startMin, true);
    view.setFloat32(offset + 4, leg.startMax, true);
    view.setFloat32(offset + 8, leg.endMin, true);
    view.setFloat32(offset + 12, leg.endMax, true);
    view.setFloat32(offset + 16, leg.random ? 1 : 0, true);
    view.setFloat32(offset + 20, easingIndex(leg.easing), true);
}

export function packSimUniforms({ count, dt, time, emitterPos, params, curves }) {
    const buf = new ArrayBuffer(SIM_UNIFORM_BYTES);
    const view = new DataView(buf);
    const merged = mergeCurves(curves);

    view.setUint32(SIM_OFF.count, count, true);
    view.setFloat32(SIM_OFF.dt, dt, true);
    view.setFloat32(SIM_OFF.time, time, true);
    view.setFloat32(SIM_OFF.gravity, Number.isFinite(params.gravity) ? params.gravity : 0, true);
    view.setFloat32(SIM_OFF.emitterPos, emitterPos[0], true);
    view.setFloat32(SIM_OFF.emitterPos + 4, emitterPos[1], true);
    view.setFloat32(SIM_OFF.emitterPos + 8, emitterPos[2], true);
    view.setFloat32(SIM_OFF.spawnRadius, params.spawnRadius ?? 0, true);
    view.setFloat32(SIM_OFF.drag, params.drag, true);
    view.setFloat32(SIM_OFF.emitSpread, params.emitSpread ?? 3, true);
    view.setFloat32(SIM_OFF.motionMode, motionModeIndex(params.motionMode), true);

    writeScalarCurve(view, SIM_OFF.lifeStartMin, merged.life);
    writeScalarCurve(view, SIM_OFF.sizeStartMin, merged.size);
    writeScalarCurve(view, SIM_OFF.opacityStartMin, merged.opacity);

    const vel = velocityToLegacy(merged.velocity);
    writeScalarCurve(view, SIM_OFF.velocityXStartMin, vel.velocityX);
    writeScalarCurve(view, SIM_OFF.velocityYStartMin, vel.velocityY);
    writeScalarCurve(view, SIM_OFF.velocityZStartMin, vel.velocityZ);

    const cs = hexToRgb(merged.color.keys[0].color);
    const ce = hexToRgb(merged.color.keys[merged.color.keys.length - 1].color);
    view.setFloat32(SIM_OFF.colorStart, cs[0], true);
    view.setFloat32(SIM_OFF.colorStart + 4, cs[1], true);
    view.setFloat32(SIM_OFF.colorStart + 8, cs[2], true);
    view.setFloat32(SIM_OFF.colorEnd, ce[0], true);
    view.setFloat32(SIM_OFF.colorEnd + 4, ce[1], true);
    view.setFloat32(SIM_OFF.colorEnd + 8, ce[2], true);
    view.setFloat32(SIM_OFF.colorRandom, merged.color.random ? 1 : 0, true);
    view.setFloat32(SIM_OFF.colorRandomBetween, merged.color.randomBetween ? 1 : 0, true);
    view.setFloat32(SIM_OFF.colorEasing, easingIndex(merged.color.easing), true);
    writeColorKeys(view, SIM_OFF.colorKey0, merged.color);

    const spawnShapeIndex = { point: 0, sphere: 1, box: 2, plane: 3 };
    const spawnShape = params.spawnShape ?? params.emitShape ?? "sphere";
    view.setFloat32(SIM_OFF.emitShape, spawnShapeIndex[spawnShape] ?? 1, true);
    view.setFloat32(SIM_OFF.collisionMode, collisionModeIndex(params.collisionMode), true);
    view.setFloat32(SIM_OFF.groundY, params.groundY ?? 0, true);
    view.setFloat32(SIM_OFF.bounce, params.bounce ?? params.groundBounce ?? 0.35, true);
    view.setFloat32(SIM_OFF.groundFriction, params.groundFriction ?? 0.2, true);
    const bounds = mergeBoundsHalf(params);
    view.setFloat32(SIM_OFF.boundsHalfX, bounds.boundsHalfX, true);
    view.setFloat32(SIM_OFF.boundsHalfY, bounds.boundsHalfY, true);
    view.setFloat32(SIM_OFF.boundsHalfZ, bounds.boundsHalfZ, true);
    view.setFloat32(SIM_OFF.boundsRadius, bounds.boundsRadius, true);
    view.setFloat32(SIM_OFF.selfCollide, params.selfCollide ? 1 : 0, true);
    view.setFloat32(SIM_OFF.boidsNeighborRadius, params.boidsNeighborRadius ?? 2.0, true);
    view.setFloat32(SIM_OFF.boidsSeparation, params.boidsSeparation ?? 0.3, true);
    view.setFloat32(SIM_OFF.boidsAlignment, params.boidsAlignment ?? 2.0, true);
    view.setFloat32(SIM_OFF.boidsCohesion, params.boidsCohesion ?? 4.0, true);
    view.setFloat32(SIM_OFF.boidsMaxSpeed, params.boidsMaxSpeed ?? 5.0, true);
    view.setFloat32(SIM_OFF.hairLength, params.hairLength ?? 0.6, true);
    view.setFloat32(SIM_OFF.hairSegments, params.hairSegments ?? 8, true);
    view.setFloat32(SIM_OFF.hairStiffness, params.hairStiffness ?? 0.78, true);
    view.setFloat32(SIM_OFF.hairGravity, params.hairGravity ?? 1.0, true);
    view.setFloat32(SIM_OFF.hairGrowth, params.hairGrowth ?? 0.65, true);
    view.setFloat32(SIM_OFF.hairRandomTilt, params.hairRandomTilt ?? 0.35, true);
    view.setFloat32(SIM_OFF.fluidGridSize, params.fluidGridSize ?? 32, true);
    view.setFloat32(SIM_OFF.fluidStiffness, params.fluidStiffness ?? 50, true);
    view.setFloat32(SIM_OFF.fluidRestDensity, params.fluidRestDensity ?? 1.5, true);
    view.setFloat32(SIM_OFF.fluidViscosity, params.fluidViscosity ?? 0.1, true);

    const noise = packNoiseLayers(params);
    view.setFloat32(SIM_OFF.noiseLayerCount, noise.count, true);
    for (let i = 0; i < noise.layers.length && i < 4; i++) {
        const L = noise.layers[i];
        const o = SIM_OFF.noiseLayers + i * NOISE_LAYER_STRIDE;
        view.setFloat32(o, L.type, true);
        view.setFloat32(o + 4, L.frequency, true);
        view.setFloat32(o + 8, L.amplitude, true);
        view.setFloat32(o + 12, L.speed, true);
        view.setFloat32(o + 16, L.octaves, true);
        view.setFloat32(o + 20, L.targets, true);
        view.setFloat32(o + 24, L.seed, true);
    }

    return buf;
}

export function hexToRgb(hex) {
    const h = (hex || "#ffffff").replace("#", "");
    const n = h.length === 3
        ? h.split("").map((c) => parseInt(c + c, 16))
        : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    return [n[0] / 255, n[1] / 255, n[2] / 255];
}

export function rgbToHex(r, g, b) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
}

export function sampleCurveAt(keys, t, easing, random) {
    const k = normalizeKeys(keys);
    if (k.length < 2) return k[0]?.min ?? 0;
    let seg = 0;
    for (let i = 0; i < k.length - 1; i++) {
        if (t >= k[i].t && t <= k[i + 1].t) { seg = i; break; }
        if (i === k.length - 2) seg = i;
    }
    const a = k[seg];
    const b = k[seg + 1];
    const localT = (t - a.t) / Math.max(b.t - a.t, 1e-4);
    const e = evaluateEase(localT, easing);
    const mn = a.min + (b.min - a.min) * e;
    const mx = a.max + (b.max - a.max) * e;
    return random ? (mn + mx) * 0.5 : mn;
}

export function drawScalarKeyGraph(canvas, curve, activeKey, curveKey) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const pad = 8;
    const keys = normalizeKeys(curve.keys);
    const vals = keys.flatMap((k) => [k.min, k.max]);
    const { yMin, yMax } = computeGraphYRange(vals, curveKey);
    const toX = (t) => pad + t * (w - pad * 2);
    const toY = (v) => h - pad - ((v - yMin) / (yMax - yMin)) * (h - pad * 2);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0a1018";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#1e2a3a";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = pad + (i / 4) * (h - pad * 2);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
        const x = pad + (i / 4) * (w - pad * 2);
        ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, h - pad); ctx.stroke();
    }

    if (curve.random) {
        ctx.fillStyle = "rgba(240, 165, 0, 0.12)";
        ctx.beginPath();
        keys.forEach((k, i) => {
            const x = toX(k.t);
            if (i === 0) ctx.moveTo(x, toY(k.min));
            else ctx.lineTo(x, toY(k.min));
        });
        for (let i = keys.length - 1; i >= 0; i--) ctx.lineTo(toX(keys[i].t), toY(keys[i].max));
        ctx.closePath();
        ctx.fill();
    }

    ctx.strokeStyle = "rgba(240, 165, 0, 0.45)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    keys.forEach((k, i) => {
        const x = toX(k.t);
        if (i === 0) { ctx.moveTo(x, toY(k.min)); ctx.moveTo(x, toY(k.max)); }
        else { ctx.lineTo(x, toY(k.min)); ctx.moveTo(x, toY(k.max)); }
    });
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "#f0a500";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let s = 0; s <= 48; s++) {
        const t = s / 48;
        const v = sampleCurveAt(keys, t, curve.easing, false);
        const x = toX(t);
        const y = toY(v);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    keys.forEach((k, i) => {
        const cx = toX(k.t);
        ctx.fillStyle = i === activeKey ? "#fff" : "#f0a500";
        ctx.beginPath(); ctx.arc(cx, toY((k.min + k.max) * 0.5), 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath(); ctx.arc(cx, toY(k.min), 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(cx, toY(k.max), 3, 0, Math.PI * 2); ctx.fill();
    });

    ctx.fillStyle = "#666";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("0", 2, h - 2);
    ctx.fillText("life →", w - 34, h - 2);
}

const VEL_COLORS = { x: "#e55", y: "#5c5", z: "#59f" };

export function drawVelocityGraph(canvas, vel, state) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const pad = 8;
    const visible = state?.visible ?? { x: false, y: true, z: false };
    const vals = [];
    for (const ch of ["x", "y", "z"]) {
        if (!visible[ch]) continue;
        vals.push(...vel.channels[ch].keys.flatMap((k) => [k.min, k.max]));
    }
    if (!vals.length) vals.push(0, 1);
    let yMin = Math.min(...vals);
    let yMax = Math.max(...vals);
    if (Math.abs(yMax - yMin) < 1e-6) { yMin -= 1; yMax += 1; }
    const py = (yMax - yMin) * 0.12 || 0.1;
    yMin -= py; yMax += py;
    const toX = (t) => pad + t * (w - pad * 2);
    const toY = (v) => h - pad - ((v - yMin) / (yMax - yMin)) * (h - pad * 2);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0a1018";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#1e2a3a";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = pad + (i / 4) * (h - pad * 2);
        ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
    }

    for (const ch of ["x", "y", "z"]) {
        if (!visible[ch]) continue;
        const keys = vel.channels[ch].keys;
        const col = VEL_COLORS[ch];
        const active = state?.channel === ch;

        if (vel.random && state?.channel === ch) {
            ctx.fillStyle = col + "33";
            ctx.beginPath();
            keys.forEach((k, i) => {
                const x = toX(k.t);
                if (i === 0) ctx.moveTo(x, toY(k.min));
                else ctx.lineTo(x, toY(k.min));
            });
            for (let i = keys.length - 1; i >= 0; i--) ctx.lineTo(toX(keys[i].t), toY(keys[i].max));
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = col + "88";
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            keys.forEach((k, i) => {
                const x = toX(k.t);
                if (i === 0) { ctx.moveTo(x, toY(k.min)); ctx.moveTo(x, toY(k.max)); }
                else { ctx.lineTo(x, toY(k.min)); ctx.moveTo(x, toY(k.max)); }
            });
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.strokeStyle = col;
        ctx.lineWidth = active ? 2.5 : 1.5;
        ctx.beginPath();
        for (let s = 0; s <= 48; s++) {
            const t = s / 48;
            const v = sampleCurveAt(keys, t, vel.easing, false);
            const x = toX(t);
            const y = toY(v);
            if (s === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();

        keys.forEach((k, i) => {
            const cx = toX(k.t);
            const sel = state?.drag?.channel === ch && state?.drag?.keyIndex === i;
            ctx.fillStyle = sel ? "#fff" : col;
            ctx.beginPath(); ctx.arc(cx, toY((k.min + k.max) * 0.5), sel ? 5 : 4, 0, Math.PI * 2); ctx.fill();
            if (vel.random) {
                ctx.fillStyle = sel ? "#fff" : "rgba(255,255,255,0.85)";
                ctx.beginPath(); ctx.arc(cx, toY(k.min), 3, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.arc(cx, toY(k.max), 3, 0, Math.PI * 2); ctx.fill();
            }
        });
    }

    ctx.fillStyle = "#666";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("0", 2, h - 2);
    ctx.fillText("life →", w - 34, h - 2);
    const legend = ["x", "y", "z"].filter((ch) => visible[ch]).map((ch) => ch.toUpperCase()).join(" · ");
    if (legend) ctx.fillText(legend, pad, 10);
}

export function sampleColorAt(keys, t, easing) {
    const k = normalizeColorKeys(keys);
    if (k.length < 2) return k[0]?.color ?? "#ffffff";
    let seg = 0;
    for (let i = 0; i < k.length - 1; i++) {
        if (t >= k[i].t && t <= k[i + 1].t) { seg = i; break; }
        if (i === k.length - 2) seg = i;
    }
    const a = k[seg];
    const b = k[seg + 1];
    const localT = (t - a.t) / Math.max(b.t - a.t, 1e-4);
    const e = evaluateEase(localT, easing);
    const ca = hexToRgb(a.color);
    const cb = hexToRgb(b.color);
    return rgbToHex(
        ca[0] + (cb[0] - ca[0]) * e,
        ca[1] + (cb[1] - ca[1]) * e,
        ca[2] + (cb[2] - ca[2]) * e,
    );
}

export function drawColorCurveGraph(canvas, curve, activeKey) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    const pad = 8;
    const keys = normalizeColorKeys(curve.keys);
    const barTop = 14;
    const barH = 26;
    const toX = (t) => pad + t * (w - pad * 2);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0a1018";
    ctx.fillRect(0, 0, w, h);

    const grad = ctx.createLinearGradient(pad, 0, w - pad, 0);
    for (let s = 0; s <= 32; s++) {
        const t = s / 32;
        grad.addColorStop(t, sampleColorAt(keys, t, curve.easing));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(pad, barTop, w - pad * 2, barH);
    ctx.strokeStyle = "#333";
    ctx.strokeRect(pad, barTop, w - pad * 2, barH);

    ctx.strokeStyle = "#f0a500";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
        const t = i / 40;
        const y = barTop + barH + 18 - 10 * evaluateEase(t, curve.easing);
        const x = toX(t);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    keys.forEach((k, i) => {
        const cx = toX(k.t);
        const cy = barTop + barH + 8;
        ctx.fillStyle = i === activeKey ? "#fff" : "#f0a500";
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = k.color;
        ctx.fillRect(cx - 4, barTop + 2, 8, barH - 4);
    });

    ctx.fillStyle = "#666";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("0", 2, h - 2);
    ctx.fillText("life →", w - 34, h - 2);
}

export function curveRowHtml(key, label, curve, step) {
    const merged = mergeKeyframeCurve(curve, constantScalarCurve(0));
    const advanced = merged.advanced;
    const simpleVal = scalarSimpleValue(merged);
    const k0 = merged.keys[0];
    const kN = merged.keys[merged.keys.length - 1];
    const easingOpts = EASINGS.map((e) =>
        `<option value="${e.id}"${merged.easing === e.id ? " selected" : ""}>${e.label}</option>`).join("");
    const minAttr = key === "opacity" ? ' min="0" max="1"' : key === "size" || key === "life" ? ' min="0"' : "";

    return `
    <div class="curve-block" data-curve="${key}" data-step="${step}" data-advanced="${advanced ? "1" : "0"}" data-keys='${JSON.stringify(merged.keys)}'>
        <div class="curve-head">
            <span class="curve-label">${label}</span>
            <button type="button" class="btn-graph-toggle" data-action="toggle-advanced" title="Show curve editor" aria-label="Show curve editor">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M1 10 L4 6 L7 8 L11 3 L13 5 L13 12 L1 12 Z"/></svg>
            </button>
            <input class="curve-simple-value" type="number" step="${step}" data-f="simpleValue" value="${simpleVal}"${minAttr} />
        </div>
        ${key === "life" ? '<p class="curve-hint curve-hint-simple">0 = infinite lifetime</p>' : ""}
        ${key === "size" ? '<p class="curve-hint curve-hint-simple">Render size only for fluid (physics matches three.js unit mass)</p>' : ""}
        <div class="curve-advanced${advanced ? "" : " hidden"}">
            <div class="curve-head curve-head-advanced">
                <label class="chk"><input type="checkbox" data-f="random" ${merged.random ? "checked" : ""} /> Random</label>
                <select class="curve-preset" data-action="preset" title="Apply a shape preset">
                    <option value="">Shape…</option>
                    <option value="ramp-up">Ramp up</option>
                    <option value="ramp-down">Ramp down</option>
                    <option value="bell">Bell</option>
                    <option value="spike">Spike</option>
                    <option value="constant">Flat</option>
                </select>
                <button type="button" class="btn-mini" data-action="add-key" title="Add key">+</button>
                <button type="button" class="btn-mini" data-action="del-key" title="Remove last key">−</button>
            </div>
            <canvas class="curve-graph" width="320" height="124"></canvas>
            <div class="kv-grid">
                <label>Start min<input type="number" step="${step}" data-f="startMin" value="${k0.min}"${minAttr} /></label>
                <label>Start max<input type="number" step="${step}" data-f="startMax" value="${k0.max}"${minAttr} /></label>
                <label>End min<input type="number" step="${step}" data-f="endMin" value="${kN.min}"${minAttr} /></label>
                <label>End max<input type="number" step="${step}" data-f="endMax" value="${kN.max}"${minAttr} /></label>
            </div>
            <div class="field compact"><label>Easing</label><select data-f="easing">${easingOpts}</select></div>
            <p class="curve-hint">Click + or dbl-click graph to add key · drag keys</p>
            ${key === "life" ? '<p class="curve-hint">0 = infinite lifetime (particles live until emitter is removed)</p>' : ""}
        </div>
    </div>`;
}

export function rotationCurveHtml(curve) {
    const merged = mergeRotationCurve(curve);
    const advanced = merged.advanced;
    const simpleVal = merged.keys[merged.keys.length - 1]?.min ?? 0;
    const k0 = merged.keys[0];
    const kN = merged.keys[merged.keys.length - 1];
    const easingOpts = EASINGS.map((e) =>
        `<option value="${e.id}"${merged.easing === e.id ? " selected" : ""}>${e.label}</option>`).join("");
    const step = ROTATION_CURVE.step;

    return `
    <div class="curve-block" data-curve="rotation" data-step="${step}" data-advanced="${advanced ? "1" : "0"}" data-keys='${JSON.stringify(merged.keys)}'>
        <div class="curve-head">
            <span class="curve-label">${ROTATION_CURVE.label}</span>
            <button type="button" class="btn-graph-toggle" data-action="toggle-advanced" title="Show curve editor" aria-label="Show curve editor">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M1 10 L4 6 L7 8 L11 3 L13 5 L13 12 L1 12 Z"/></svg>
            </button>
            <input class="curve-simple-value" type="number" step="${step}" data-f="simpleValue" value="${simpleVal}" title="Total degrees rotated over lifetime" />
            <span class="curve-unit">°</span>
        </div>
        <div class="curve-advanced${advanced ? "" : " hidden"}">
            <div class="curve-head curve-head-advanced">
                <label class="chk"><input type="checkbox" data-f="random" ${merged.random ? "checked" : ""} /> Random</label>
                <select class="curve-preset" data-action="preset" title="Apply a shape preset">
                    <option value="">Shape…</option>
                    <option value="ramp-up">Ramp up</option>
                    <option value="ramp-down">Ramp down</option>
                    <option value="bell">Bell</option>
                    <option value="spike">Spike</option>
                    <option value="constant">Flat</option>
                </select>
                <button type="button" class="btn-mini" data-action="add-key" title="Add key">+</button>
                <button type="button" class="btn-mini" data-action="del-key" title="Remove last key">−</button>
            </div>
            <canvas class="curve-graph" width="320" height="124"></canvas>
            <div class="kv-grid">
                <label>Start min °<input type="number" step="${step}" data-f="startMin" value="${k0.min}" /></label>
                <label>Start max °<input type="number" step="${step}" data-f="startMax" value="${k0.max}" /></label>
                <label>End min °<input type="number" step="${step}" data-f="endMin" value="${kN.min}" /></label>
                <label>End max °<input type="number" step="${step}" data-f="endMax" value="${kN.max}" /></label>
            </div>
            <div class="field compact"><label>Easing</label><select data-f="easing">${easingOpts}</select></div>
            <p class="curve-hint">Angle in degrees over lifetime · random varies start/end per particle</p>
        </div>
        <p class="curve-hint curve-hint-simple">Simple value = total rotation from spawn to death (degrees)</p>
    </div>`;
}

export function velocityCurveHtml(velocity) {
    const v = mergeVelocityCurve(velocity);
    const easingOpts = EASINGS.map((e) =>
        `<option value="${e.id}"${v.easing === e.id ? " selected" : ""}>${e.label}</option>`).join("");
    const ch = "y";
    const keys = v.channels[ch].keys;
    const keyOpts = keys.map((_, i) => `<option value="${i}">Key ${i + 1}</option>`).join("");
    const k = keys[0];

    return `
    <div class="curve-block" data-curve="velocity" data-advanced="0" data-velocity='${JSON.stringify(v).replace(/'/g, "&#39;")}'>
        <div class="curve-head">
            <span class="curve-label">Velocity</span>
            <button type="button" class="btn-graph-toggle" data-action="toggle-advanced" title="Show curve editor" aria-label="Show curve editor">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M1 10 L4 6 L7 8 L11 3 L13 5 L13 12 L1 12 Z"/></svg>
            </button>
        </div>
        <div class="curve-advanced hidden">
            <div class="curve-head curve-head-advanced">
                <label class="chk"><input type="checkbox" data-f="random" ${v.random ? "checked" : ""} /> Random</label>
                <button type="button" class="btn-mini" data-action="add-key" title="Add key">+</button>
                <button type="button" class="btn-mini" data-action="del-key" title="Remove last key">−</button>
            </div>
            <div class="channel-tabs">
                <button type="button" class="channel-btn" data-channel="x" title="Toggle X axis">X</button>
                <button type="button" class="channel-btn active" data-channel="y" title="Toggle Y axis">Y</button>
                <button type="button" class="channel-btn" data-channel="z" title="Toggle Z axis">Z</button>
            </div>
            <canvas class="curve-graph vel-graph" width="320" height="150"></canvas>
            <div class="kv-grid">
                <label>Time<input type="number" step="0.01" min="0" max="1" data-f="keyTime" value="${k.t}" /></label>
                <label>Min<input type="number" step="0.1" data-f="keyMin" value="${k.min}" /></label>
                <label>Max<input type="number" step="0.1" data-f="keyMax" value="${k.max}" /></label>
                <label>Key<select data-sel-key>${keyOpts}</select></label>
            </div>
            <div class="field compact"><label>Easing</label><select data-f="easing">${easingOpts}</select></div>
            <p class="curve-hint">X/Y/Z toggles show/hide axis · dbl-click adds key on active axis</p>
        </div>
    </div>`;
}

export function colorCurveHtml(curve) {
    const c = mergeColorCurve(curve);
    const advanced = c.advanced;
    const simpleColor = c.keys[0]?.color ?? "#ffffff";
    const easingOpts = EASINGS.map((e) =>
        `<option value="${e.id}"${c.easing === e.id ? " selected" : ""}>${e.label}</option>`).join("");
    const keyOpts = c.keys.map((_, i) => `<option value="${i}">Key ${i + 1}</option>`).join("");
    const k = c.keys[0];

    return `
    <div class="curve-block" data-curve="color" data-advanced="${advanced ? "1" : "0"}" data-color-keys='${JSON.stringify(c.keys).replace(/'/g, "&#39;")}'>
        <div class="curve-head">
            <span class="curve-label">Color</span>
            <button type="button" class="btn-graph-toggle" data-action="toggle-advanced" title="Show curve editor" aria-label="Show curve editor">
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path fill="currentColor" d="M1 10 L4 6 L7 8 L11 3 L13 5 L13 12 L1 12 Z"/></svg>
            </button>
            <input class="curve-simple-color" type="color" data-f="simpleColor" value="${simpleColor}" />
        </div>
        <div class="curve-advanced${advanced ? "" : " hidden"}">
            <div class="curve-head curve-head-advanced">
                <label class="chk"><input type="checkbox" data-f="random" ${c.random ? "checked" : ""} /> Random</label>
                <label class="chk"><input type="checkbox" data-f="randomBetween" ${c.randomBetween ? "checked" : ""} /> Between</label>
                <button type="button" class="btn-mini" data-action="add-key" title="Add key">+</button>
                <button type="button" class="btn-mini" data-action="del-key" title="Remove last key">−</button>
            </div>
            <canvas class="curve-graph color-graph" width="320" height="64"></canvas>
            <div class="kv-grid">
                <label>Time<input type="number" step="0.01" min="0" max="1" data-f="keyTime" value="${k.t}" /></label>
                <label>Color<input type="color" data-f="keyColor" value="${k.color}" /></label>
                <label>Key<select data-sel-key>${keyOpts}</select></label>
            </div>
            <div class="field compact"><label>Easing</label><select data-f="easing">${easingOpts}</select></div>
            <p class="curve-hint">Dbl-click to add stop · drag to move · first/last stay at 0 and 1</p>
        </div>
    </div>`;
}

export function readRotationBlock(block) {
    if (block.dataset.advanced !== "1") {
        const el = block.querySelector('[data-f="simpleValue"]');
        const v = parseFloat(el?.value);
        const degrees = Number.isNaN(v) ? 0 : v;
        return rotationSimpleCurve(degrees);
    }
    return readScalarBlock(block, ROTATION_CURVE.default);
}

export function readScalarBlock(block, fallback) {
    const def = SCALAR_CURVES.find((c) => c.key === block.dataset.curve);
    const fb = def?.default || fallback || constantScalarCurve(0);
    if (block.dataset.advanced !== "1") {
        const el = block.querySelector('[data-f="simpleValue"]');
        const v = parseFloat(el?.value);
        const value = Number.isNaN(v) ? scalarSimpleValue(fb) : v;
        return constantScalarCurve(value);
    }
    let keys = fb.keys;
    try {
        if (block.dataset.keys) keys = JSON.parse(block.dataset.keys);
    } catch (_) { /* ignore */ }
    const curve = { keys, random: false, easing: "linear", advanced: true };
    block.querySelectorAll("[data-f]").forEach((el) => {
        const f = el.dataset.f;
        if (f === "random") curve.random = el.checked;
        else if (f === "easing") curve.easing = el.value;
    });
    return mergeKeyframeCurve(curve, fb);
}

export function readVelocityBlock(block) {
    let vel = DEFAULT_VELOCITY;
    try {
        if (block.dataset.velocity) vel = JSON.parse(block.dataset.velocity);
    } catch (_) { /* ignore */ }
    block.querySelectorAll('[data-f="random"], [data-f="easing"]').forEach((el) => {
        const f = el.dataset.f;
        if (f === "random") vel.random = el.checked;
        else vel.easing = el.value;
    });
    return mergeVelocityCurve(vel);
}

export function readCurvesFromSidebar(root = document.getElementById("sidebar")) {
    const curves = mergeCurves();
    for (const def of SCALAR_CURVES) {
        const block = root.querySelector(`.curve-block[data-curve="${def.key}"]`);
        if (block) curves[def.key] = readScalarBlock(block, def.default);
    }
    const cBlock = root.querySelector('.curve-block[data-curve="color"]');
    if (cBlock) {
        curves.color = readColorBlock(cBlock);
    }
    const vBlock = root.querySelector('.curve-block[data-curve="velocity"]');
    if (vBlock) {
        curves.velocity = readVelocityBlock(vBlock);
    }
    const rBlock = root.querySelector('.curve-block[data-curve="rotation"]');
    if (rBlock) {
        curves.rotation = readRotationBlock(rBlock);
    }
    return curves;
}

export function readColorBlock(block) {
    if (block.dataset.advanced !== "1") {
        const hex = block.querySelector('[data-f="simpleColor"]')?.value || "#ffffff";
        return mergeColorCurve({
            keys: [{ t: 0, color: hex }, { t: 1, color: hex }],
            random: false,
            randomBetween: false,
            easing: "linear",
            advanced: false,
        });
    }
    let keys = DEFAULT_COLOR_CURVE.keys;
    try {
        if (block.dataset.colorKeys) keys = JSON.parse(block.dataset.colorKeys);
    } catch (_) { /* ignore */ }
    const color = { keys, random: false, randomBetween: false, easing: "linear", advanced: true };
    block.querySelectorAll("[data-f]").forEach((el) => {
        const f = el.dataset.f;
        if (f === "random" || f === "randomBetween") color[f] = el.checked;
        else if (f === "easing") color[f] = el.value;
    });
    return mergeColorCurve(color);
}

export function paintCurveGraphs(root, onChange) {
    import("./curve-ui.js").then((m) => m.setupCurveEditors(root, onChange));
}
