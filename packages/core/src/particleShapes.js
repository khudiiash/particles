/**
 * Procedural particle mesh data for the Three.js editor preview.
 * Positions/normals match PlayCanvas particleShapes.js; UVs are added for color maps.
 */
import * as THREE from "three";

const SEG = 10;

function pushTri(indices, a, b, c) {
    indices.push(a, b, c);
}

function buildCubeMesh() {
    const h = 0.5;
    const faces = [
        { n: [0, 1, 0], ps: [[-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        { n: [0, -1, 0], ps: [[-h, -h, h], [h, -h, h], [h, -h, -h], [-h, -h, -h]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        { n: [1, 0, 0], ps: [[h, -h, -h], [h, -h, h], [h, h, h], [h, h, -h]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        { n: [-1, 0, 0], ps: [[-h, -h, h], [-h, -h, -h], [-h, h, -h], [-h, h, h]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        { n: [0, 0, 1], ps: [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
        { n: [0, 0, -1], ps: [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]], uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] },
    ];
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (const face of faces) {
        const base = positions.length / 3;
        for (let i = 0; i < 4; i++) {
            positions.push(...face.ps[i]);
            normals.push(...face.n);
            uvs.push(...face.uvs[i]);
        }
        pushTri(indices, base, base + 1, base + 2);
        pushTri(indices, base, base + 2, base + 3);
    }
    return { positions, normals, uvs, indices };
}

function buildSphereMesh() {
    const rings = 6;
    const segments = SEG;
    const positions = [];
    const normals = [];
    const uvs = [];
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
            positions.push(nx * 0.5, ny * 0.5, nz * 0.5);
            normals.push(nx, ny, nz);
            uvs.push(u, 1 - v);
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
    return { positions, normals, uvs, indices };
}

function buildCylinderMesh() {
    const r = 0.5;
    const h = 0.5;
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i < SEG; i++) {
        const u0 = i / SEG;
        const u1 = (i + 1) / SEG;
        const a0 = u0 * Math.PI * 2;
        const a1 = u1 * Math.PI * 2;
        const c0 = Math.cos(a0);
        const s0 = Math.sin(a0);
        const c1 = Math.cos(a1);
        const s1 = Math.sin(a1);
        const base = positions.length / 3;
        positions.push(c0 * r, -h, s0 * r, c1 * r, -h, s1 * r, c1 * r, h, s1 * r, c0 * r, h, s0 * r);
        normals.push(c0, 0, s0, c1, 0, s1, c1, 0, s1, c0, 0, s0);
        uvs.push(u0, 0, u1, 0, u1, 1, u0, 1);
        pushTri(indices, base, base + 1, base + 2);
        pushTri(indices, base, base + 2, base + 3);
    }
    const topCenter = positions.length / 3;
    positions.push(0, h, 0);
    normals.push(0, 1, 0);
    uvs.push(0.5, 0.5);
    const bottomCenter = positions.length / 3;
    positions.push(0, -h, 0);
    normals.push(0, -1, 0);
    uvs.push(0.5, 0.5);
    for (let i = 0; i < SEG; i++) {
        const u0 = i / SEG;
        const u1 = (i + 1) / SEG;
        const a0 = u0 * Math.PI * 2;
        const a1 = u1 * Math.PI * 2;
        const t0 = positions.length / 3;
        positions.push(Math.cos(a0) * r, h, Math.sin(a0) * r, Math.cos(a1) * r, h, Math.sin(a1) * r);
        normals.push(0, 1, 0, 0, 1, 0);
        uvs.push(0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5, 0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5);
        pushTri(indices, topCenter, t0, t0 + 1);
        const b0 = positions.length / 3;
        positions.push(Math.cos(a1) * r, -h, Math.sin(a1) * r, Math.cos(a0) * r, -h, Math.sin(a0) * r);
        normals.push(0, -1, 0, 0, -1, 0);
        uvs.push(0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5, 0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5);
        pushTri(indices, bottomCenter, b0, b0 + 1);
    }
    return { positions, normals, uvs, indices };
}

function buildConeMesh() {
    const r = 0.5;
    const h = 0.5;
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    const apex = positions.length / 3;
    positions.push(0, h, 0);
    normals.push(0, 1, 0);
    uvs.push(0.5, 0);
    for (let i = 0; i < SEG; i++) {
        const u0 = i / SEG;
        const u1 = (i + 1) / SEG;
        const a0 = u0 * Math.PI * 2;
        const a1 = u1 * Math.PI * 2;
        const bx0 = Math.cos(a0) * r;
        const bz0 = Math.sin(a0) * r;
        const bx1 = Math.cos(a1) * r;
        const bz1 = Math.sin(a1) * r;
        const sl = Math.hypot(r, h * 2);
        const nx = Math.cos((a0 + a1) * 0.5) * (h / sl);
        const ny = r / sl;
        const nz = Math.sin((a0 + a1) * 0.5) * (h / sl);
        const sideBase = positions.length / 3;
        positions.push(bx0, -h, bz0, bx1, -h, bz1);
        normals.push(nx, ny, nz, nx, ny, nz);
        uvs.push(u0, 1, u1, 1);
        pushTri(indices, apex, sideBase, sideBase + 1);
    }
    const bottomCenter = positions.length / 3;
    positions.push(0, -h, 0);
    normals.push(0, -1, 0);
    uvs.push(0.5, 0.5);
    for (let i = 0; i < SEG; i++) {
        const u0 = i / SEG;
        const u1 = (i + 1) / SEG;
        const a0 = u0 * Math.PI * 2;
        const a1 = u1 * Math.PI * 2;
        const b0 = positions.length / 3;
        positions.push(Math.cos(a0) * r, -h, Math.sin(a0) * r, Math.cos(a1) * r, -h, Math.sin(a1) * r);
        normals.push(0, -1, 0, 0, -1, 0);
        uvs.push(0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5, 0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5);
        pushTri(indices, bottomCenter, b0 + 1, b0);
    }
    return { positions, normals, uvs, indices };
}

const BUILDERS = {
    sphere: buildSphereMesh,
    cube: buildCubeMesh,
    cylinder: buildCylinderMesh,
    cone: buildConeMesh,
};

/** @param {"sphere"|"cube"|"cylinder"|"cone"} shapeId */
export function createPreviewShapeGeometry(shapeId) {
    const build = BUILDERS[shapeId];
    if (!build) return null;
    const { positions, normals, uvs, indices } = build();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    // InstancedMesh + vertexColors multiplies geometry.color × instanceColor; missing color → black.
    const colors = new Float32Array((positions.length / 3) * 3);
    colors.fill(1);
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
}
