import {
    SCALAR_CURVES,
    DEFAULT_COLOR_CURVE,
    MAX_KEYS,
    MAX_COLOR_KEYS,
    mergeColorCurve,
    normalizeKeys,
    normalizeColorKeys,
    drawScalarKeyGraph,
    drawColorCurveGraph,
    drawVelocityGraph,
    readScalarBlock,
    readVelocityBlock,
    readColorBlock,
    sampleColorAt,
    clampKeyframe,
    computeGraphYRange,
    ROTATION_CURVE,
    constantScalarCurve,
    scalarSimpleValue,
    rotationSimpleCurve,
    readRotationBlock,
} from "./curves.js";

/** @typedef {{ t: number, min: number, max: number }} CurveKey */

/**
 * @param {HTMLElement} root
 * @param {() => void} onChange
 */
export function setupCurveEditors(root, onChange) {
    for (const block of root.querySelectorAll(".curve-block[data-curve]")) {
        const key = block.dataset.curve;
        bindAdvancedToggle(block, onChange);
        if (key === "velocity") {
            setupVelocityEditor(block, onChange);
        } else if (key === "color") {
            bindSimpleColorInput(block, onChange);
            setupColorEditor(block, onChange);
        } else if (key === "rotation") {
            bindSimpleScalarInput(block, { key: "rotation", default: ROTATION_CURVE.default }, onChange);
            setupScalarEditor(block, "rotation", onChange);
        } else {
            const def = SCALAR_CURVES.find((c) => c.key === key);
            if (def) {
                bindSimpleScalarInput(block, def, onChange);
                setupScalarEditor(block, key, onChange);
            }
        }
    }
}

function bindAdvancedToggle(block, onChange) {
    const btn = block.querySelector('[data-action="toggle-advanced"]');
    const panel = block.querySelector(".curve-advanced");
    if (!btn || !panel) return;

    const sync = () => {
        const open = block.dataset.advanced === "1";
        btn.classList.toggle("active", open);
        panel.classList.toggle("hidden", !open);
    };

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const opening = block.dataset.advanced !== "1";
        if (opening) {
            const key = block.dataset.curve;
            if (key === "color") {
                const hex = block.querySelector('[data-f="simpleColor"]')?.value || "#ffffff";
                applyColorBlock(block, mergeColorCurve({
                    keys: [{ t: 0, color: hex }, { t: 1, color: hex }],
                    random: false,
                    randomBetween: false,
                    easing: "linear",
                    advanced: true,
                }));
            } else if (key !== "velocity" && key !== "color") {
                const def = key === "rotation"
                    ? { key: "rotation", default: ROTATION_CURVE.default }
                    : SCALAR_CURVES.find((c) => c.key === key);
                const el = block.querySelector('[data-f="simpleValue"]');
                const v = parseFloat(el?.value);
                if (def && !Number.isNaN(v)) {
                    const curve = key === "rotation"
                        ? { ...rotationSimpleCurve(v), advanced: true }
                        : { ...constantScalarCurve(v), advanced: true };
                    applyScalarBlock(block, curve, def.key);
                }
            }
        } else {
            const key = block.dataset.curve;
            if (key === "color") {
                const color = readColorBlock(block);
                const el = block.querySelector('[data-f="simpleColor"]');
                if (el) el.value = color.keys[0]?.color || "#ffffff";
            } else if (key !== "velocity") {
                const el = block.querySelector('[data-f="simpleValue"]');
                if (key === "rotation") {
                    const curve = readRotationBlock(block);
                    if (el) el.value = curve.keys[curve.keys.length - 1]?.min ?? 0;
                } else {
                    const def = SCALAR_CURVES.find((c) => c.key === key);
                    const curve = readScalarBlock(block, def?.default);
                    if (el) el.value = scalarSimpleValue(curve);
                }
            }
        }
        block.dataset.advanced = opening ? "1" : "0";
        sync();
        emit(onChange);
    });

    sync();
}

