#!/usr/bin/env node
"use strict";

/**
 * Optional self-hosted dev server. Serves the built editor (apps/editor/dist)
 * and the effect/texture REST API. Run `npm run build:editor` first so the
 * static bundle exists.
 *
 * The editor itself is designed to run fully client-side on serverless static
 * hosting (Netlify / GitHub Pages); this server is only needed when you want a
 * shared, persistent backend.
 */
const fs = require("fs");
const express = require("express");
const { mountParticleEditor } = require("./server/express");
const { EDITOR_DIST } = require("./server/paths");

const PORT = process.env.PORT || 3099;

const app = express();
mountParticleEditor(app);

app.get("/", (req, res) => res.redirect("/particle-editor"));

app.listen(PORT, () => {
	if (!fs.existsSync(EDITOR_DIST)) {
		console.warn(
			"[gpu-particle-editor] No editor build found at apps/editor/dist.\n" +
				"  Run `npm run build:editor` first (or `npm run dev` for the Vite dev server).",
		);
	}
	console.log(`[gpu-particle-editor] http://localhost:${PORT}/particle-editor`);
});
