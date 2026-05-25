export const NOISE_TYPES = [
    { id: "simplex3d", label: "Simplex 3D" },
    { id: "simplex2d", label: "Simplex 2D" },
    { id: "perlin3d", label: "Perlin 3D" },
    { id: "perlin2d", label: "Perlin 2D" },
    { id: "voronoi", label: "Voronoi" },
];

export const NOISE_TARGETS = [
    { id: "velocity", label: "Velocity / movement", bit: 1 },
    { id: "color", label: "Color", bit: 2 },
    { id: "size", label: "Size", bit: 4 },
    { id: "opacity", label: "Opacity", bit: 8 },
    { id: "position", label: "Position drift", bit: 16 },
];

export const DEFAULT_NOISE = {
    noiseEnabled: false,
    noiseType: "simplex3d",
    noiseFrequency: 1.0,
    noiseAmplitude: 0.0,
    noiseSpeed: 1.0,
    noiseOctaves: 1,
    noiseSeed: 0,
    noiseTargetVelocity: false,
    noiseTargetColor: false,
    noiseTargetSize: false,
    noiseTargetOpacity: false,
    noiseTargetPosition: false,
};

const NOISE_TYPE_INDEX = Object.fromEntries(
    NOISE_TYPES.map((t, i) => [t.id, i + 1]),
);

export function mergeNoiseParams(params = {}) {
    const merged = { ...DEFAULT_NOISE };
    for (const key of Object.keys(DEFAULT_NOISE)) {
        if (params[key] !== undefined) merged[key] = params[key];
    }
    return merged;
}

export function packNoiseUniforms(params = {}) {
    const n = mergeNoiseParams(params);
    const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    const enabled = n.noiseEnabled === true;
    let targets = 0;
    if (enabled) {
        for (const t of NOISE_TARGETS) {
            const key = `noiseTarget${t.id.charAt(0).toUpperCase()}${t.id.slice(1)}`;
            if (n[key]) targets |= t.bit;
        }
    }
    return {
        noiseType: enabled ? (NOISE_TYPE_INDEX[n.noiseType] ?? 1) : 0,
        noiseFrequency: finite(n.noiseFrequency, 1),
        noiseAmplitude: finite(n.noiseAmplitude, 0),
        noiseSpeed: finite(n.noiseSpeed, 1),
        noiseOctaves: finite(n.noiseOctaves, 1),
        noiseTargets: targets,
        noiseSeed: finite(n.noiseSeed, 0),
    };
}

export function noisePanelHtml(params = {}) {
    const n = mergeNoiseParams(params);
    const typeOpts = NOISE_TYPES.map((t) =>
        `<option value="${t.id}"${n.noiseType === t.id ? " selected" : ""}>${t.label}</option>`).join("");
    const targetChecks = NOISE_TARGETS.map((t) => {
        const key = `noiseTarget${t.id.charAt(0).toUpperCase()}${t.id.slice(1)}`;
        const checked = n[key] ? " checked" : "";
        return `<label class="chk"><input id="n-target-${t.id}" type="checkbox"${checked} /> ${t.label}</label>`;
    }).join("");

    return `
        <h2>Noise</h2>
        <div class="check-row">
            <label class="chk"><input id="n-enabled" type="checkbox"${n.noiseEnabled ? " checked" : ""} /> Enable noise</label>
        </div>
        <div class="field compact"><label>Type</label><select id="n-type">${typeOpts}</select></div>
        <div class="param-grid">
            <div class="field compact"><label>Frequency</label><input id="n-frequency" type="number" step="0.05" min="0.01" max="32" value="${n.noiseFrequency}" /></div>
            <div class="field compact"><label>Amplitude</label><input id="n-amplitude" type="number" step="0.05" min="0" max="20" value="${n.noiseAmplitude}" /></div>
            <div class="field compact"><label>Speed</label><input id="n-speed" type="number" step="0.05" min="0" max="20" value="${n.noiseSpeed}" /></div>
            <div class="field compact"><label>Octaves</label><input id="n-octaves" type="number" step="1" min="1" max="4" value="${n.noiseOctaves}" /></div>
            <div class="field compact"><label>Seed</label><input id="n-seed" type="number" step="1" value="${n.noiseSeed}" /></div>
        </div>
        <p class="curve-hint">Modulates particle params each frame · 2D types sample on XZ</p>
        <div class="check-row noise-targets">${targetChecks}</div>
    `;
}

export function readNoiseFromUI(params = {}) {
    const out = { ...params, ...mergeNoiseParams(params) };
    const enabled = document.getElementById("n-enabled");
    const type = document.getElementById("n-type");
    if (enabled) out.noiseEnabled = enabled.checked;
    if (type) out.noiseType = type.value;
    for (const key of ["frequency", "amplitude", "speed", "octaves", "seed"]) {
        const el = document.getElementById(`n-${key}`);
        if (!el) continue;
        const v = parseFloat(el.value);
        if (!Number.isNaN(v)) {
            out[`noise${key.charAt(0).toUpperCase()}${key.slice(1)}`] = v;
        }
    }
    for (const t of NOISE_TARGETS) {
        const el = document.getElementById(`n-target-${t.id}`);
        const paramKey = `noiseTarget${t.id.charAt(0).toUpperCase()}${t.id.slice(1)}`;
        if (el) out[paramKey] = el.checked;
    }
    return out;
}

export function bindNoisePanel(onChange) {
    const ids = ["n-enabled", "n-type", "n-frequency", "n-amplitude", "n-speed", "n-octaves", "n-seed"];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el || el.dataset.noiseBound) continue;
        el.dataset.noiseBound = "1";
        el.addEventListener("change", () => onChange?.());
        el.addEventListener("input", () => onChange?.());
    }
    for (const t of NOISE_TARGETS) {
        const el = document.getElementById(`n-target-${t.id}`);
        if (!el || el.dataset.noiseBound) continue;
        el.dataset.noiseBound = "1";
        el.addEventListener("change", () => onChange?.());
    }
}
