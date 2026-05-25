/** @typedef {{ x: number, y: number, z: number }} PathPoint */
/** @typedef {{ points: PathPoint[], tension: number, divergence: number, followMode: string, spiralTurns: number, spiralRadius: number }} PathConfig */

export const MAX_PATH_POINTS = 12;

export const PATH_FOLLOW_MODES = [
    { id: "tube", label: "Tube", hint: "Random ring — cone, stream, or fountain" },
    { id: "spiral", label: "Spiral", hint: "Helix wrapping around the path" },
    { id: "wave", label: "Wave", hint: "Serpentine stream weaving side to side" },
    { id: "ribbon", label: "Ribbon", hint: "Flat sheet along the path" },
    { id: "star", label: "Star", hint: "Pointed star cross-section" },
    { id: "pulse", label: "Pulse", hint: "Breathing bulges along the path" },
];

const FOLLOW_MODE_INDEX = Object.fromEntries(PATH_FOLLOW_MODES.map((m, i) => [m.id, i]));
FOLLOW_MODE_INDEX.straight = 0;

const SHAPE_FIELDS = {
    tube: [],
    spiral: ["pathSpiralTurns", "pathSpiralRadius"],
    wave: ["pathSpiralTurns", "pathSpiralRadius"],
    ribbon: ["pathSpiralRadius"],
    star: ["pathSpiralTurns", "pathSpiralRadius"],
    pulse: ["pathSpiralTurns", "pathSpiralRadius"],
};

const FIELD_LABELS = {
    pathSpiralTurns: {
        spiral: "Turns", wave: "Waves", star: "Points", pulse: "Pulses",
    },
    pathSpiralRadius: {
        spiral: "Radius", wave: "Weave amp", ribbon: "Width", star: "Pointiness", pulse: "Depth",
    },
};

export const PATH_PARAM_FIELDS = [
    { key: "pathTension", label: "Spline tension", step: 0.05, min: 0, max: 1, default: 0.5 },
    { key: "pathDivergence", label: "Max divergence", step: 0.05, min: 0, max: 5, default: 0.25 },
    { key: "pathDivergenceStart", label: "Divergence at start", step: 0.05, min: 0, max: 1, default: 1.0 },
    { key: "pathDivergenceEnd", label: "Divergence at end", step: 0.05, min: 0, max: 1, default: 0.2 },
    { key: "pathSpiralTurns", label: "Turns", step: 0.1, min: 0, max: 12, default: 1.5, shape: true },
    { key: "pathSpiralRadius", label: "Radius", step: 0.05, min: 0, max: 3, default: 0.4, shape: true },
];

export const DEFAULT_PATH = {
    points: [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 3, z: 0 },
    ],
    tension: 0.5,
    divergence: 0.25,
    divergenceStart: 1.0,
    divergenceEnd: 0.2,
    followMode: "tube",
    spiralTurns: 1.5,
    spiralRadius: 0.4,
};

/** Storage layout: 32-byte header + 12 × vec4 (16 bytes) = 224 bytes, round to 256 */
export const PATH_BUFFER_BYTES = 256;

const PATH_OFF = {
    pointCount: 0,
    tension: 4,
    divergence: 8,
    divergenceStart: 12,
    divergenceEnd: 16,
    followMode: 20,
    spiralTurns: 24,
    spiralRadius: 28,
    points: 48,
};

export function normalizeFollowMode(mode) {
    if (mode === "straight") return "tube";
    return PATH_FOLLOW_MODES.some((m) => m.id === mode) ? mode : "tube";
}

export function followModeIndex(mode) {
    return FOLLOW_MODE_INDEX[normalizeFollowMode(mode)] ?? 0;
}

export function mergePath(path, params = {}) {
    const base = { ...DEFAULT_PATH, ...(path || {}) };
    const points = (base.points || DEFAULT_PATH.points).slice(0, MAX_PATH_POINTS).map((p) => ({
        x: Number(p.x ?? 0),
        y: Number(p.y ?? 0),
        z: Number(p.z ?? 0),
    }));
    if (points.length < 2) {
        points.push({ x: points[0].x, y: points[0].y + 3, z: points[0].z });
    }
    return {
        points,
        tension: Number(params.pathTension ?? base.tension ?? DEFAULT_PATH.tension),
        divergence: Number(params.pathDivergence ?? base.divergence ?? DEFAULT_PATH.divergence),
        divergenceStart: Number(params.pathDivergenceStart ?? base.divergenceStart ?? DEFAULT_PATH.divergenceStart),
        divergenceEnd: Number(params.pathDivergenceEnd ?? base.divergenceEnd ?? DEFAULT_PATH.divergenceEnd),
        followMode: normalizeFollowMode(params.pathFollowMode ?? base.followMode ?? DEFAULT_PATH.followMode),
        spiralTurns: Number(params.pathSpiralTurns ?? base.spiralTurns ?? DEFAULT_PATH.spiralTurns),
        spiralRadius: Number(params.pathSpiralRadius ?? base.spiralRadius ?? DEFAULT_PATH.spiralRadius),
    };
}

