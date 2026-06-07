/**
 * Layered noise model.
 *
 * Instead of a single shared noise block, an effect can stack up to
 * MAX_NOISE_LAYERS independent noise layers, each driving a different set of
 * particle aspects (velocity / color / size / opacity / position) with its own
 * type, frequency, amplitude, speed, octaves and seed.
 *
 * Stored on `params` as:
 *   noiseEnabled: boolean
 *   noiseLayers: Array<{ type, frequency, amplitude, speed, octaves, seed, targets }>
 *     where `targets` is { velocity, color, size, opacity, position } booleans.
 *
 * Legacy single-noise params (noiseType / noiseTargetVelocity / ...) are
 * migrated into a single layer.
 */
export const MAX_NOISE_LAYERS = 4;

export const NOISE_TYPES = [
    { id: "simplex3d", label: "Simplex 3D" },
    { id: "simplex2d", label: "Simplex 2D" },
    { id: "perlin3d", label: "Perlin 3D" },
    { id: "perlin2d", label: "Perlin 2D" },
    { id: "voronoi", label: "Voronoi" },
];

export const NOISE_TARGETS = [
    { id: "velocity", label: "Velocity", bit: 1 },
    { id: "color", label: "Color", bit: 2 },
    { id: "size", label: "Size", bit: 4 },
    { id: "opacity", label: "Opacity", bit: 8 },
    { id: "position", label: "Position", bit: 16 },
];

const NOISE_TYPE_INDEX = Object.fromEntries(NOISE_TYPES.map((t, i) => [t.id, i + 1]));

export function defaultNoiseLayer(overrides = {}) {
    return {
        type: "simplex3d",
        frequency: 1.0,
        amplitude: 1.0,
        speed: 1.0,
        octaves: 1,
        seed: 0,
        targets: { velocity: true, color: false, size: false, opacity: false, position: false },
        ...overrides,
    };
}

// Only the enable flag is a "default"; the layer array is resolved by
// mergeNoiseParams so legacy single-noise params can migrate without being
// shadowed by a default layer.
export const DEFAULT_NOISE = {
    noiseEnabled: false,
};

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function normalizeTargets(t = {}) {
    const out = {};
    for (const target of NOISE_TARGETS) out[target.id] = !!t[target.id];
    return out;
}

function normalizeLayer(layer = {}) {
    const base = defaultNoiseLayer();
    return {
        type: NOISE_TYPES.some((t) => t.id === layer.type) ? layer.type : base.type,
        frequency: num(layer.frequency, base.frequency),
        amplitude: num(layer.amplitude, base.amplitude),
        speed: num(layer.speed, base.speed),
        octaves: Math.max(1, Math.min(4, Math.round(num(layer.octaves, base.octaves)))),
        seed: num(layer.seed, base.seed),
        targets: normalizeTargets(layer.targets),
    };
}

/** Build a single layer from the deprecated flat noise params. */
function legacyLayerFromParams(params) {
    const targets = {};
    for (const t of NOISE_TARGETS) {
        const key = `noiseTarget${t.id.charAt(0).toUpperCase()}${t.id.slice(1)}`;
        targets[t.id] = !!params[key];
    }
    return normalizeLayer({
        type: params.noiseType,
        frequency: params.noiseFrequency,
        amplitude: params.noiseAmplitude,
        speed: params.noiseSpeed,
        octaves: params.noiseOctaves,
        seed: params.noiseSeed,
        targets,
    });
}

export function mergeNoiseParams(params = {}) {
    let layers;
    if (Array.isArray(params.noiseLayers) && params.noiseLayers.length) {
        layers = params.noiseLayers.map(normalizeLayer);
    } else if (params.noiseType !== undefined || params.noiseAmplitude !== undefined) {
        // Migrate legacy single-noise config.
        layers = [legacyLayerFromParams(params)];
    } else {
        layers = [defaultNoiseLayer({ amplitude: 0 })];
    }
    layers = layers.slice(0, MAX_NOISE_LAYERS);
    return {
        noiseEnabled: params.noiseEnabled === true,
        noiseLayers: layers,
    };
}

