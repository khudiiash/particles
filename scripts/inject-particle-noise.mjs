#!/usr/bin/env node
/**
 * Ensures defaultEffect.js simulation WGSL includes noise uniforms + applyParticleNoise.
 * Run after editing public/particles/noiseWgsl.js, then: npm run sync:simulation
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { particleNoiseWgsl } from "../public/particles/noiseWgsl.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photonRoot = process.env.PHOTON_ROOT || path.resolve(__dirname, "../../Photon");
const effectPath = path.join(photonRoot, "scripts/effects/gpu-particles/defaultEffect.js");

let src = fs.readFileSync(effectPath, "utf8");
const noiseBlock = particleNoiseWgsl().trim();
const anchor = "@compute @workgroup_size(64)\nfn updateParticles";

if (!src.includes("fn applyParticleNoise(")) {
	const pos = src.indexOf(anchor);
	if (pos < 0) throw new Error("updateParticles anchor not found");
	src = `${src.slice(0, pos)}${noiseBlock}\n\n${src.slice(pos)}`;
	console.log("Injected noise WGSL block");
} else {
	const start = src.indexOf("const NOISE_TARGET_VELOCITY");
	const end = src.indexOf(anchor);
	if (start < 0 || end < 0) throw new Error("Could not locate noise block boundaries");
	src = `${src.slice(0, start)}${noiseBlock}\n\n${src.slice(end)}`;
	console.log("Refreshed noise WGSL block");
}

src = src.replace(
	/fluidViscosity: f32,\n    _simPad0: f32,\n    _simPad1: f32,/,
	`fluidViscosity: f32,
    noiseType: f32,
    noiseFrequency: f32,
    noiseAmplitude: f32,
    noiseSpeed: f32,
    noiseOctaves: f32,
    noiseTargets: f32,
    noiseSeed: f32,`,
);

if (!src.includes("noiseEnabled: false")) {
	src = src.replace(
		/fluidViscosity: 0\.1,\n    \},/,
		`fluidViscosity: 0.1,
        noiseEnabled: false,
        noiseType: "simplex3d",
        noiseFrequency: 1.0,
        noiseAmplitude: 0.0,
        noiseSpeed: 1.0,
        noiseOctaves: 1,
        noiseSeed: 0,
        noiseTargetVelocity: false,
        noiseTargetColor: false,
        noiseTargetSize: false,
        noiseTargetOpacity: false,
        noiseTargetPosition: false,
    },`,
	);
}

src = src.replace(
	`            p.position = spawnPos;
            p.velocity = tangent;`,
	`            p.position = spawnPos;
            p.velocity = vec3f(0.0);`,
);

src = src.replace(
	`        if (mode == 1) {
            let tangent = samplePathTangent(t);
            let pathPos = samplePathPos(t);
            let offset = pathOffset(tangent, t, p.pathPhase, p.pathSpread);
            p.position = ub.emitterPos + pathPos + offset;
            p.velocity = tangent;
            applyBoundsCollision(&p);
        } else if (mode == 2) {`,
	`        if (mode == 1) {
            let tangent = samplePathTangent(t);
            let pathPos = samplePathPos(t);
            let offset = pathOffset(tangent, t, p.pathPhase, p.pathSpread);
            let pathBase = ub.emitterPos + pathPos + offset;
            p.velocity.y -= ub.gravity * ub.dt;
            p.velocity *= max(0.0, 1.0 - ub.drag * ub.dt);
            p.position = pathBase + p.velocity;
            applyParticleNoise(&p, t, mode);
            applyBoundsCollision(&p);
        } else if (mode == 2) {`,
);

src = src.replace(
	`        } else {
            p.velocity *= max(0.0, 1.0 - ub.drag * ub.dt);
            p.velocity.y -= ub.gravity * ub.dt;
            p.position += p.velocity * ub.dt;
            if (ub.selfCollide > 0.5) {
                applyFluidSelfCollide(i, &p);
                applyFluidSelfCollide(i, &p);
            }
            applyBoundsCollision(&p);
        }`,
	`        } else {
            p.velocity *= max(0.0, 1.0 - ub.drag * ub.dt);
            p.velocity.y -= ub.gravity * ub.dt;
            p.position += p.velocity * ub.dt;
            applyParticleNoise(&p, t, mode);
            if (ub.selfCollide > 0.5) {
                applyFluidSelfCollide(i, &p);
                applyFluidSelfCollide(i, &p);
            }
            applyBoundsCollision(&p);
        }`,
);

src = src.replace(
	`            p.position += p.velocity * ub.dt;
            boidsEnforceBounds(&p);
        } else if (mode == 3) {`,
	`            p.position += p.velocity * ub.dt;
            applyParticleNoise(&p, t, mode);
            boidsEnforceBounds(&p);
        } else if (mode == 3) {`,
);

src = src.replace(
	`        } else if (mode == 3) {
            applyHair(&p);
        } else if (mode == 4) {`,
	`        } else if (mode == 3) {
            applyHair(&p);
            applyParticleNoise(&p, t, mode);
        } else if (mode == 4) {`,
);

if (!src.includes("applyParticleNoise(&p, 0.0, i);")) {
	src = src.replace(
		`        if (mode != 3) {
            p.color = curveColor(r3, r4, ub.colorRandom, ub.colorRandomBetween, 0.0, ub.colorEasing);
        }
    } else {`,
		`        if (mode != 3) {
            p.color = curveColor(r3, r4, ub.colorRandom, ub.colorRandomBetween, 0.0, ub.colorEasing);
        }
        applyParticleNoise(&p, 0.0, mode);
    } else {`,
	);
}

fs.writeFileSync(effectPath, src);
console.log(`Updated ${effectPath}`);
