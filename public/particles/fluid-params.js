import { mergeCurves, mergeVelocityCurve, mergeColorCurve, sampleCurveAt, hexToRgb } from "./curves.js";
import { packNoiseUniforms } from "./noise.js";
import { mergeBoundsHalf, normalizeCollisionMode } from "./render.js";

function fluidGridDim(size = 64) {
    const g = Math.round(Number(size) || 64);
    return Math.max(16, Math.min(192, g));
}

function num(v, fallback) {
    const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function curveScalar(curve, t = 0) {
    if (!curve?.keys?.length) return null;
    return sampleCurveAt(curve.keys, t, curve.easing ?? "linear", !!curve.random);
}

const EMIT_SHAPE_INDEX = { point: 0, sphere: 1, box: 2, plane: 3 };

function emitShapeIndex(params) {
    const shape = params.spawnShape ?? params.emitShape ?? "sphere";
    return EMIT_SHAPE_INDEX[shape] ?? 1;
}

function simCoord(worldOffset, halfExtent) {
    const h = Math.max(halfExtent, 0.05);
    return worldOffset / (h * 2);
}

/** Map particle curves / bounds / noise into fluid sim + volume render settings. */
export function paramsToFluidConfig(params = {}, render = {}, curves = {}, emitterWorld = [0, 0, 0]) {
    const merged = mergeCurves(curves);
    const bounds = mergeBoundsHalf(params);
    const halfX = Math.max(bounds.boundsHalfX, 0.05);
    const halfY = Math.max(bounds.boundsHalfY, 0.05);
    const halfZ = Math.max(bounds.boundsHalfZ, 0.05);
    const floorY = params.groundY ?? 0;
    const gridSize = fluidGridDim(params.fluidGridSize ?? 64);
    const ex = num(emitterWorld[0], params.emitterX ?? 0);
    const ey = num(emitterWorld[1], params.emitterY ?? 0);
    const ez = num(emitterWorld[2], params.emitterZ ?? 0);

    const sizeStart = curveScalar(merged.size, 0) ?? 0.125;
    const sizeEnd = curveScalar(merged.size, 1) ?? sizeStart;
    const avgSize = Math.max((sizeStart + sizeEnd) * 0.5, 0.02);

    const opacityStart = curveScalar(merged.opacity, 0) ?? 1;
    const opacityEnd = curveScalar(merged.opacity, 1) ?? opacityStart;
    const avgOpacity = Math.max((opacityStart + opacityEnd) * 0.5, 0.02);

    const colorCurve = mergeColorCurve(curves.color);
    const colorKey = colorCurve.keys?.[0]?.color ?? "#b8c0cc";
    const colorTint = hexToRgb(colorKey);

    const collisionMode = normalizeCollisionMode({ ...params, collisionMode: render.collisionMode ?? params.collisionMode });
    const enclosed = params.fluidEnclosed != null
        ? !!params.fluidEnclosed
        : collisionMode === "box" || collisionMode === "sphere";

    const volumeCenter = [ex, floorY + halfY + ey, ez];
    const spawnRadius = num(params.spawnRadius, 0);
    const avgHalf = (halfX + halfY + halfZ) / 3;
    const sizeRadius = avgSize * 0.45;
    const emitRadius = spawnRadius > 0
        ? Math.max(spawnRadius / (avgHalf * 2), 2 / gridSize)
        : Math.max(sizeRadius, 3 / gridSize);

    const emitPos = [
        simCoord(ex - volumeCenter[0], halfX),
        simCoord(ey - volumeCenter[1], halfY),
        simCoord(ez - volumeCenter[2], halfZ),
    ];
    emitPos[1] = Math.max(emitPos[1], -0.5 + emitRadius * 0.85);

    const velocity = mergeVelocityCurve(curves.velocity);
    const emitVel = [
        sampleCurveAt(velocity.channels.x.keys, 0, velocity.easing, false) * 1.1,
        sampleCurveAt(velocity.channels.y.keys, 0, velocity.easing, false) * 1.1,
        sampleCurveAt(velocity.channels.z.keys, 0, velocity.easing, false) * 1.1,
    ];

    const emitSpread = Math.max(num(params.emitSpread, 3), 0.1);
    const emitStrength = num(params.fluidEmitStrength, 1);
    const volumeOpacity = Math.min(Math.max(avgOpacity, 0.05), 2);
    const densityScale = Math.max(avgSize * 8 * volumeOpacity, 0.15);
    const stepLength = Math.max(1.8 / gridSize, 0.012);
    const byteScale = Math.max(10, densityScale * byteScaleForEmit(emitStrength, volumeOpacity));
    const smokeDecay = Math.max(num(params.fluidSmokeDecay, 0.35), 0);

    const noise = packNoiseUniforms(params);
    if (params.noiseEnabled && noise.noiseAmplitude > 0 && !noise.noiseTargets) {
        noise.noiseTargets = 1;
    }

    return {
        gridSize,
        emitShape: emitShapeIndex(params),
        emitPos,
        emitRadius,
        emitVel,
        enclosed,
        speed: num(params.fluidSpeed, 1),
        smokeDecay,
        velocityDecay: 0.01 + num(params.drag, 0) * 0.4,
        pressureIterations: Math.round(num(params.fluidPressureIterations, 4)),
        vorticityEnabled: !!params.fluidVorticity,
        vorticityAmount: num(params.fluidVorticityAmount, 1),
        buoyancy: num(params.fluidBuoyancy, 1) * 3.5,
        gravity: num(params.gravity, 2) * 0.022,
        burnRate: num(params.fluidBurnRate, 0.8) * 2.5,
        ignitionTemp: num(params.fluidIgnitionTemp, 0),
        emitterStrength: emitStrength * (2.8 / emitSpread),
        stepLength,
        byteScale,
        simulationScale: num(params.fluidSimulationScale, 4),
        camSpin: params.fluidCameraSpin ? 0.4 : 0,
        densityScale,
        volumeOpacity,
        colorTint,
        boundsHalf: [halfX, halfY, halfZ],
        volumeCenter,
        noise,
        drag: num(params.drag, 0),
        showVolumeWire: collisionMode === "none",
    };
}

function byteScaleForEmit(emitStrength, opacity) {
    return Math.max(8, emitStrength * opacity * 22);
}