function targetsBitmask(targets) {
    let bits = 0;
    for (const t of NOISE_TARGETS) if (targets[t.id]) bits |= t.bit;
    return bits;
}

/**
 * Pack noise layers for the GPU. Returns { count, layers } where each layer is
 * { type, frequency, amplitude, speed, octaves, targets, seed }. Disabled or
 * zero-amplitude layers are skipped so the shader can `break` early.
 */
export function packNoiseLayers(params = {}) {
    const merged = mergeNoiseParams(params);
    const layers = [];
    if (merged.noiseEnabled) {
        for (const layer of merged.noiseLayers) {
            const bits = targetsBitmask(layer.targets);
            if (bits === 0 || layer.amplitude < 0.0001) continue;
            layers.push({
                type: NOISE_TYPE_INDEX[layer.type] ?? 1,
                frequency: layer.frequency,
                amplitude: layer.amplitude,
                speed: layer.speed,
                octaves: layer.octaves,
                targets: bits,
                seed: layer.seed,
            });
            if (layers.length >= MAX_NOISE_LAYERS) break;
        }
    }
    return { count: layers.length, layers };
}

/**
 * Backward-compatible single-noise uniform set, derived from the first active
 * layer. The grid-volume fluid sim is a single-field simulation and uses this
 * collapsed form rather than the per-particle layered loop.
 */