function bindSimpleScalarInput(block, def, onChange) {
    const input = block.querySelector('[data-f="simpleValue"]');
    if (!input) return;
    const apply = () => {
        if (block.dataset.advanced === "1") return;
        const v = parseFloat(input.value);
        if (Number.isNaN(v)) return;
        const curve = def.key === "rotation"
            ? rotationSimpleCurve(v)
            : constantScalarCurve(v);
        applyScalarBlock(block, curve, def.key);
        emit(onChange);
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
}

function bindSimpleColorInput(block, onChange) {
    const input = block.querySelector('[data-f="simpleColor"]');
    if (!input) return;
    const apply = () => {
        if (block.dataset.advanced === "1") return;
        applyColorBlock(block, mergeColorCurve({
            keys: [{ t: 0, color: input.value }, { t: 1, color: input.value }],
            random: false,
            randomBetween: false,
            easing: "linear",
            advanced: false,
        }));
        emit(onChange);
    };
    input.addEventListener("input", apply);
    input.addEventListener("change", apply);
}

function emit(onChange) {
    onChange?.();
}

function stopCanvasBubble(canvas) {
    canvas.addEventListener("pointerdown", (e) => e.stopPropagation());
    canvas.addEventListener("click", (e) => e.stopPropagation());
    canvas.addEventListener("dblclick", (e) => e.stopPropagation());
}

function canvasPoint(canvas, e) {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    return {
        x: (e.clientX - r.left) * sx,
        y: (e.clientY - r.top) * sy,
        w: canvas.width,
        h: canvas.height,
    };
}

const GRAPH_PAD = 8;
const VELOCITY_CLAMP = 50;
const T_SNAP = 0.05;

/** Snap a value to a grid step (used while holding Shift during a drag). */
function snapTo(v, step) {
    return step > 0 ? Math.round(v / step) * step : v;
}

function clampGraphPointerY(y, h) {
    return Math.max(GRAPH_PAD, Math.min(h - GRAPH_PAD, y));
}

function clampGraphPointerX(x, w) {
    return Math.max(GRAPH_PAD, Math.min(w - GRAPH_PAD, x));
}

function hitRadius(mx, px, keyIndex, totalKeys) {
    const atEdge = keyIndex === 0 || keyIndex === totalKeys - 1;
    const base = atEdge ? 22 : 14;
    return Math.abs(mx - px) < 8 ? base + 6 : base;
}

function findColorKeyIndex(keys, t, color) {
    let best = 0;
    let bestD = Infinity;
    keys.forEach((k, i) => {
        const d = Math.abs(k.t - t) + (k.color === color ? 0 : 0.001);
        if (d < bestD) { bestD = d; best = i; }
    });
    return best;
}

function commitColorKeys(block, color, opts = {}) {
    color.keys = normalizeColorKeys(color.keys, opts);
    applyColorBlock(block, color);
}

function clampVelocityKey(k) {
    k.min = Math.max(-VELOCITY_CLAMP, Math.min(VELOCITY_CLAMP, k.min));
    k.max = Math.max(-VELOCITY_CLAMP, Math.min(VELOCITY_CLAMP, k.max));
    if (k.min > k.max) k.max = k.min;
}

function makeGraphLayout(w, h, yMin, yMax) {
    return {
        yMin,
        yMax,
        toX: (t) => GRAPH_PAD + t * (w - GRAPH_PAD * 2),
        toY: (v) => h - GRAPH_PAD - ((v - yMin) / (yMax - yMin)) * (h - GRAPH_PAD * 2),
        fromX: (x) => Math.max(0, Math.min(1, (x - GRAPH_PAD) / (w - GRAPH_PAD * 2))),
        fromY: (y) => yMin + (1 - (y - GRAPH_PAD) / (h - GRAPH_PAD * 2)) * (yMax - yMin),
    };
}

function addScalarKey(block, def, canvas, t, v, onChange, repaint) {
    const curve = readScalarBlock(block, def.default);
    if (curve.keys.length >= MAX_KEYS) return;
    const half = Math.max(0.05, Math.abs(v) * 0.05);
    const key = { t, min: v - half, max: v + half };
    clampKeyframe(def.key, key);
    curve.keys.push(key);
    curve.keys = normalizeKeys(curve.keys);
    applyScalarBlock(block, curve, def.key);
    repaint();
    emit(onChange);
}

function setupScalarEditor(block, key, onChange) {
    const canvas = block.querySelector(".curve-advanced canvas.curve-graph");
    if (!canvas) return;
    const def = key === "rotation"
        ? { key: "rotation", default: ROTATION_CURVE.default }
        : SCALAR_CURVES.find((c) => c.key === key);
    if (!def) return;

    stopCanvasBubble(canvas);
    const state = { drag: null };

    const repaint = () => {
        const curve = readScalarBlock(block, def.default);
        drawScalarKeyGraph(canvas, curve, state.drag?.keyIndex, def.key);
        syncScalarInputs(block, curve);
    };

    const pick = (mx, my) => {
        const curve = readScalarBlock(block, def.default);
        const layout = graphLayout(canvas, curve, def.key);
        let best = null;
        let bestD = Infinity;
        curve.keys.forEach((k, i) => {
            const px = layout.toX(k.t);
            const limit = hitRadius(mx, px, i, curve.keys.length);
            for (const v of [k.min, k.max, (k.min + k.max) * 0.5]) {
                const py = layout.toY(v);
                const d = Math.hypot(mx - px, my - py);
                if (d < limit && d < bestD) {
                    bestD = d;
                    best = { keyIndex: i, mode: v === k.min ? "min" : v === k.max ? "max" : "center" };
                }
            }
        });
        return best;
    };

    canvas.addEventListener("pointerdown", (e) => {
        const p = canvasPoint(canvas, e);
        const hit = pick(p.x, p.y);
        if (!hit) return;
        const curve = readScalarBlock(block, def.default);
        state.drag = { ...hit, layout: graphLayout(canvas, curve, def.key) };
        canvas.setPointerCapture(e.pointerId);
        repaint();
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!state.drag) return;
        const p = canvasPoint(canvas, e);
        const curve = readScalarBlock(block, def.default);
        const layout = state.drag.layout;
        const k = curve.keys[state.drag.keyIndex];
        let t = layout.fromX(clampGraphPointerX(p.x, canvas.width));
        let val = layout.fromY(clampGraphPointerY(p.y, canvas.height));
        if (e.shiftKey) {
            t = snapTo(t, T_SNAP);
            val = snapTo(val, parseFloat(block.dataset.step) || 0.05);
        }
        if (state.drag.keyIndex === 0) k.t = 0;
        else if (state.drag.keyIndex === curve.keys.length - 1) k.t = 1;
        else k.t = Math.max(0.01, Math.min(0.99, t));
        const half = Math.max(0.0001, (k.max - k.min) * 0.5);
        if (state.drag.mode === "min") k.min = Math.min(val, k.max);
        else if (state.drag.mode === "max") k.max = Math.max(val, k.min);
        else { k.min = val - half; k.max = val + half; }
        clampKeyframe(def.key, k);
        applyScalarBlock(block, curve, def.key);
        repaint();
        emit(onChange);
    });

    const end = (e) => {
        if (!state.drag) return;
        const curve = readScalarBlock(block, def.default);
        curve.keys = normalizeKeys(curve.keys);
        applyScalarBlock(block, curve, def.key);
        state.drag = null;
        canvas.releasePointerCapture(e.pointerId);
        repaint();
        emit(onChange);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const curve = readScalarBlock(block, def.default);
        if (curve.keys.length >= MAX_KEYS) return;
        const p = canvasPoint(canvas, e);
        const layout = graphLayout(canvas, curve, def.key);
        const t = layout.fromX(clampGraphPointerX(p.x, canvas.width));
        const v = layout.fromY(clampGraphPointerY(p.y, canvas.height));
        if (t <= 0.001 || t >= 0.999) return;
        addScalarKey(block, def, canvas, t, v, onChange, repaint);
    });

    block.querySelector('[data-action="add-key"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const curve = readScalarBlock(block, def.default);
        if (curve.keys.length >= MAX_KEYS) return;
        let t = 0.5;
        if (curve.keys.length >= 2) {
            t = (curve.keys[curve.keys.length - 2].t + curve.keys[curve.keys.length - 1].t) * 0.5;
        }
        const v = sampleCurveMid(curve, t);
        addScalarKey(block, def, canvas, t, v, onChange, repaint);
    });

    block.querySelector('[data-action="del-key"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const curve = readScalarBlock(block, def.default);
        if (curve.keys.length <= 2) return;
        curve.keys = normalizeKeys(curve.keys.slice(0, -1));
        applyScalarBlock(block, curve, def.key);
        repaint();
        emit(onChange);
    });

    block.querySelector('[data-action="preset"]')?.addEventListener("change", (e) => {
        e.stopPropagation();
        const shape = e.target.value;
        e.target.value = "";
        if (!shape) return;
        const curve = readScalarBlock(block, def.default);
        const vals = curve.keys.flatMap((k) => [k.min, k.max]);
        let lo = Math.min(...vals);
        let hi = Math.max(...vals);
        if (Math.abs(hi - lo) < 1e-4) hi = lo + Math.max(Math.abs(lo) * 0.5, 1);
        const mk = (t, v) => ({ t, min: v, max: v });
        let keys;
        switch (shape) {
            case "ramp-up": keys = [mk(0, lo), mk(1, hi)]; break;
            case "ramp-down": keys = [mk(0, hi), mk(1, lo)]; break;
            case "bell": keys = [mk(0, lo), mk(0.5, hi), mk(1, lo)]; break;
            case "spike": keys = [mk(0, lo), mk(0.8, hi), mk(1, lo)]; break;
            case "constant": { const m = (lo + hi) / 2; keys = [mk(0, m), mk(1, m)]; break; }
            default: return;
        }
        for (const k of keys) clampKeyframe(def.key, k);
        curve.keys = normalizeKeys(keys);
        applyScalarBlock(block, curve, def.key);
        repaint();
        emit(onChange);
    });

    bindScalarInputs(block, def, onChange, repaint);
    repaint();
}

