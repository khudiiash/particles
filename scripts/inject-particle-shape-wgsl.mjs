#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import vm from "vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photonRoot = process.env.PHOTON_ROOT || path.resolve(__dirname, "../../Photon");
const shapesPath = path.join(photonRoot, "scripts/effects/gpu-particles/particleShapes.js");
const effectPath = path.join(photonRoot, "scripts/effects/gpu-particles/defaultEffect.js");

const shapesSource = fs.readFileSync(shapesPath, "utf8");
const sandbox = {};
vm.runInNewContext(`${shapesSource}\nthis.PARTICLE_SHAPE_WGSL = particleShapeWgsl();`, sandbox);
const shapeWgsl = sandbox.PARTICLE_SHAPE_WGSL;
if (!shapeWgsl) throw new Error("Failed to generate shape WGSL");

let effect = fs.readFileSync(effectPath, "utf8");
if (effect.includes("fn shapeVertCount(shape: i32)")) {
	console.log("Shape WGSL already present");
} else {
	const anchor = "    return mix(c0, c1, renderEase(t, i32(easing)));\n}\n";
	const pos = effect.indexOf(anchor);
	if (pos < 0) throw new Error("insert anchor not found");
	const insertAt = pos + anchor.length;
	effect = `${effect.slice(0, insertAt)}\n${shapeWgsl}\n${effect.slice(insertAt)}`;
}

effect = effect.replace(/\s*useRayMarch: false,\s*\n\s*rayMarchMerge: [^,\n]+,\s*/g, "\n        particleShape: \"disc\",\n        shapeWidth: 1,\n        shapeHeight: 1,\n        shapeDepth: 1,\n");

fs.writeFileSync(effectPath, effect);
console.log(`Updated ${effectPath}`);
