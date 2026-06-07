/**
 * Procedural particle-shape index buffers for the canonical PlayCanvas render
 * shader. The shape *vertex* data (positions + normals) is baked into the
 * canonical WGSL (`CANONICAL_RENDER.wgslShared`); here we only build the CPU
 * index buffer that fans `particleCount * vertsPerShape` vertices out of an
 * empty (vertex-buffer-less) mesh.
 *
 * These builders MUST stay byte-for-byte identical to the ones used to generate
 * the WGSL arrays, otherwise `localIdx = vertexIndex % vertsPer` would index the
 * wrong baked vertex. (Ported verbatim from Photon's particleShapes.js.)
 */

const PARTICLE_SHAPE_SEG = 10;

export const PARTICLE_SHAPE_INDEX = {
	disc: 0,
	sphere: 1,
	cube: 2,
	cylinder: 3,
	cone: 4,
};

export function particleShapeIndex(shapeId) {
	return PARTICLE_SHAPE_INDEX[shapeId] ?? 0;
}

function pushTri(indices, a, b, c) {
	indices.push(a, b, c);
}

function buildCubeMesh() {
	const h = 0.5;
	const faces = [
		{ n: [0, 1, 0], ps: [[-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h]] },
		{ n: [0, -1, 0], ps: [[-h, -h, h], [h, -h, h], [h, -h, -h], [-h, -h, -h]] },
		{ n: [1, 0, 0], ps: [[h, -h, -h], [h, -h, h], [h, h, h], [h, h, -h]] },
		{ n: [-1, 0, 0], ps: [[-h, -h, h], [-h, -h, -h], [-h, h, -h], [-h, h, h]] },
		{ n: [0, 0, 1], ps: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]] },
		{ n: [0, 0, -1], ps: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]] },
	];
	const verts = [];
	const indices = [];
	for (const face of faces) {
		const base = verts.length / 6;
		for (const p of face.ps) {
			verts.push(p[0], p[1], p[2], face.n[0], face.n[1], face.n[2]);
		}
		pushTri(indices, base, base + 1, base + 2);
		pushTri(indices, base, base + 2, base + 3);
	}
	return { verts, indices };
}

function buildSphereMesh() {
	const rings = 6;
	const segments = PARTICLE_SHAPE_SEG;
	const verts = [];
	const indices = [];
	for (let y = 0; y <= rings; y++) {
		const v = y / rings;
		const phi = v * Math.PI;
		for (let x = 0; x <= segments; x++) {
			const u = x / segments;
			const theta = u * Math.PI * 2;
			const nx = Math.sin(phi) * Math.cos(theta);
			const ny = Math.cos(phi);
			const nz = Math.sin(phi) * Math.sin(theta);
			verts.push(nx * 0.5, ny * 0.5, nz * 0.5, nx, ny, nz);
		}
	}
	for (let y = 0; y < rings; y++) {
		for (let x = 0; x < segments; x++) {
			const a = y * (segments + 1) + x;
			const b = a + segments + 1;
			pushTri(indices, a, b, a + 1);
			pushTri(indices, b, b + 1, a + 1);
		}
	}
	return { verts, indices };
}

