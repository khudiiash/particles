#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photonRoot = process.env.PHOTON_ROOT || path.resolve(__dirname, "../../Photon");
const sourcePath = path.join(photonRoot, "scripts/effects/gpu-particles/defaultEffect.js");
const outPath = path.resolve(__dirname, "../packages/core/wgsl/render.json");

const source = fs.readFileSync(sourcePath, "utf8");
const marker = "render: {";
const start = source.indexOf(marker);
if (start < 0) throw new Error("render block not found");

const slice = source.slice(start);
const wgslSharedMatch = slice.match(/wgslShared:\s*\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`\s*,\s*\n\s*vertexWgsl:/);
const vertexMatch = slice.match(/vertexWgsl:\s*\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`\s*,\s*\n\s*fragmentWgsl:/);
const fragmentMatch = slice.match(/fragmentWgsl:\s*\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`\s*,\s*\n\s*\}/);
if (!wgslSharedMatch || !vertexMatch || !fragmentMatch) {
	throw new Error("Failed to parse render WGSL from defaultEffect.js");
}

const payload = {
	wgslShared: `\n${wgslSharedMatch[1]}\n`,
	vertexWgsl: `\n${vertexMatch[1]}\n`,
	fragmentWgsl: `\n${fragmentMatch[1]}\n`,
};

fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Synced ${outPath} from ${sourcePath}`);
