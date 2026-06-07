/**
 * Minimal PlayCanvas-dialect WGSL render shader for the PlayCanvas runtime.
 *
 * Reads the particle storage buffer (written by the core compute simulation) and
 * draws each live particle as a camera-facing billboard. Written in PlayCanvas's
 * WGSL flavour (`uniform`/`varying`/`var<storage>` declarations) so it can be
 * compiled by `pc.ShaderMaterial` with `SHADERLANGUAGE_WGSL`.
 */
export function particleVertexWgsl() {
	return /* wgsl */ `
struct Particle {
    position: vec3f,
    life: f32,
    velocity: vec3f,
    maxLife: f32,
    size: f32,
    opacity: f32,
    pathPhase: f32,
    pathSpread: f32,
    color: vec3f,
    seed: f32,
};

var<storage, read> particles: array<Particle>;

uniform matrix_viewProjection: mat4x4f;
uniform matrix_view: mat4x4f;
uniform uSizeScale: f32;

varying vColor: vec4f;
varying vUv: vec2f;

const QUAD = array<vec2f, 6>(
    vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),
    vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5),
);

struct VertexInput {
    @builtin(vertex_index) vertexIndex: u32,
};

struct VertexOutput {
    @builtin(position) position: vec4f,
};

@vertex
fn vertexMain(input: VertexInput) -> VertexOutput {
    let particleIndex = input.vertexIndex / 6u;
    let corner = QUAD[input.vertexIndex % 6u];
    let p = particles[particleIndex];

    let alive = select(0.0, 1.0, p.life > 0.0);
    let scale = p.size * uniform.uSizeScale * alive;

    let right = vec3f(uniform.matrix_view[0][0], uniform.matrix_view[1][0], uniform.matrix_view[2][0]);
    let up = vec3f(uniform.matrix_view[0][1], uniform.matrix_view[1][1], uniform.matrix_view[2][1]);
    let world = p.position + (right * corner.x + up * corner.y) * scale;

    var output: VertexOutput;
    output.position = uniform.matrix_viewProjection * vec4f(world, 1.0);
    vColor = vec4f(p.color, p.opacity * alive);
    vUv = corner;
    return output;
}
`;
}

export function particleFragmentWgsl() {
	return /* wgsl */ `
uniform uAlphaCutoff: f32;

varying vColor: vec4f;
varying vUv: vec2f;

struct FragmentOutput {
    @location(0) color: vec4f,
};

@fragment
fn fragmentMain() -> FragmentOutput {
    let d = length(vUv) * 2.0;
    let soft = clamp(1.0 - d, 0.0, 1.0);
    let a = vColor.a * soft;
    if (a < uniform.uAlphaCutoff) { discard; }
    var output: FragmentOutput;
    output.color = vec4f(vColor.rgb, a);
    return output;
}
`;
}
