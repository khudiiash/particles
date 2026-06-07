/**
 * Builds the renderable particle mesh for the three.js WebGPU runtime.
 *
 * The mesh reads particle state directly from a GPU storage buffer (the buffer
 * the core `ParticleSimulation` compute pass writes to) using TSL storage nodes,
 * so no per-frame CPU readback is required. The mesh is a billboarded instanced
 * quad — one instance per particle — driven by `SpriteNodeMaterial`.
 *
 * Particle struct layout (16 floats / 4 vec4 per particle), see core/layout.js:
 *   vec4 0: position.xyz, life
 *   vec4 1: velocity.xyz, maxLife
 *   vec4 2: size, opacity, pathPhase, pathSpread
 *   vec4 3: color.rgb, seed
 */
import * as THREE from "three";
import { StorageInstancedBufferAttribute } from "three";
import {
	Fn,
	storage,
	instanceIndex,
	vec3,
	vec4,
	float,
	uniform,
	positionLocal,
} from "three/tsl";
import { SpriteNodeMaterial } from "three/webgpu";
import { PARTICLE_STRIDE_FLOATS, PARTICLE_BYTES } from "@khudiiash/particles-core";

const VEC4_PER_PARTICLE = PARTICLE_STRIDE_FLOATS / 4; // 4

const BLEND = {
	additive: THREE.AdditiveBlending,
	additiveAlpha: THREE.AdditiveBlending,
	normal: THREE.NormalBlending,
	premultiplied: THREE.CustomBlending,
	multiply: THREE.MultiplyBlending,
	screen: THREE.AdditiveBlending,
};

export function buildParticleMesh({ renderer, particleBuffer, maxParticles, render }) {
	const count = maxParticles;

	// three-owned storage buffer that the material reads from. We mirror the
	// simulation buffer into it every frame with a GPU->GPU copy.
	const storageArray = new Float32Array(count * PARTICLE_STRIDE_FLOATS);
	const storageAttr = new StorageInstancedBufferAttribute(storageArray, 4);
	storageAttr.setUsage?.(THREE.DynamicDrawUsage);

	const particles = storage(storageAttr, "vec4", count * VEC4_PER_PARTICLE);

	const base = instanceIndex.mul(VEC4_PER_PARTICLE);
	const p0 = particles.element(base);
	const p2 = particles.element(base.add(2));
	const p3 = particles.element(base.add(3));

	const lifeT = p0.w; // remaining life > 0 means alive (sim writes life)
	const sizeAttr = p2.x;
	const opacityAttr = p2.y;

	const sizeScale = uniform(1);

	const material = new SpriteNodeMaterial();
	material.transparent = true;
	material.depthWrite = !!render.depthWrite;
	material.depthTest = true;
	material.blending = BLEND[render.blendMode] ?? THREE.NormalBlending;

	// Per-instance world position = particle position.
	material.positionNode = p0.xyz;
	// Per-instance billboard scale.
	material.scaleNode = sizeAttr.mul(sizeScale);

	// Soft round sprite alpha from quad-local UV, modulated by particle opacity.
	const alphaCutoff = float(render.alphaCutoff ?? 0.05);
	material.colorNode = Fn(() => {
		const uv = positionLocal.xy; // [-0.5, 0.5]
		const d = uv.length().mul(2.0);
		const soft = float(1.0).sub(d).clamp(0.0, 1.0);
		const a = soft.mul(opacityAttr);
		return vec4(p3.xyz, a);
	})();

	// Hide dead particles (life <= 0) by collapsing their scale.
	material.scaleNode = sizeAttr.mul(sizeScale).mul(lifeT.greaterThan(0.0).select(float(1), float(0)));

	const geometry = new THREE.PlaneGeometry(1, 1);
	const instanced = new THREE.InstancedBufferGeometry().copy(geometry);
	instanced.instanceCount = count;

	const mesh = new THREE.Mesh(instanced, material);
	mesh.frustumCulled = false;

	// Mirror the simulation buffer into the storage attribute each step.
	const device = renderer?.backend?.device;
	mesh.onSimStep = () => {
		if (!device) return;
		const dst = renderer.backend.get(storageAttr)?.buffer;
		if (!dst) return; // not allocated until first render
		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer(particleBuffer, 0, dst, 0, count * PARTICLE_BYTES);
		device.queue.submit([enc.finish()]);
	};

	mesh.userData.sizeScale = sizeScale;
	return mesh;
}