/** World-space emitter = path root + first anchor. */
export function emitterWorldFromPath(path, root = [0, 0, 0]) {
    const p = mergePath(path);
    const pt = p.points[0];
    return [root[0] + pt.x, root[1] + pt.y, root[2] + pt.z];
}

/** Path points relative to the first anchor (for GPU: emitterPos = anchor world). */
export function pathRelativeToAnchor(path) {
    const p = mergePath(path);
    const o = p.points[0];
    return {
        ...p,
        points: p.points.map((pt) => ({
            x: pt.x - o.x,
            y: pt.y - o.y,
            z: pt.z - o.z,
        })),
    };
}

/**
 * Bake the first anchor into emitter world position; first point becomes (0,0,0).
 * @param {PathConfig} path
 * @param {[number, number, number]} emitterRoot path group offset in world space
 */
export function normalizePathAnchor(path, emitterRoot = [0, 0, 0]) {
    const p = mergePath(path);
    const anchor = p.points[0];
    const emitterWorld = [
        emitterRoot[0] + anchor.x,
        emitterRoot[1] + anchor.y,
        emitterRoot[2] + anchor.z,
    ];
    return {
        path: {
            ...p,
            points: p.points.map((pt) => ({
                x: pt.x - anchor.x,
                y: pt.y - anchor.y,
                z: pt.z - anchor.z,
            })),
        },
        emitterWorld,
    };
}

/** Load/save canonical form: anchor in params + path points relative to origin. */
export function canonicalizeStoredPath(path, params = {}, emitterRoot = [0, 0, 0]) {
    const merged = mergePath(path, params);
    const { path: normalized, emitterWorld } = normalizePathAnchor(merged, emitterRoot);
    return {
        path: normalized,
        params: {
            ...params,
            emitterX: emitterWorld[0],
            emitterY: emitterWorld[1],
            emitterZ: emitterWorld[2],
        },
        emitterWorld,
    };
}

export function packPathBuffer(path) {
    const buf = new ArrayBuffer(PATH_BUFFER_BYTES);
    const view = new DataView(buf);
    const p = mergePath(path);

    view.setUint32(PATH_OFF.pointCount, p.points.length, true);
    view.setFloat32(PATH_OFF.tension, p.tension, true);
    view.setFloat32(PATH_OFF.divergence, p.divergence, true);
    view.setFloat32(PATH_OFF.divergenceStart, p.divergenceStart, true);
    view.setFloat32(PATH_OFF.divergenceEnd, p.divergenceEnd, true);
    view.setFloat32(PATH_OFF.followMode, followModeIndex(p.followMode), true);
    view.setFloat32(PATH_OFF.spiralTurns, p.spiralTurns, true);
    view.setFloat32(PATH_OFF.spiralRadius, p.spiralRadius, true);

    for (let i = 0; i < MAX_PATH_POINTS; i++) {
        const pt = p.points[i] || p.points[p.points.length - 1];
        const o = PATH_OFF.points + i * 16;
        view.setFloat32(o, pt.x, true);
        view.setFloat32(o + 4, pt.y, true);
        view.setFloat32(o + 8, pt.z, true);
        view.setFloat32(o + 12, 0, true);
    }
    return buf;
}

function getPoint(points, i) {
    const n = points.length;
    const idx = Math.max(0, Math.min(n - 1, i));
    return points[idx];
}

/** Uniform segment Bezier (matches GPU sim — no Catmull overshoot between anchors). */
export function samplePath(points, t, tension = 0.5) {
    const pts = points.map((p) => [p.x, p.y, p.z]);
    const n = pts.length;
    if (n < 2) return { x: 0, y: 0, z: 0 };
    const u = Math.max(0, Math.min(1, t));
    const ft = u * (n - 1);
    const seg = Math.min(Math.floor(ft), n - 2);
    const lt = Math.max(0, Math.min(1, ft - seg));
    const p0 = getPoint(pts, seg);
    const p1 = getPoint(pts, seg + 1);
    const prev = getPoint(pts, seg - 1);
    const next = getPoint(pts, seg + 2);
    const s = tension * 0.5;
    const c0 = [
        p0[0] + (p1[0] - prev[0]) * s / 3,
        p0[1] + (p1[1] - prev[1]) * s / 3,
        p0[2] + (p1[2] - prev[2]) * s / 3,
    ];
    const c1 = [
        p1[0] - (next[0] - p0[0]) * s / 3,
        p1[1] - (next[1] - p0[1]) * s / 3,
        p1[2] - (next[2] - p0[2]) * s / 3,
    ];
    const u1 = 1 - lt;
    return {
        x: u1 ** 3 * p0[0] + 3 * u1 ** 2 * lt * c0[0] + 3 * u1 * lt ** 2 * c1[0] + lt ** 3 * p1[0],
        y: u1 ** 3 * p0[1] + 3 * u1 ** 2 * lt * c0[1] + 3 * u1 * lt ** 2 * c1[1] + lt ** 3 * p1[1],
        z: u1 ** 3 * p0[2] + 3 * u1 ** 2 * lt * c0[2] + 3 * u1 * lt ** 2 * c1[2] + lt ** 3 * p1[2],
    };
}

