#!/usr/bin/env node
"use strict";

const express = require("express");
const { mountParticleEditor } = require("../src/server/express");

const port = Number(process.env.PORT || 3099);
const app = express();

app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type");
	if (req.method === "OPTIONS") return res.sendStatus(204);
	next();
});

app.use(express.json({ limit: "10mb" }));
mountParticleEditor(app);

app.listen(port, () => {
	console.log(`GPU particle editor at http://localhost:${port}/particle-editor`);
});
