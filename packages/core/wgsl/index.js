/**
 * Canonical WGSL shaders, bundled as the in-repo source of truth.
 * These replace the runtime fetch of `/particles/canonical-*.json`.
 */
import render from "./render.json";
import simulation from "./simulation.json";

export const CANONICAL_RENDER = render;
export const CANONICAL_SIMULATION = simulation;

/**
 * Attach canonical shader source to an effect config (mirrors the old
 * server-side `applyCanonicalShaders`). Mutates and returns `cfg`.
 */
export function applyCanonicalShaders(cfg) {
	cfg.simulation = {
		entryPoint: cfg.simulation?.entryPoint || simulation.entryPoint,
		wgsl: simulation.wgsl,
	};
	cfg.render = {
		...cfg.render,
		wgslShared: render.wgslShared,
		vertexWgsl: render.vertexWgsl,
		fragmentWgsl: render.fragmentWgsl,
	};
	return cfg;
}
