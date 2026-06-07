/** Bundled preset effects (params/curves/path/render only — no embedded WGSL). */
import basic from "./basic.json";
import boids from "./boids.json";
import collision from "./collision.json";
import grass from "./grass.json";
import shapes from "./shapes.json";
import smoke from "./smoke.json";
import spiral from "./spiral.json";
import water from "./water.json";

/** @type {Record<string, object>} */
export const PRESETS = {
	basic,
	boids,
	collision,
	grass,
	shapes,
	smoke,
	spiral,
	water,
};

/** Effects shipped read-only; the editor offers "save as new" copies of these. */
export const TEMPLATE_EFFECT_IDS = ["basic"];

export function listPresets() {
	return Object.entries(PRESETS).map(([id, effect]) => ({
		id,
		name: effect.name || id,
		template: TEMPLATE_EFFECT_IDS.includes(id),
	}));
}

export function getPreset(id) {
	return PRESETS[id] ? structuredClone(PRESETS[id]) : null;
}