function sampleCurveMid(curve, t) {
    const keys = normalizeKeys(curve.keys);
    for (let i = 0; i < keys.length - 1; i++) {
        if (t >= keys[i].t && t <= keys[i + 1].t) {
            const a = keys[i];
            const b = keys[i + 1];
            const u = (t - a.t) / Math.max(b.t - a.t, 1e-4);
            return (a.min + a.max + b.min + b.max) * 0.25;
        }
    }
    const k = keys[keys.length - 1];
    return (k.min + k.max) * 0.5;
}

function setupVelocityEditor(block, onChange) {
    const canvas = block.querySelector(".curve-advanced canvas.curve-graph");
    if (!canvas) return;
    const state = {
        drag: null,
        channel: "y",
        visible: { x: false, y: true, z: false },
    };

    stopCanvasBubble(canvas);

    const syncChannelButtons = () => {
        block.querySelectorAll("[data-channel]").forEach((btn) => {
            const ch = btn.dataset.channel;
            btn.classList.toggle("active", !!state.visible[ch]);
        });
    };

    const repaint = () => {
        const vel = readVelocityBlock(block);
        drawVelocityGraph(canvas, vel, state);
        syncVelocityInputs(block, vel, state.channel);
        syncChannelButtons();
    };

    block.querySelectorAll("[data-channel]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const ch = btn.dataset.channel;
            const visibleCount = Object.values(state.visible).filter(Boolean).length;
            if (state.visible[ch] && visibleCount <= 1) return;
            state.visible[ch] = !state.visible[ch];
            if (state.visible[ch]) state.channel = ch;
            repaint();
        });
    });

    const pick = (mx, my) => {
        const vel = readVelocityBlock(block);
        const layout = velocityLayout(canvas, vel, state.visible);
        let best = null;
        let bestD = Infinity;
        for (const ch of ["x", "y", "z"]) {
            if (!state.visible[ch]) continue;
            const keys = vel.channels[ch].keys;
            keys.forEach((k, i) => {
                const px = layout.toX(k.t);
                const limit = hitRadius(mx, px, i, keys.length);
                for (const mode of ["min", "max", "center"]) {
                    const v = mode === "min" ? k.min : mode === "max" ? k.max : (k.min + k.max) * 0.5;
                    const py = layout.toY(v);
                    const d = Math.hypot(mx - px, my - py);
                    const prefer = ch === state.channel ? -0.001 : 0;
                    if (d < limit && d + prefer < bestD) {
                        bestD = d + prefer;
                        best = { channel: ch, keyIndex: i, mode };
                    }
                }
            });
        }
        return best;
    };

    canvas.addEventListener("pointerdown", (e) => {
        const p = canvasPoint(canvas, e);
        const hit = pick(p.x, p.y);
        if (!hit) return;
        const vel = readVelocityBlock(block);
        state.drag = {
            ...hit,
            layout: velocityLayout(canvas, vel, state.visible),
        };
        state.channel = hit.channel;
        canvas.setPointerCapture(e.pointerId);
        repaint();
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!state.drag) return;
        const p = canvasPoint(canvas, e);
        const vel = readVelocityBlock(block);
        const layout = state.drag.layout;
        const keys = vel.channels[state.drag.channel].keys;
        const k = keys[state.drag.keyIndex];
        let t = layout.fromX(clampGraphPointerX(p.x, canvas.width));
        let val = layout.fromY(clampGraphPointerY(p.y, canvas.height));
        if (e.shiftKey) {
            t = snapTo(t, T_SNAP);
            val = snapTo(val, 0.5);
        }
        if (state.drag.keyIndex === 0) k.t = 0;
        else if (state.drag.keyIndex === keys.length - 1) k.t = 1;
        else k.t = Math.max(0.01, Math.min(0.99, t));
        const half = Math.max(0.0001, (k.max - k.min) * 0.5);
        if (state.drag.mode === "min") k.min = Math.min(val, k.max);
        else if (state.drag.mode === "max") k.max = Math.max(val, k.min);
        else { k.min = val - half; k.max = val + half; }
        clampVelocityKey(k);
        applyVelocityBlock(block, vel);
        repaint();
        emit(onChange);
    });

    const end = (e) => {
        if (!state.drag) return;
        const vel = readVelocityBlock(block);
        vel.channels[state.drag.channel].keys = normalizeKeys(vel.channels[state.drag.channel].keys);
        applyVelocityBlock(block, vel);
        state.drag = null;
        canvas.releasePointerCapture(e.pointerId);
        repaint();
        emit(onChange);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const vel = readVelocityBlock(block);
        const ch = state.channel;
        if (!state.visible[ch]) return;
        const keys = vel.channels[ch].keys;
        if (keys.length >= MAX_KEYS) return;
        const p = canvasPoint(canvas, e);
        const layout = velocityLayout(canvas, vel, state.visible);
        const t = layout.fromX(clampGraphPointerX(p.x, canvas.width));
        const v = layout.fromY(clampGraphPointerY(p.y, canvas.height));
        if (t <= 0.001 || t >= 0.999) return;
        const key = { t, min: v - 0.2, max: v + 0.2 };
        clampVelocityKey(key);
        keys.push(key);
        vel.channels[ch].keys = normalizeKeys(keys);
        applyVelocityBlock(block, vel);
        repaint();
        emit(onChange);
    });

    block.querySelector('[data-action="add-key"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const vel = readVelocityBlock(block);
        const ch = state.channel;
        if (!state.visible[ch]) return;
        const keys = vel.channels[ch].keys;
        if (keys.length >= MAX_KEYS) return;
        const t = keys.length >= 2
            ? (keys[keys.length - 2].t + keys[keys.length - 1].t) * 0.5
            : 0.5;
        const v = (keys[0].min + keys[keys.length - 1].max) * 0.5;
        const key = { t, min: v - 0.2, max: v + 0.2 };
        clampVelocityKey(key);
        keys.push(key);
        vel.channels[ch].keys = normalizeKeys(keys);
        applyVelocityBlock(block, vel);
        repaint();
        emit(onChange);
    });

    block.querySelector('[data-action="del-key"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const vel = readVelocityBlock(block);
        const keys = vel.channels[state.channel].keys;
        if (keys.length <= 2) return;
        keys.pop();
        vel.channels[state.channel].keys = normalizeKeys(keys);
        applyVelocityBlock(block, vel);
        repaint();
        emit(onChange);
    });

    bindVelocityInputs(block, onChange, repaint, () => state.channel);
    repaint();
}