function buildCylinderMesh() {
	const r = 0.5;
	const h = 0.5;
	const verts = [];
	const indices = [];
	for (let i = 0; i < PARTICLE_SHAPE_SEG; i++) {
		const a0 = (i / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const a1 = ((i + 1) / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const c0 = Math.cos(a0);
		const s0 = Math.sin(a0);
		const c1 = Math.cos(a1);
		const s1 = Math.sin(a1);
		const base = verts.length / 6;
		verts.push(c0 * r, -h, s0 * r, c0, 0, s0);
		verts.push(c1 * r, -h, s1 * r, c1, 0, s1);
		verts.push(c1 * r, h, s1 * r, c1, 0, s1);
		verts.push(c0 * r, h, s0 * r, c0, 0, s0);
		pushTri(indices, base, base + 1, base + 2);
		pushTri(indices, base, base + 2, base + 3);
	}
	const topCenter = verts.length / 6;
	verts.push(0, h, 0, 0, 1, 0);
	const bottomCenter = verts.length / 6;
	verts.push(0, -h, 0, 0, -1, 0);
	for (let i = 0; i < PARTICLE_SHAPE_SEG; i++) {
		const a0 = (i / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const a1 = ((i + 1) / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const t0 = verts.length / 6;
		verts.push(Math.cos(a0) * r, h, Math.sin(a0) * r, 0, 1, 0);
		verts.push(Math.cos(a1) * r, h, Math.sin(a1) * r, 0, 1, 0);
		pushTri(indices, topCenter, t0, t0 + 1);
		const b0 = verts.length / 6;
		verts.push(Math.cos(a1) * r, -h, Math.sin(a1) * r, 0, -1, 0);
		verts.push(Math.cos(a0) * r, -h, Math.sin(a0) * r, 0, -1, 0);
		pushTri(indices, bottomCenter, b0, b0 + 1);
	}
	return { verts, indices };
}

function buildConeMesh() {
	const r = 0.5;
	const h = 0.5;
	const verts = [];
	const indices = [];
	const apex = verts.length / 6;
	verts.push(0, h, 0, 0, 1, 0);
	for (let i = 0; i < PARTICLE_SHAPE_SEG; i++) {
		const a0 = (i / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const a1 = ((i + 1) / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const sideBase = verts.length / 6;
		const bx0 = Math.cos(a0) * r;
		const bz0 = Math.sin(a0) * r;
		const bx1 = Math.cos(a1) * r;
		const bz1 = Math.sin(a1) * r;
		const sl = Math.hypot(r, h * 2);
		const nx = Math.cos((a0 + a1) * 0.5) * (h / sl);
		const ny = r / sl;
		const nz = Math.sin((a0 + a1) * 0.5) * (h / sl);
		verts.push(bx0, -h, bz0, nx, ny, nz);
		verts.push(bx1, -h, bz1, nx, ny, nz);
		pushTri(indices, apex, sideBase, sideBase + 1);
	}
	const bottomCenter = verts.length / 6;
	verts.push(0, -h, 0, 0, -1, 0);
	for (let i = 0; i < PARTICLE_SHAPE_SEG; i++) {
		const a0 = (i / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const a1 = ((i + 1) / PARTICLE_SHAPE_SEG) * Math.PI * 2;
		const b0 = verts.length / 6;
		verts.push(Math.cos(a0) * r, -h, Math.sin(a0) * r, 0, -1, 0);
		verts.push(Math.cos(a1) * r, -h, Math.sin(a1) * r, 0, -1, 0);
		pushTri(indices, bottomCenter, b0 + 1, b0);
	}
	return { verts, indices };
}

const PARTICLE_SHAPE_MESHES = {
	disc: { verts: null, indices: [0, 2, 1, 1, 2, 3], vertCount: 4 },
	cube: null,
	sphere: null,
	cylinder: null,
	cone: null,
};

(function initParticleShapeMeshes() {
	const cube = buildCubeMesh();
	const sphere = buildSphereMesh();
	const cylinder = buildCylinderMesh();
	const cone = buildConeMesh();
	PARTICLE_SHAPE_MESHES.cube = { ...cube, vertCount: 24 };
	PARTICLE_SHAPE_MESHES.sphere = { ...sphere, vertCount: sphere.verts.length / 6 };
	PARTICLE_SHAPE_MESHES.cylinder = { ...cylinder, vertCount: cylinder.verts.length / 6 };
	PARTICLE_SHAPE_MESHES.cone = { ...cone, vertCount: cone.verts.length / 6 };
})();

export function particleShapeVertCount(shapeId = "disc") {
	return PARTICLE_SHAPE_MESHES[shapeId]?.vertCount ?? 4;
}

export function buildParticleIndices(particleCount, shapeId = "disc") {
	const mesh = PARTICLE_SHAPE_MESHES[shapeId] || PARTICLE_SHAPE_MESHES.disc;
	const { indices, vertCount } = mesh;
	const out = new Uint32Array(particleCount * indices.length);
	for (let i = 0; i < particleCount; i++) {
		const vb = i * vertCount;
		const ib = i * indices.length;
		for (let j = 0; j < indices.length; j++) {
			out[ib + j] = vb + indices[j];
		}
	}
	return out;
}

const INDEX_CACHE = new Map();

export function getParticleIndices(count, shapeId = "disc") {
	const key = `${count}:${shapeId || "disc"}`;
	if (INDEX_CACHE.has(key)) return INDEX_CACHE.get(key);
	const indices = buildParticleIndices(count, shapeId || "disc");
	INDEX_CACHE.set(key, indices);
	return indices;
}
