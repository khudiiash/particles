"use strict";

const fs = require("fs");
const path = require("path");
const {
	EFFECTS_DIR,
	CANONICAL_RENDER_PATH,
	CANONICAL_SIMULATION_PATH,
} = require("./paths");

const TEMPLATE_EFFECT_IDS = new Set(["basic"]);

let cachedCanonicalRender = null;
let cachedCanonicalSimulation = null;

function loadCanonicalRender() {
	if (!cachedCanonicalRender) {
		cachedCanonicalRender = JSON.parse(fs.readFileSync(CANONICAL_RENDER_PATH, "utf8"));
	}
	return cachedCanonicalRender;
}

function loadCanonicalSimulation() {
	if (!cachedCanonicalSimulation) {
		cachedCanonicalSimulation = JSON.parse(fs.readFileSync(CANONICAL_SIMULATION_PATH, "utf8"));
	}
	return cachedCanonicalSimulation;
}

/** Attach shared WGSL from public/particles/canonical-*.json (runtime/editor use). */
function applyCanonicalShaders(effect) {
	const render = loadCanonicalRender();
	const simulation = loadCanonicalSimulation();
	const out = structuredClone(effect);
	out.simulation = {
		...out.simulation,
		entryPoint: out.simulation?.entryPoint || simulation.entryPoint,
		wgsl: simulation.wgsl,
	};
	out.render = {
		...out.render,
		wgslShared: render.wgslShared,
		vertexWgsl: render.vertexWgsl,
		fragmentWgsl: render.fragmentWgsl,
	};
	return out;
}

/** Disk format: params/curves/path/render only — no embedded shader source. */
function stripForStorage(effect) {
	const simulation = loadCanonicalSimulation();
	const out = structuredClone(effect);
	out.simulation = {
		entryPoint: out.simulation?.entryPoint || simulation.entryPoint,
	};
	if (out.render) {
		delete out.render.wgslShared;
		delete out.render.vertexWgsl;
		delete out.render.fragmentWgsl;
	}
	return out;
}

function sanitizeId(id) {
	if (!id || typeof id !== "string") throw new Error("Effect id is required");
	return id.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function isTemplateEffect(id) {
	if (!id) return false;
	return TEMPLATE_EFFECT_IDS.has(sanitizeId(id));
}

function effectPath(id) {
	return path.join(EFFECTS_DIR, `${sanitizeId(id)}.json`);
}

function validateStoredEffect(effect) {
	if (!effect || typeof effect !== "object") throw new Error("Effect must be an object");
	if (!effect.name || typeof effect.name !== "string") throw new Error("Effect must have a name");
	if (!Number.isFinite(effect.maxParticles) || effect.maxParticles < 1) {
		throw new Error("maxParticles must be a positive number");
	}
	effect.version = effect.version || 2;
	effect.params = effect.params || {};
	effect.workgroupSize = effect.workgroupSize || 64;
	effect.curves = effect.curves || {};
	effect.render = effect.render || {};
	effect.simulation = effect.simulation || {};
	return effect;
}

function readStoredEffect(id) {
	const file = effectPath(id);
	if (!fs.existsSync(file)) return null;
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

class ParticleEffectManager {
	constructor(options = {}) {
		this.effectsDir = options.effectsDir || EFFECTS_DIR;
		this.canonicalRenderPath = options.canonicalRenderPath || CANONICAL_RENDER_PATH;
		this.canonicalSimulationPath = options.canonicalSimulationPath || CANONICAL_SIMULATION_PATH;
	}

	list() {
		if (!fs.existsSync(this.effectsDir)) fs.mkdirSync(this.effectsDir, { recursive: true });

		return fs
			.readdirSync(this.effectsDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => {
				const id = f.slice(0, -5);
				const raw = JSON.parse(fs.readFileSync(path.join(this.effectsDir, f), "utf8"));
				return {
					id,
					name: raw.name || id,
					maxParticles: raw.maxParticles,
					version: raw.version || 1,
				};
			})
			.sort((a, b) => a.id.localeCompare(b.id));
	}

	/** Returns stored effect JSON (params only — no embedded WGSL). */
	get(id) {
		return readStoredEffect(id);
	}

	save(effect, options = {}) {
		const stored = stripForStorage(validateStoredEffect(structuredClone(effect)));
		const id = sanitizeId(stored.name);
		const previousId = options.previousId ? sanitizeId(options.previousId) : null;

		if (isTemplateEffect(id)) {
			throw new Error(`"${id}" is a read-only template and cannot be saved`);
		}

		if (!fs.existsSync(this.effectsDir)) fs.mkdirSync(this.effectsDir, { recursive: true });

		fs.writeFileSync(path.join(this.effectsDir, `${id}.json`), JSON.stringify(stored, null, 2) + "\n");

		if (
			previousId
			&& previousId !== id
			&& !isTemplateEffect(previousId)
			&& fs.existsSync(path.join(this.effectsDir, `${previousId}.json`))
		) {
			fs.unlinkSync(path.join(this.effectsDir, `${previousId}.json`));
		}

		return { id, effect: stored };
	}

	delete(id) {
		const safeId = sanitizeId(id);
		if (isTemplateEffect(safeId)) {
			throw new Error(`"${safeId}" is a read-only template and cannot be deleted`);
		}
		const file = path.join(this.effectsDir, `${safeId}.json`);
		if (!fs.existsSync(file)) throw new Error(`Effect '${safeId}' not found`);

		const remaining = this.list().filter((e) => e.id !== safeId);
		if (remaining.length === 0) {
			throw new Error("Cannot delete the last particle effect");
		}

		fs.unlinkSync(file);
		return { ok: true, id: safeId };
	}

	duplicate(id, newName) {
		const source = this.get(id);
		if (!source) throw new Error(`Effect '${sanitizeId(id)}' not found`);
		if (!newName || typeof newName !== "string") throw new Error("newName is required");

		const copy = structuredClone(source);
		copy.name = newName.trim();
		const newId = sanitizeId(copy.name);
		if (fs.existsSync(path.join(this.effectsDir, `${newId}.json`))) {
			throw new Error(`Effect '${newId}' already exists`);
		}
		return this.save(copy);
	}

	/** Rewrite on-disk effects without embedded WGSL (one-time / maintenance). */
	compactAll() {
		if (!fs.existsSync(this.effectsDir)) return { compacted: 0 };

		let compacted = 0;
		for (const file of fs.readdirSync(this.effectsDir).filter((f) => f.endsWith(".json"))) {
			const filePath = path.join(this.effectsDir, file);
			const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
			const hadShader = Boolean(
				raw.simulation?.wgsl
				|| raw.render?.wgslShared
				|| raw.render?.vertexWgsl
				|| raw.render?.fragmentWgsl,
			);
			const stored = stripForStorage(validateStoredEffect(raw));
			fs.writeFileSync(filePath, JSON.stringify(stored, null, 2) + "\n");
			if (hadShader) compacted += 1;
		}
		return { compacted };
	}
}

const manager = new ParticleEffectManager();

module.exports = {
	ParticleEffectManager,
	manager,
	sanitizeId,
	isTemplateEffect,
	TEMPLATE_EFFECT_IDS,
	applyCanonicalShaders,
	stripForStorage,
	validateStoredEffect,
};