function setupColorEditor(block, onChange) {
    const canvas = block.querySelector(".curve-advanced canvas.curve-graph");
    if (!canvas) return;
    stopCanvasBubble(canvas);

    const state = { drag: null };

    const repaint = () => {
        const color = readColorBlock(block);
        drawColorCurveGraph(canvas, color, state.drag?.keyIndex);
        syncColorInputs(block, color);
    };

    const colorLayout = () => {
        const w = canvas.width;
        const h = canvas.height;
        const pad = 8;
        const handleY = 48;
        return {
            toX: (t) => pad + t * (w - pad * 2),
            fromX: (x) => Math.max(0, Math.min(1, (x - pad) / (w - pad * 2))),
            handleY,
        };
    };

    const pickColorKey = (mx, my) => {
        const color = readColorBlock(block);
        const layout = colorLayout();
        let best = null;
        let bestD = Infinity;
        color.keys.forEach((k, i) => {
            const px = layout.toX(k.t);
            const limit = hitRadius(mx, px, i, color.keys.length);
            const d = Math.hypot(mx - px, my - layout.handleY);
            if (d < limit && d < bestD) {
                bestD = d;
                best = { keyIndex: i };
            }
        });
        return best;
    };

    const selectColorKey = (color, idx) => {
        syncColorKeySelect(block, idx);
        syncColorInputs(block, color);
    };

    canvas.addEventListener("pointerdown", (e) => {
        const p = canvasPoint(canvas, e);
        const hit = pickColorKey(p.x, p.y);
        if (!hit) return;
        state.drag = hit;
        canvas.setPointerCapture(e.pointerId);
        selectColorKey(readColorBlock(block), hit.keyIndex);
        repaint();
    });

    canvas.addEventListener("pointermove", (e) => {
        if (!state.drag) return;
        const p = canvasPoint(canvas, e);
        const color = readColorBlock(block);
        const layout = colorLayout();
        const k = color.keys[state.drag.keyIndex];
        if (!k) return;
        let t = layout.fromX(clampGraphPointerX(p.x, canvas.width));
        if (e.shiftKey) t = snapTo(t, T_SNAP);
        if (state.drag.keyIndex === 0) k.t = 0;
        else if (state.drag.keyIndex === color.keys.length - 1) k.t = 1;
        else k.t = Math.max(0.01, Math.min(0.99, t));
        applyColorBlock(block, color);
        repaint();
        emit(onChange);
    });

    const end = (e) => {
        if (!state.drag) return;
        const color = readColorBlock(block);
        commitColorKeys(block, color);
        state.drag = null;
        canvas.releasePointerCapture(e.pointerId);
        repaint();
        emit(onChange);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);

    canvas.addEventListener("dblclick", (e) => {
        e.preventDefault();
        const color = readColorBlock(block);
        if (color.keys.length >= MAX_COLOR_KEYS) return;
        const p = canvasPoint(canvas, e);
        const layout = colorLayout();
        const t = layout.fromX(clampGraphPointerX(p.x, canvas.width));
        if (t <= 0.001 || t >= 0.999) return;
        const hex = sampleColorAt(color.keys, t, color.easing);
        color.keys.push({ t, color: hex });
        commitColorKeys(block, color);
        const newIdx = findColorKeyIndex(color.keys, t, hex);
        selectColorKey(color, newIdx);
        repaint();
        emit(onChange);
    });

    block.querySelector('[data-action="add-key"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const color = readColorBlock(block);
        if (color.keys.length >= MAX_COLOR_KEYS) return;
        const t = color.keys.length >= 2
            ? (color.keys[color.keys.length - 2].t + color.keys[color.keys.length - 1].t) * 0.5
            : 0.5;
        const hex = sampleColorAt(color.keys, t, color.easing);
        color.keys.push({ t, color: hex });
        commitColorKeys(block, color);
        const newIdx = findColorKeyIndex(color.keys, t, hex);
        selectColorKey(color, newIdx);
        repaint();
        emit(onChange);
    });

    block.querySelector('[data-action="del-key"]')?.addEventListener("click", (e) => {
        e.stopPropagation();
        const color = readColorBlock(block);
        if (color.keys.length <= 2) return;
        const idx = parseInt(block.querySelector("[data-sel-key]")?.value || "0", 10);
        if (idx > 0 && idx < color.keys.length - 1) {
            color.keys.splice(idx, 1);
        } else {
            color.keys = normalizeColorKeys(color.keys.slice(0, -1));
        }
        commitColorKeys(block, color);
        selectColorKey(color, Math.min(idx, color.keys.length - 1));
        repaint();
        emit(onChange);
    });

    block.querySelectorAll('[data-f="random"], [data-f="randomBetween"], [data-f="easing"]').forEach((el) => {
        el.addEventListener("change", () => { repaint(); emit(onChange); });
    });

    block.querySelector('[data-f="keyTime"]')?.addEventListener("change", () => {
        const color = readColorBlock(block);
        const idx = parseInt(block.querySelector("[data-sel-key]").value, 10);
        const k = color.keys[idx];
        if (!k) return;
        k.t = parseFloat(block.querySelector('[data-f="keyTime"]').value);
        commitColorKeys(block, color);
        selectColorKey(color, idx);
        repaint();
        emit(onChange);
    });

    block.querySelector('[data-f="keyColor"]')?.addEventListener("input", () => {
        const color = readColorBlock(block);
        const idx = parseInt(block.querySelector("[data-sel-key]").value, 10);
        const k = color.keys[idx];
        if (!k) return;
        k.color = block.querySelector('[data-f="keyColor"]').value;
        applyColorBlock(block, color);
        repaint();
        emit(onChange);
    });

    block.querySelector("[data-sel-key]")?.addEventListener("change", () => {
        syncColorInputs(block, readColorBlock(block));
        repaint();
    });

    repaint();
}

