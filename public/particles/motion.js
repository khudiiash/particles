import { velocityCurveHtml, rotationCurveHtml } from "./curves.js";
import { pathParamHtml } from "./path.js";

export const MOTION_MODES = [
    { id: "velocity", label: "Velocity" },
    { id: "spline", label: "Spline path" },
    { id: "boids", label: "Boids" },
    { id: "fluid", label: "Fluid" },
    { id: "hair", label: "Hair / grass" },
];

export const BOIDS_FIELDS = [
    { key: "boidsNeighborRadius", label: "Vision radius", step: 0.05, min: 0.15, default: 2.0 },
    { key: "boidsSeparation", label: "Separation", step: 0.05, min: 0, default: 0.3 },
    { key: "boidsAlignment", label: "Alignment", step: 0.05, min: 0, default: 2.0 },
    { key: "boidsCohesion", label: "Cohesion", step: 0.05, min: 0, default: 4.0 },
    { key: "boidsMaxSpeed", label: "Max speed", step: 0.1, min: 0.1, default: 5.0 },
];

export const FLUID_FIELDS = [
    { key: "fluidGridSize", label: "Voxel resolution", step: 1, min: 16, max: 192, default: 64 },
    { key: "fluidEmitStrength", label: "Emit strength", step: 0.1, min: 0.1, max: 8, default: 1 },
    { key: "fluidSpeed", label: "Sim speed", step: 0.05, min: 0.05, max: 3, default: 1 },
    { key: "fluidSmokeDecay", label: "Smoke decay", step: 0.05, min: 0, max: 5, default: 0.5 },
    { key: "fluidPressureIterations", label: "Pressure iterations", step: 1, min: 2, max: 32, default: 4 },
    { key: "fluidBuoyancy", label: "Buoyancy", step: 0.05, min: 0, max: 5, default: 0.5 },
    { key: "fluidBurnRate", label: "Burn rate", step: 0.05, min: 0, max: 5, default: 0.8 },
    { key: "fluidIgnitionTemp", label: "Heat (0 = smoke)", step: 10, min: 0, max: 6000, default: 0 },
    { key: "fluidVorticityAmount", label: "Vorticity", step: 0.1, min: 0, max: 20, default: 1 },
];

export const HAIR_FIELDS = [
    { key: "hairLength", label: "Strand length", step: 0.05, min: 0.05, default: 0.6 },
    { key: "hairSegments", label: "Segments", step: 1, min: 1, default: 8 },
    { key: "hairStiffness", label: "Stiffness", step: 0.01, min: 0, max: 0.99, default: 0.78 },
    { key: "hairGravity", label: "Gravity bend", step: 0.05, min: 0, default: 1.0 },
    { key: "hairGrowth", label: "Growth curve", step: 0.05, min: 0.05, default: 0.65 },
    { key: "hairRandomTilt", label: "Random tilt", step: 0.05, min: 0, default: 0.35 },
];

function paramGridHtml(fields, params) {
    return fields.map((f) => {
        const val = params[f.key] ?? f.default;
        const attrs = [
            `step="${f.step}"`,
            f.min != null ? `min="${f.min}"` : "",
            f.max != null ? `max="${f.max}"` : "",
        ].filter(Boolean).join(" ");
        return `<div class="field compact"><label>${f.label}</label><input id="p-${f.key}" type="number" ${attrs} value="${val}" /></div>`;
    }).join("");
}