export function packNoiseUniforms(params = {}) {
    const { count, layers } = packNoiseLayers(params);
    const first = count > 0 ? layers[0] : null;
    return {
        noiseType: first ? first.type : 0,
        noiseFrequency: first ? first.frequency : 1,
        noiseAmplitude: first ? first.amplitude : 0,
        noiseSpeed: first ? first.speed : 1,
        noiseOctaves: first ? first.octaves : 1,
        noiseTargets: first ? first.targets : 0,
        noiseSeed: first ? first.seed : 0,
    };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function layerHtml(layer, index) {
    const typeOpts = NOISE_TYPES.map((t) =>
        `<option value="${t.id}"${layer.type === t.id ? " selected" : ""}>${t.label}</option>`).join("");
    const targetChecks = NOISE_TARGETS.map((t) => {
        const checked = layer.targets[t.id] ? " checked" : "";
        return `<label class="chk"><input type="checkbox" data-nf="target" data-target="${t.id}"${checked} /> ${t.label}</label>`;
    }).join("");

    return `
    <div class="noise-layer" data-noise-layer="${index}">
        <div class="noise-layer-head">
            <span class="noise-layer-title">Layer ${index + 1}</span>
            <button type="button" class="btn-mini" data-nf="remove" title="Remove layer">−</button>
        </div>
        <div class="field compact"><label>Type</label><select data-nf="type">${typeOpts}</select></div>
        <div class="param-grid">
            <div class="field compact"><label>Frequency</label><input type="number" data-nf="frequency" step="0.05" min="0.01" max="32" value="${layer.frequency}" /></div>
            <div class="field compact"><label>Amplitude</label><input type="number" data-nf="amplitude" step="0.05" min="0" max="20" value="${layer.amplitude}" /></div>
            <div class="field compact"><label>Speed</label><input type="number" data-nf="speed" step="0.05" min="0" max="20" value="${layer.speed}" /></div>
            <div class="field compact"><label>Octaves</label><input type="number" data-nf="octaves" step="1" min="1" max="4" value="${layer.octaves}" /></div>
            <div class="field compact"><label>Seed</label><input type="number" data-nf="seed" step="1" value="${layer.seed}" /></div>
        </div>
        <div class="check-row noise-targets">${targetChecks}</div>
    </div>`;
}

export function noisePanelHtml(params = {}) {
    const n = mergeNoiseParams(params);
    const layers = n.noiseLayers.map((layer, i) => layerHtml(layer, i)).join("");
    const canAdd = n.noiseLayers.length < MAX_NOISE_LAYERS;

    return `
        <h2>Noise</h2>
        <div class="check-row">
            <label class="chk"><input id="n-enabled" type="checkbox"${n.noiseEnabled ? " checked" : ""} /> Enable noise</label>
        </div>
        <div id="noise-layers" data-noise-panel>${layers}</div>
        <button type="button" id="btn-noise-add" class="btn-add-layer"${canAdd ? "" : " disabled"}>+ Add noise layer</button>
        <p class="curve-hint">Each layer modulates its chosen aspects independently · 2D types sample on XZ</p>
    `;
}

/** Read every layer back out of the panel DOM. */
export function readNoiseFromUI(params = {}) {
    const out = { ...params };
    const enabled = document.getElementById("n-enabled");
    if (enabled) out.noiseEnabled = enabled.checked;

    const panel = document.getElementById("noise-layers");
    if (!panel) return { ...out, ...mergeNoiseParams(out) };

    const layers = [];
    panel.querySelectorAll(".noise-layer").forEach((el) => {
        const get = (f) => el.querySelector(`[data-nf="${f}"]`);
        const targets = {};
        el.querySelectorAll('[data-nf="target"]').forEach((cb) => {
            targets[cb.dataset.target] = cb.checked;
        });
        layers.push(normalizeLayer({
            type: get("type")?.value,
            frequency: parseFloat(get("frequency")?.value),
            amplitude: parseFloat(get("amplitude")?.value),
            speed: parseFloat(get("speed")?.value),
            octaves: parseInt(get("octaves")?.value, 10),
            seed: parseFloat(get("seed")?.value),
            targets,
        }));
    });
    out.noiseLayers = layers.length ? layers : [defaultNoiseLayer({ amplitude: 0 })];
    // Drop legacy flat keys so they don't shadow the layer array on re-merge.
    for (const key of ["noiseType", "noiseFrequency", "noiseAmplitude", "noiseSpeed", "noiseOctaves", "noiseSeed", "noiseTargets", "noiseTargetVelocity", "noiseTargetColor", "noiseTargetSize", "noiseTargetOpacity", "noiseTargetPosition"]) {
        delete out[key];
    }
    return out;
}

export function bindNoisePanel(onChange) {
    const panel = document.getElementById("noise-layers");
    const addBtn = document.getElementById("btn-noise-add");
    const enabled = document.getElementById("n-enabled");
    if (!panel || panel.dataset.noiseBound) return;
    panel.dataset.noiseBound = "1";

    const rerender = () => {
        const params = readNoiseFromUI({});
        const fresh = noisePanelHtml(params);
        const tmp = document.createElement("div");
        tmp.innerHTML = fresh;
        const newLayers = tmp.querySelector("#noise-layers");
        panel.innerHTML = newLayers.innerHTML;
        if (addBtn) addBtn.disabled = params.noiseLayers.length >= MAX_NOISE_LAYERS;
    };

    enabled?.addEventListener("change", () => onChange?.());

    panel.addEventListener("input", () => onChange?.());
    panel.addEventListener("change", () => onChange?.());
    panel.addEventListener("click", (e) => {
        const removeBtn = e.target.closest('[data-nf="remove"]');
        if (!removeBtn) return;
        const layerEl = removeBtn.closest(".noise-layer");
        if (panel.querySelectorAll(".noise-layer").length <= 1) return;
        layerEl.remove();
        rerender();
        onChange?.();
    });

    addBtn?.addEventListener("click", () => {
        const params = readNoiseFromUI({});
        if (params.noiseLayers.length >= MAX_NOISE_LAYERS) return;
        params.noiseLayers.push(defaultNoiseLayer());
        const tmp = document.createElement("div");
        tmp.innerHTML = noisePanelHtml(params);
        panel.innerHTML = tmp.querySelector("#noise-layers").innerHTML;
        addBtn.disabled = params.noiseLayers.length >= MAX_NOISE_LAYERS;
        onChange?.();
    });
}
