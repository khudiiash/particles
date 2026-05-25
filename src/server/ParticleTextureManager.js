"use strict";

const fs = require("fs");
const path = require("path");
const { TEXTURES_DIR } = require("./paths");

const ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function ensureDir(dir) {
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function sanitizeFilename(name) {
	const base = path.basename(name || "texture.png").replace(/[^a-zA-Z0-9._-]/g, "_");
	const ext = path.extname(base).toLowerCase();
	if (!ALLOWED_EXT.has(ext)) {
		throw new Error(`Unsupported texture type "${ext || "(none)"}"`);
	}
	return base;
}

function publicPath(filename) {
	return `particle-textures/${filename}`;
}

class ParticleTextureManager {
	constructor(options = {}) {
		this.texturesDir = options.texturesDir || TEXTURES_DIR;
	}

	list() {
		ensureDir(this.texturesDir);
		return fs.readdirSync(this.texturesDir)
			.filter((f) => ALLOWED_EXT.has(path.extname(f).toLowerCase()))
			.sort()
			.map((filename) => ({ id: filename, path: publicPath(filename) }));
	}

	save(filename, buffer) {
		ensureDir(this.texturesDir);
		if (!buffer || buffer.length === 0) throw new Error("Empty texture data");
		if (buffer.length > 8 * 1024 * 1024) throw new Error("Texture too large (max 8MB)");
		const safe = sanitizeFilename(filename);
		const full = path.join(this.texturesDir, safe);
		fs.writeFileSync(full, buffer);
		return { filename: safe, path: publicPath(safe) };
	}

	saveBase64(filename, dataBase64) {
		if (!dataBase64) throw new Error("Missing texture data");
		const buffer = Buffer.from(dataBase64, "base64");
		if (buffer.length === 0) throw new Error("Empty texture data");
		if (buffer.length > 8 * 1024 * 1024) throw new Error("Texture too large (max 8MB)");
		return this.save(filename, buffer);
	}
}

const manager = new ParticleTextureManager();

module.exports = {
	ParticleTextureManager,
	manager,
	publicPath,
	TEXTURES_DIR,
};
