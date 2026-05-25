"use strict";

const { mountParticleEditor, PUBLIC_DIR } = require("./server/express");
const { ParticleEffectManager, manager: particleEffectManager, applyCanonicalShaders } = require("./server/ParticleEffectManager");
const { ParticleTextureManager, manager: particleTextureManager } = require("./server/ParticleTextureManager");
const paths = require("./server/paths");

module.exports = {
	mountParticleEditor,
	PUBLIC_DIR,
	paths,
	ParticleEffectManager,
	particleEffectManager,
	ParticleTextureManager,
	particleTextureManager,
	applyCanonicalShaders,
};
