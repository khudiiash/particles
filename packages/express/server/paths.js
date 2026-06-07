"use strict";

const path = require("path");

// packages/express/server -> monorepo root
const PKG_ROOT = path.resolve(__dirname, "../../..");

const CORE_DIR = path.join(PKG_ROOT, "packages/core");
const EDITOR_DIR = path.join(PKG_ROOT, "apps/editor");
const EDITOR_DIST = path.join(EDITOR_DIR, "dist");

module.exports = {
	PKG_ROOT,
	CORE_DIR,
	EDITOR_DIR,
	EDITOR_DIST,
	// Kept for backwards-compat with the previous single-package layout.
	PUBLIC_DIR: EDITOR_DIST,
	EFFECTS_DIR: path.join(CORE_DIR, "effects"),
	TEXTURES_DIR: path.join(EDITOR_DIR, "public/particle-textures"),
	CANONICAL_RENDER_PATH: path.join(CORE_DIR, "wgsl/render.json"),
	CANONICAL_SIMULATION_PATH: path.join(CORE_DIR, "wgsl/simulation.json"),
};
