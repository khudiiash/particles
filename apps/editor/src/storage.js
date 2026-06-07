/**
 * Client-side persistence for the serverless editor.
 *
 * Implements the same surface the old Express REST API exposed, but backed by
 * bundled presets (read-only) + browser localStorage (user effects) + a texture
 * store that keeps uploaded images as data URLs. The shape is intentionally a
 * pluggable adapter so a cloud backend (Supabase, serverless functions, ...) can
 * be dropped in later without touching the editor UI.
 */
import { PRESETS, TEMPLATE_EFFECT_IDS } from "@khudiiash/particles-core/effects";

const EFFECTS_KEY = "gpu-particle-editor:effects";
const TEXTURES_KEY = "gpu-particle-editor:textures";

function sanitizeId(id) {
	if (!id || typeof id !== "string") throw new Error("Effect id is required");
	return id.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
}

function readStore(key) {
	try {
		return JSON.parse(localStorage.getItem(key) || "{}") || {};
	} catch {
		return {};
	}
}

function writeStore(key, value) {
	localStorage.setItem(key, JSON.stringify(value));
}

export class ClientStorageAdapter {
	get templateIds() {
		return new Set(TEMPLATE_EFFECT_IDS);
	}

	isTemplate(id) {
		return this.templateIds.has(sanitizeId(id));
	}

	/** Merged list of preset + user effects, user entries winning on id clash. */
	list() {
		const user = readStore(EFFECTS_KEY);
		const byId = new Map();
		for (const [id, effect] of Object.entries(PRESETS)) {
			byId.set(id, { id, name: effect.name || id, template: this.isTemplate(id) });
		}
		for (const [id, effect] of Object.entries(user)) {
			byId.set(id, { id, name: effect.name || id, template: false });
		}
		return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	get(id) {
		const safe = sanitizeId(id);
		const user = readStore(EFFECTS_KEY);
		if (user[safe]) return structuredClone(user[safe]);
		if (PRESETS[safe]) return structuredClone(PRESETS[safe]);
		return null;
	}

	save(effect, { previousId } = {}) {
		const id = sanitizeId(effect.name);
		if (this.isTemplate(id)) {
			throw new Error(`"${id}" is a read-only template and cannot be overwritten`);
		}
		const user = readStore(EFFECTS_KEY);
		user[id] = structuredClone(effect);
		const prev = previousId ? sanitizeId(previousId) : null;
		if (prev && prev !== id && !this.isTemplate(prev)) delete user[prev];
		writeStore(EFFECTS_KEY, user);
		return { id, effect: user[id] };
	}

	delete(id) {
		const safe = sanitizeId(id);
		if (this.isTemplate(safe)) {
			throw new Error(`"${safe}" is a read-only template and cannot be deleted`);
		}
		const user = readStore(EFFECTS_KEY);
		if (!user[safe]) throw new Error(`Effect '${safe}' not found`);
		delete user[safe];
		writeStore(EFFECTS_KEY, user);
		return { ok: true, id: safe };
	}

	duplicate(id, newName) {
		const source = this.get(id);
		if (!source) throw new Error(`Effect '${sanitizeId(id)}' not found`);
		source.name = (newName || `${source.name} copy`).trim();
		return this.save(source);
	}

	// --- textures ---------------------------------------------------------

	listTextures() {
		const store = readStore(TEXTURES_KEY);
		return Object.entries(store).map(([id, dataUrl]) => ({ id, path: dataUrl }));
	}

	async uploadTexture(file) {
		const dataUrl = await fileToDataUrl(file);
		const store = readStore(TEXTURES_KEY);
		const id = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
		store[id] = dataUrl;
		writeStore(TEXTURES_KEY, store);
		return { filename: id, path: dataUrl };
	}
}

function fileToDataUrl(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

export const storage = new ClientStorageAdapter();