export function graphLayout(canvas, curve, curveKey, frozen) {
    const w = canvas.width;
    const h = canvas.height;
    const vals = curve.keys.flatMap((k) => [k.min, k.max]);
    const range = frozen
        ? { yMin: frozen.yMin, yMax: frozen.yMax }
        : computeGraphYRange(vals, curveKey);
    return makeGraphLayout(w, h, range.yMin, range.yMax);
}

export function velocityLayout(canvas, vel, visible, frozen) {
    const w = canvas.width;
    const h = canvas.height;
    const vis = visible ?? { x: true, y: true, z: true };
    const vals = [];
    for (const ch of ["x", "y", "z"]) {
        if (!vis[ch]) continue;
        vals.push(...vel.channels[ch].keys.flatMap((k) => [k.min, k.max]));
    }
    if (!vals.length) vals.push(-1, 1);
    let yMin = Math.min(...vals);
    let yMax = Math.max(...vals);
    if (Math.abs(yMax - yMin) < 1e-6) { yMin -= 1; yMax += 1; }
    const py = (yMax - yMin) * 0.12 || 0.1;
    yMin -= py;
    yMax += py;
    if (frozen) {
        yMin = frozen.yMin;
        yMax = frozen.yMax;
    }
    return makeGraphLayout(w, h, yMin, yMax);
}

