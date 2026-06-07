/**
 * @khudiiash/particles-core
 *
 * Shared, framework-agnostic particle engine:
 *  - effect config schema, defaults, migration and merging
 *  - GPU uniform / path / noise packing (CPU -> WebGPU buffers)
 *  - the canonical WGSL simulation + render shaders (in-repo source of truth)
 *  - a headless `ParticleSimulation` WebGPU compute runner
 *
 * This module never imports three.js or any renderer, so it is safe to use from
 * node, the three.js runtime, the PlayCanvas runtime and the editor alike.
 */
export * from "./layout.js";
export * from "./curves.js";
export * from "./path.js";
export * from "./noise.js";
export * from "./noiseWgsl.js";
export * from "./render.js";
export * from "./mpm-gpu.js";
export * from "./fluid-params.js";

export { ParticleSimulation, PARTICLE_BYTES } from "./engine/ParticleSimulation.js";
export { CANONICAL_RENDER, CANONICAL_SIMULATION, applyCanonicalShaders } from "../wgsl/index.js";

import { migrateEffect } from "./curves.js";
import { applyCanonicalShaders } from "../wgsl/index.js";

/**
 * One-shot: migrate a stored effect config to the current schema and attach the
 * canonical WGSL shaders. The result is ready to feed into `ParticleSimulation`
 * or either runtime player.
 * @param {object} config
 */
export function resolveEffect(config) {
	return applyCanonicalShaders(migrateEffect(config));
}
