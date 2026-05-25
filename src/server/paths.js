"use strict";

const path = require("path");

const PKG_ROOT = path.resolve(__dirname, "../..");
const PUBLIC_DIR = path.join(PKG_ROOT, "public");

module.exports = {
	PKG_ROOT,
	PUBLIC_DIR,
	EFFECTS_DIR: path.join(PUBLIC_DIR, "particle-effects"),
	TEXTURES_DIR: path.join(PUBLIC_DIR, "particle-textures"),
	CANONICAL_RENDER_PATH: path.join(PUBLIC_DIR, "particles/canonical-render.json"),
	CANONICAL_SIMULATION_PATH: path.join(PUBLIC_DIR, "particles/canonical-simulation.json"),
};