function applyScalarBlock(block, curve, curveKey) {
    for (const k of curve.keys) clampKeyframe(curveKey, k);
    block.dataset.keys = JSON.stringify(curve.keys);
    syncScalarInputs(block, curve);
}

function applyVelocityBlock(block, vel) {
    block.dataset.velocity = JSON.stringify(vel);
    syncVelocityInputs(block, vel);
}

function applyColorBlock(block, color) {
    block.dataset.colorKeys = JSON.stringify(color.keys);
    syncColorInputs(block, color);
}

function syncScalarInputs(block, curve) {
    const k0 = curve.keys[0];
    const kN = curve.keys[curve.keys.length - 1];
    const set = (f, v) => { const el = block.querySelector(`[data-f="${f}"]`); if (el) el.value = v; };
    set("startMin", round(k0.min, block.dataset.step));
    set("startMax", round(k0.max, block.dataset.step));
    set("endMin", round(kN.min, block.dataset.step));
    set("endMax", round(kN.max, block.dataset.step));
}

function syncColorKeySelect(block, idx) {
    const sel = block.querySelector("[data-sel-key]");
    if (sel) sel.value = String(idx);
}

function syncColorInputs(block, color) {
    const keys = color.keys;
    const sel = block.querySelector("[data-sel-key]");
    if (sel) {
        const idx = Math.min(parseInt(sel.value || "0", 10), keys.length - 1);
        sel.innerHTML = keys.map((_, i) => `<option value="${i}">Key ${i + 1}</option>`).join("");
        sel.value = String(idx);
    }
    const idx = Math.min(parseInt(sel?.value || "0", 10), keys.length - 1);
    const k = keys[idx];
    const set = (f, v) => { const el = block.querySelector(`[data-f="${f}"]`); if (el) el.value = v; };
    set("keyTime", round(k.t, 2));
    set("keyColor", k.color);
}

