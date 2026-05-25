#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photonRoot = process.env.PHOTON_ROOT || path.resolve(__dirname, "../../Photon");
const sourcePath = path.join(photonRoot, "scripts/effects/gpu-particles/defaultEffect.js");
const outPath = path.resolve(__dirname, "../public/particles/canonical-simulation.json");

const source = fs.readFileSync(sourcePath, "utf8");
const marker = "simulation: {";
const start = source.indexOf(marker);
if (start < 0) throw new Error("simulation block not found");

const entryMatch = source.slice(start).match(/entryPoint:\s*"([^"]+)"/);
const wgslMatch = source.slice(start).match(/wgsl:\s*\/\*\s*wgsl\s*\*\/\s*`([\s\S]*?)`\s*,\s*\n\s*\}/);
if (!entryMatch || !wgslMatch) throw new Error("Failed to parse simulation WGSL from defaultEffect.js");

const payload = {
	entryPoint: entryMatch[1],
	wgsl: `\n${wgslMatch[1]}\n`,
};

fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`Synced ${outPath} from ${sourcePath}`);
