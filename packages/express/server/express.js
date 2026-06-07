"use strict";

const path = require("path");
const express = require("express");
const { PUBLIC_DIR, TEXTURES_DIR } = require("./paths");
const { manager: particleEffectManager } = require("./ParticleEffectManager");
const { manager: particleTextureManager } = require("./ParticleTextureManager");

async function defaultReadBody(req) {
	if (typeof req.readBody === "function") await req.readBody();
	const raw = (req._rawbody && req._rawbody.toString()) || req.body || "";
	return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
}

/**
 * Mount particle editor static assets and REST API on an Express app.
 *
 * @param {import("express").Application} app
 * @param {object} [options]
 * @param {string} [options.publicDir] - Override bundled public assets directory
 * @param {string} [options.editorPath="/particle-editor"] - URL path for the editor page
 * @param {(req: import("express").Request) => Promise<object>} [options.readBody] - JSON body parser
 */
function mountParticleEditor(app, options = {}) {
	const publicDir = options.publicDir || PUBLIC_DIR;
	const editorPath = options.editorPath || "/particle-editor";
	const readBody = options.readBody || defaultReadBody;

	app.use(express.static(publicDir));
	app.use("/particle-textures", express.static(TEXTURES_DIR));

	app.get(editorPath, (req, res) => {
		res.sendFile(path.join(publicDir, "index.html"));
	});

	app.get("/api/particle-effects", (req, res) => {
		try {
			res.json({ effects: particleEffectManager.list() });
		} catch (e) {
			res.status(500).send(e.message);
		}
	});

	app.get("/api/particle-effects/:id", (req, res) => {
		try {
			const effect = particleEffectManager.get(req.params.id);
			if (!effect) return res.status(404).send("Not found");
			res.json(effect);
		} catch (e) {
			res.status(500).send(e.message);
		}
	});

	app.post("/api/particle-effects/save", async (req, res) => {
		try {
			const body = await readBody(req);
			const saved = particleEffectManager.save(body.effect, {
				previousId: body.previousId,
			});
			res.json(saved);
		} catch (e) {
			res.status(400).send(e.message);
		}
	});

	app.post("/api/particle-effects/delete", async (req, res) => {
		try {
			const body = await readBody(req);
			res.json(particleEffectManager.delete(body.id));
		} catch (e) {
			res.status(400).send(e.message);
		}
	});

	app.post("/api/particle-effects/duplicate", async (req, res) => {
		try {
			const body = await readBody(req);
			const saved = particleEffectManager.duplicate(body.id, body.newName);
			res.json(saved);
		} catch (e) {
			res.status(400).send(e.message);
		}
	});

	app.get("/api/particle-textures", (req, res) => {
		try {
			res.json({ textures: particleTextureManager.list() });
		} catch (e) {
			res.status(500).send(e.message);
		}
	});

	app.post(
		"/api/particle-textures/upload",
		express.raw({
			limit: "10mb",
			type: (req) => !(req.headers["content-type"] || "").includes("application/json"),
		}),
		async (req, res) => {
			try {
				const filename = req.query.filename || req.headers["x-filename"] || "texture.png";
				const buffer = req.body;
				if (!buffer || !buffer.length) throw new Error("Missing texture data");
				const saved = particleTextureManager.save(filename, buffer);
				res.json(saved);
			} catch (e) {
				res.status(400).send(e.message);
			}
		},
	);
}

module.exports = { mountParticleEditor, PUBLIC_DIR };