export function motionPanelHtml(params, curves) {
    const mode = ["velocity", "spline", "boids", "fluid", "hair"].includes(params.motionMode)
        ? params.motionMode
        : "velocity";
    const opts = MOTION_MODES.map((m) =>
        `<option value="${m.id}"${mode === m.id ? " selected" : ""}>${m.label}</option>`).join("");

    return `
        <h2>Motion</h2>
        <div class="field compact">
            <label>Mode</label>
            <select id="p-motionMode">${opts}</select>
        </div>
        <div id="panel-motion-velocity"${mode === "velocity" ? "" : ' class="hidden"'}>
            ${velocityCurveHtml(curves.velocity)}
        </div>
        <div id="panel-motion-spline"${mode === "spline" ? "" : ' class="hidden"'}>
            ${pathParamHtml(params)}
        </div>
        <div id="panel-motion-boids"${mode === "boids" ? "" : ' class="hidden"'}>
            <p class="hint">Classic flocking (boids-js). Boids live forever — set Emit spread to 0. Fill bounds box, ~512 particles, Rebuild after switching mode.</p>
            <div class="param-grid">${paramGridHtml(BOIDS_FIELDS, params)}</div>
        </div>
        <div id="panel-motion-fluid"${mode === "fluid" ? "" : ' class="hidden"'}>
            <p class="hint">Spawn shape = plume form (plane = floor jet). Velocity X/Y/Z = direction. Color curve t=0 = smoke tint. Buoyancy vs Gravity = rise/fall.</p>
            <div class="field compact">
                <label><input type="checkbox" id="p-fluidEnclosed"${params.fluidEnclosed !== false ? " checked" : ""} /> Enclosed volume</label>
            </div>
            <div class="field compact">
                <label><input type="checkbox" id="p-fluidVorticity"${params.fluidVorticity ? " checked" : ""} /> Vorticity confinement</label>
            </div>
            <div class="param-grid">${paramGridHtml(FLUID_FIELDS, params)}</div>
        </div>
        <div id="panel-motion-hair"${mode === "hair" ? "" : ' class="hidden"'}>
            <p class="hint">Strands stick to a plane surface. Use spawn shape <strong>Plane</strong> and set spawn radius. Color graph maps root → tip along each strand.</p>
            <div class="param-grid">${paramGridHtml(HAIR_FIELDS, params)}</div>
        </div>
        <h2>Rotation</h2>
        ${rotationCurveHtml(curves.rotation)}
    `;
}

function applyModeDefaults(mode) {
    if (mode === "hair") {
        const spawnShape = document.getElementById("p-spawnShape");
        if (spawnShape && spawnShape.value !== "plane") {
            spawnShape.value = "plane";
            spawnShape.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const spawnRadius = document.getElementById("p-spawnRadius");
        if (spawnRadius && Number(spawnRadius.value) <= 0) {
            spawnRadius.value = "1";
            spawnRadius.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }

    if (mode === "fluid") {
        const gridSize = document.getElementById("p-fluidGridSize");
        if (gridSize && Number(gridSize.value) < 16) {
            gridSize.value = "64";
            gridSize.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }

    if (mode === "boids") {
        const collisionMode = document.getElementById("r-collisionMode");
        if (collisionMode && collisionMode.value === "none") {
            collisionMode.value = "box";
            collisionMode.dispatchEvent(new Event("change", { bubbles: true }));
        }
        for (const id of ["r-boundsWidth", "r-boundsHeight", "r-boundsDepth", "r-boundsRadius"]) {
            const el = document.getElementById(id);
            if (el && Number(el.value) <= 1) {
                el.value = "5";
                el.dispatchEvent(new Event("input", { bubbles: true }));
            }
        }
        const maxParticles = document.getElementById("f-max");
        if (maxParticles && Number(maxParticles.value) > 1024) {
            maxParticles.value = "1024";
            maxParticles.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const emitSpread = document.getElementById("p-emitSpread");
        if (emitSpread && Number(emitSpread.value) !== 0) {
            emitSpread.value = "0";
            emitSpread.dispatchEvent(new Event("input", { bubbles: true }));
        }
        const spawnRadius = document.getElementById("p-spawnRadius");
        if (spawnRadius && Number(spawnRadius.value) !== 0) {
            spawnRadius.value = "0";
            spawnRadius.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }
}

export function bindMotionModePanels(root = document) {
    const select = root.getElementById?.("p-motionMode") || document.getElementById("p-motionMode");
    if (!select) return;

    const syncPanels = () => {
        const mode = select.value;
        document.getElementById("panel-motion-velocity")?.classList.toggle("hidden", mode !== "velocity");
        document.getElementById("panel-motion-spline")?.classList.toggle("hidden", mode !== "spline");
        document.getElementById("panel-motion-boids")?.classList.toggle("hidden", mode !== "boids");
        document.getElementById("panel-motion-fluid")?.classList.toggle("hidden", mode !== "fluid");
        document.getElementById("panel-motion-hair")?.classList.toggle("hidden", mode !== "hair");
        window.dispatchEvent(new CustomEvent("particle-motion-mode", { detail: { mode } }));
    };

    if (!select.dataset.bound) {
        select.dataset.bound = "1";
        select.addEventListener("change", () => {
            applyModeDefaults(select.value);
            syncPanels();
        });
    }
    syncPanels();
}