function syncVelocityInputs(block, vel, channel) {
    const ch = channel || "y";
    const keys = vel.channels[ch].keys;
    const sel = block.querySelector("[data-sel-key]");
    if (sel) {
        const idx = Math.min(parseInt(sel.value || "0", 10), keys.length - 1);
        sel.innerHTML = keys.map((_, i) => `<option value="${i}">Key ${i + 1}</option>`).join("");
        sel.value = String(idx);
    }
    const k = keys[Math.min(parseInt(sel?.value || "0", 10), keys.length - 1)];
    const set = (f, v) => { const el = block.querySelector(`[data-f="${f}"]`); if (el) el.value = v; };
    set("keyTime", round(k.t, 2));
    set("keyMin", round(k.min, 2));
    set("keyMax", round(k.max, 2));
}

function round(v, step) {
    const d = String(step).includes(".") ? String(step).split(".")[1].length : 0;
    return Number(v.toFixed(d));
}

function bindScalarInputs(block, def, onChange, repaint) {
    const curveKey = def.key;
    block.querySelectorAll("[data-f]").forEach((el) => {
        if (el.dataset.f === "easing" || el.dataset.f === "random") {
            el.addEventListener("change", () => { repaint(); emit(onChange); });
        } else {
            el.addEventListener("change", () => {
                const curve = readScalarBlock(block, def.default);
                const k0 = curve.keys[0];
                const kN = curve.keys[curve.keys.length - 1];
                k0.min = parseFloat(block.querySelector('[data-f="startMin"]').value);
                k0.max = parseFloat(block.querySelector('[data-f="startMax"]').value);
                kN.min = parseFloat(block.querySelector('[data-f="endMin"]').value);
                kN.max = parseFloat(block.querySelector('[data-f="endMax"]').value);
                clampKeyframe(curveKey, k0);
                clampKeyframe(curveKey, kN);
                applyScalarBlock(block, curve, curveKey);
                repaint();
                emit(onChange);
            });
        }
    });
}

function bindVelocityInputs(block, onChange, repaint, getChannel) {
    block.querySelectorAll('[data-f="random"], [data-f="easing"], [data-sel-key]').forEach((el) => {
        el.addEventListener("change", () => { repaint(); emit(onChange); });
    });
    for (const f of ["keyTime", "keyMin", "keyMax"]) {
        block.querySelector(`[data-f="${f}"]`)?.addEventListener("change", () => {
            const vel = readVelocityBlock(block);
            const ch = getChannel();
            const idx = parseInt(block.querySelector("[data-sel-key]").value, 10);
            const k = vel.channels[ch].keys[idx];
            if (!k) return;
            k.t = parseFloat(block.querySelector('[data-f="keyTime"]').value);
            k.min = parseFloat(block.querySelector('[data-f="keyMin"]').value);
            k.max = parseFloat(block.querySelector('[data-f="keyMax"]').value);
            clampVelocityKey(k);
            vel.channels[ch].keys = normalizeKeys(vel.channels[ch].keys);
            applyVelocityBlock(block, vel);
            repaint();
            emit(onChange);
        });
    }
}

export function paintCurveGraphs(root, onChange) {
    setupCurveEditors(root, onChange);
}