/** Path tangent at normalized t (matches GPU sim). */
export function samplePathTangent(points, t, tension = 0.5) {
    const eps = 0.002;
    const a = samplePath(points, Math.max(0, t - eps), tension);
    const b = samplePath(points, Math.min(1, t + eps), tension);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return { x: 0, y: 1, z: 0 };
    return { x: dx / len, y: dy / len, z: dz / len };
}

function shapeFieldHtml(f, params, mode) {
    const visible = SHAPE_FIELDS[mode]?.includes(f.key);
    const label = FIELD_LABELS[f.key]?.[mode] ?? f.label;
    const val = params[f.key] ?? f.default;
    const max = f.key === "pathSpiralTurns" && mode === "star" ? 12 : f.max;
    return `
        <div class="field compact path-shape-field" data-field="${f.key}"${visible ? "" : ' style="display:none"'}>
            <label>${label}</label>
            <input id="p-${f.key}" type="number" step="${f.step}" min="${f.min}" max="${max}" value="${val}" />
        </div>`;
}

export function pathParamHtml(params) {
    const p = mergePath(null, params);
    const mode = normalizeFollowMode(p.followMode);
    const modeMeta = PATH_FOLLOW_MODES.find((m) => m.id === mode) ?? PATH_FOLLOW_MODES[0];

    const followOpts = PATH_FOLLOW_MODES.map((o) =>
        `<option value="${o.id}"${mode === o.id ? " selected" : ""}>${o.label}</option>`).join("");

    const coreFields = PATH_PARAM_FIELDS.filter((f) => !f.shape).map((f) => {
        const val = params[f.key] ?? f.default;
        return `
        <div class="field compact">
            <label>${f.label}</label>
            <input id="p-${f.key}" type="number" step="${f.step}" min="${f.min}" max="${f.max}" value="${val}" />
        </div>`;
    }).join("");

    const shapeFields = PATH_PARAM_FIELDS.filter((f) => f.shape)
        .map((f) => shapeFieldHtml(f, params, mode)).join("");

    return `
        <div class="path-toolbar">
            <button type="button" id="btn-path-add">Insert point</button>
            <button type="button" id="btn-path-remove">Remove point</button>
        </div>
        <div class="field compact">
            <label>Cross-section shape</label>
            <select id="p-pathFollowMode">${followOpts}</select>
        </div>
        <p class="curve-hint" id="path-shape-hint">${modeMeta.hint}</p>
        <div class="param-grid">${coreFields}</div>
        <div class="param-grid" id="path-shape-fields">${shapeFields}</div>
        <p class="curve-hint">Spline sag uses Physics → Gravity · same as velocity mode</p>
        <p class="curve-hint">Max divergence × per-particle spread · start/end taper width along path</p>
        <p class="curve-hint">Select an anchor · Insert point splits the segment after it</p>
    `;
}

export function bindPathShapePanel(onChange) {
    const select = document.getElementById("p-pathFollowMode");
    if (!select || select.dataset.shapeBound) return;
    select.dataset.shapeBound = "1";

    const sync = () => {
        const mode = normalizeFollowMode(select.value);
        const meta = PATH_FOLLOW_MODES.find((m) => m.id === mode);
        const hint = document.getElementById("path-shape-hint");
        if (hint && meta) hint.textContent = meta.hint;

        for (const f of PATH_PARAM_FIELDS.filter((field) => field.shape)) {
            const row = document.querySelector(`.path-shape-field[data-field="${f.key}"]`);
            const input = document.getElementById(`p-${f.key}`);
            const label = row?.querySelector("label");
            const visible = SHAPE_FIELDS[mode]?.includes(f.key);
            if (row) row.style.display = visible ? "" : "none";
            if (label && FIELD_LABELS[f.key]?.[mode]) {
                label.textContent = FIELD_LABELS[f.key][mode];
            }
        }
        onChange?.();
    };

    select.addEventListener("change", sync);
    sync();
}

export function readPathFromUI(basePath, params) {
    const path = mergePath(basePath, params);
    const followEl = document.getElementById("p-pathFollowMode");
    if (followEl) path.followMode = followEl.value;
    for (const f of PATH_PARAM_FIELDS) {
        const el = document.getElementById(`p-${f.key}`);
        if (el) params[f.key] = parseFloat(el.value);
    }
    return mergePath(path, params);
}
