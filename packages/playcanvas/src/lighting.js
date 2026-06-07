/**
 * Samples enabled PlayCanvas scene lights (directional / omni / spot) and binds
 * their shadow maps for the canonical GPU-particle render shader, so particles
 * can be lit by and receive shadows from the scene. Ported from Photon's
 * sceneLighting.js.
 *
 * The companion vertex/fragment WGSL (CANONICAL_RENDER) does the actual shadow
 * sampling + lighting; this module only feeds it uniforms + textures.
 */
import * as pc from "playcanvas";

const MAX_SCENE_LIGHTS = 4;
const LIGHT_TYPE = { DIRECTIONAL: 0, OMNI: 1, SPOT: 2 };
const SHADER_SHADOW_PASS_FLAG = 1 << 2;

const IDENTITY_MAT4 = [
	1, 0, 0, 0,
	0, 1, 0, 0,
	0, 0, 1, 0,
	0, 0, 0, 1,
];

const FALLBACK_SHADOW_MAP_CACHE = new WeakMap();
const FALLBACK_FLOAT_SHADOW_MAP_CACHE = new WeakMap();

const _tmpColor = new pc.Color();
const _tmpDir = new pc.Vec3();
const _tmpPos = new pc.Vec3();
const _cameraComponents = [];

function linearLightColor(color, intensity) {
	if (intensity >= 1) {
		_tmpColor.linear(color).mulScalar(intensity);
	} else {
		_tmpColor.copy(color).mulScalar(intensity).linear();
	}
	return [_tmpColor.r, _tmpColor.g, _tmpColor.b];
}

function lightColorFromComponent(lightComp) {
	const internal = lightComp._light;
	const linear = internal?._colorLinear;
	if (linear) return [linear[0], linear[1], linear[2]];
	return linearLightColor(lightComp.color, lightComp.intensity);
}

function ambientLinear(scene) {
	_tmpColor.copy(scene.ambientLight);
	_tmpColor.linear();
	if (scene.physicalUnits) {
		_tmpColor.mulScalar(scene.ambientLuminance ?? 1);
	}
	return [_tmpColor.r, _tmpColor.g, _tmpColor.b];
}

function lightShinesDownWorldY(entity, out) {
	entity.getWorldTransform().getY(out);
	out.mulScalar(-1);
	out.normalize();
	return out;
}

function entityWorldPosition(entity, out) {
	entity.getWorldTransform().getTranslation(out);
	return out;
}

function lightTypeIndex(type) {
	if (type === "directional") return LIGHT_TYPE.DIRECTIONAL;
	if (type === "spot") return LIGHT_TYPE.SPOT;
	return LIGHT_TYPE.OMNI;
}

function resolveInternalCamera(cameraOrComponent) {
	if (!cameraOrComponent) return null;
	return cameraOrComponent.camera ?? cameraOrComponent;
}

function getActiveCamera(app) {
	const scene = app.scene;
	if (scene?._activeCamera) return scene._activeCamera;
	const active = scene?.activeCamera;
	if (active) return resolveInternalCamera(active);
	_cameraComponents.length = 0;
	app.root?.findComponents?.("camera", _cameraComponents);
	if (_cameraComponents.length) return resolveInternalCamera(_cameraComponents[0]);
	return null;
}

function getFallbackShadowMap(device) {
	if (!device) return null;
	if (!FALLBACK_SHADOW_MAP_CACHE.has(device)) {
		const tex = new pc.Texture(device, {
			name: "GpuParticleFallbackShadow",
			width: 1,
			height: 1,
			format: pc.PIXELFORMAT_DEPTH,
			mipmaps: false,
			minFilter: pc.FILTER_NEAREST,
			magFilter: pc.FILTER_NEAREST,
			addressU: pc.ADDRESS_CLAMP_TO_EDGE,
			addressV: pc.ADDRESS_CLAMP_TO_EDGE,
		});
		tex.compareOnRead = true;
		tex.compareFunc = pc.COMPAREFUNC_ALWAYS;
		FALLBACK_SHADOW_MAP_CACHE.set(device, tex);
	}
	return FALLBACK_SHADOW_MAP_CACHE.get(device);
}

function getFallbackFloatShadowMap(device) {
	if (!device) return null;
	if (!FALLBACK_FLOAT_SHADOW_MAP_CACHE.has(device)) {
		const tex = new pc.Texture(device, {
			name: "GpuParticleFallbackShadowFloat",
			width: 1,
			height: 1,
			format: pc.PIXELFORMAT_R32F,
			mipmaps: false,
			minFilter: pc.FILTER_NEAREST,
			magFilter: pc.FILTER_NEAREST,
			addressU: pc.ADDRESS_CLAMP_TO_EDGE,
			addressV: pc.ADDRESS_CLAMP_TO_EDGE,
		});
		if (typeof tex.lock === "function") {
			const pixels = tex.lock();
			if (pixels instanceof Float32Array) pixels[0] = 1.0;
			tex.unlock();
		}
		FALLBACK_FLOAT_SHADOW_MAP_CACHE.set(device, tex);
	}
	return FALLBACK_FLOAT_SHADOW_MAP_CACHE.get(device);
}

function isDepthShadowTexture(texture) {
	if (!texture) return false;
	if (texture.compareOnRead) return true;
	const fmt = texture.format;
	return fmt === pc.PIXELFORMAT_DEPTH
		|| fmt === pc.PIXELFORMAT_DEPTH16
		|| fmt === pc.PIXELFORMAT_DEPTHSTENCIL;
}

function isFloatShadowTexture(texture) {
	if (!texture || isDepthShadowTexture(texture)) return false;
	const fmt = texture.format;
	return fmt === pc.PIXELFORMAT_R32F
		|| fmt === pc.PIXELFORMAT_RGBA32F
		|| fmt === pc.PIXELFORMAT_R16F
		|| fmt === pc.PIXELFORMAT_RGBA16F;
}

function resolveShadowMapTexture(shadowBuffers, device, index) {
	let tex = shadowBuffers?.[index];
	if (!tex && device?.scope) {
		const mapScope = device.scope.resolve(`light${index}_shadowMap`);
		if (mapScope?.value) tex = mapScope.value;
	}
	return tex || null;
}

export function detectShadowMapUsesFloatSampling(shadowBuffers, device, lightCount = MAX_SCENE_LIGHTS) {
	let sawDepth = false;
	let sawFloat = false;
	const count = Math.min(Math.max(lightCount ?? 0, 0), MAX_SCENE_LIGHTS);

	for (let i = 0; i < count; i++) {
		const tex = resolveShadowMapTexture(shadowBuffers, device, i);
		if (!tex) continue;
		if (isFloatShadowTexture(tex)) sawFloat = true;
		if (isDepthShadowTexture(tex)) sawDepth = true;
	}

	if (sawFloat) return true;
	if (sawDepth) return false;

	for (let i = 0; i < MAX_SCENE_LIGHTS; i++) {
		const tex = resolveShadowMapTexture(shadowBuffers, device, i);
		if (isFloatShadowTexture(tex)) return true;
	}

	return false;
}

function bindShadowMap(material, index, texture) {
	if (!texture) return;
	material.setParameter(`sceneLight${index}ShadowMap`, texture);
	material.setParameter(`sceneLight${index}ShadowMapSampler`, texture);
}

function collectLayerLights(app, meshMask, layerIds, maxLights = MAX_SCENE_LIGHTS) {
	const buckets = [[], [], []];
	const seen = new Set();
	const layers = app.scene?.layers;
	if (!layers) return [];

	const ids = Array.isArray(layerIds) && layerIds.length ? layerIds : [pc.LAYERID_WORLD];

	for (let li = 0; li < ids.length; li++) {
		const layer = layers.getLayerById(ids[li]);
		if (!layer) continue;

		const layerLights = layer._lights || layer.lights;
		if (!layerLights?.length) continue;

		for (let i = 0; i < layerLights.length; i++) {
			const internal = layerLights[i];
			if (!internal?._enabled || seen.has(internal)) continue;

			const entity = internal._node;
			const lightComp = entity?.light;
			if (!lightComp?.enabled || !(lightComp.mask & meshMask)) continue;

			seen.add(internal);
			const type = internal._type;
			if (type >= 0 && type < 3) {
				buckets[type].push({ entity, light: lightComp, internal });
			}
		}
	}

	for (let t = 0; t < buckets.length; t++) {
		buckets[t].sort((a, b) => (a.internal.key ?? 0) - (b.internal.key ?? 0));
	}

	const ordered = [];
	for (let t = 0; t < buckets.length; t++) {
		for (let i = 0; i < buckets[t].length; i++) {
			ordered.push(buckets[t][i]);
			if (ordered.length >= maxLights) return ordered;
		}
	}
	return ordered;
}

function findShadowRenderData(internal, lightType, camera) {
	if (!internal?.castShadows) return null;

	const renderDataList = internal._renderData;
	const internalCamera = lightType === LIGHT_TYPE.DIRECTIONAL ? resolveInternalCamera(camera) : null;

	if (renderDataList?.length) {
		if (internalCamera) {
			for (let i = 0; i < renderDataList.length; i++) {
				const rd = renderDataList[i];
				if (rd.camera === internalCamera && rd.face === 0 && rd.shadowBuffer) return rd;
			}
		}
		for (let i = renderDataList.length - 1; i >= 0; i--) {
			const rd = renderDataList[i];
			if (rd.face === 0 && rd.shadowBuffer) return rd;
		}
	}

	return null;
}

function appendLightShadowScalars(entry, lightComp, camera) {
	entry.castShadow = 0;
	entry.shadowParams = [1, 0, 0, 0];
	entry.shadowMatrix = IDENTITY_MAT4.slice();
	entry.shadowBuffer = null;

	if (!lightComp.castShadows) return;

	const internal = lightComp.light || lightComp._light;
	if (!internal?.castShadows) return;

	const renderData = findShadowRenderData(internal, entry.type, camera);
	if (!renderData?.shadowBuffer) return;

	let normalBias = 0;
	let bias = 0;
	if (typeof internal._getUniformBiasValues === "function") {
		const biases = internal._getUniformBiasValues(renderData);
		normalBias = biases.normalBias ?? 0;
		bias = biases.bias ?? 0;
	}

	entry.castShadow = 1;
	entry.shadowBuffer = renderData.shadowBuffer;
	entry.shadowMatrix = renderData.shadowMatrix?.data
		? Array.from(renderData.shadowMatrix.data)
		: IDENTITY_MAT4.slice();

	const resolution = internal._shadowResolution || 1024;
	let depthScale = 0;
	if (entry.type === LIGHT_TYPE.SPOT || entry.type === LIGHT_TYPE.OMNI) {
		const range = lightComp.range ?? internal.attenuationEnd ?? 10;
		depthScale = range > 0 ? 1 / range : 0;
	}

	entry.shadowParams = [resolution, normalBias, bias, depthScale];
}

function gatherSceneLights(app, meshMask, layerIds, camera, maxLights = MAX_SCENE_LIGHTS) {
	const ambient = ambientLinear(app.scene);
	const lights = [];
	const found = collectLayerLights(app, meshMask, layerIds, maxLights);

	for (let i = 0; i < found.length; i++) {
		const { entity, light } = found[i];
		const type = lightTypeIndex(light.type);
		const color = lightColorFromComponent(light);
		const entry = {
			type,
			color,
			dir: [0, -1, 0],
			pos: [0, 0, 0],
			range: 0,
			spot: [0, 0, 0, 0],
		};

		if (type === LIGHT_TYPE.DIRECTIONAL) {
			const dir = lightShinesDownWorldY(entity, _tmpDir);
			entry.dir = [dir.x, dir.y, dir.z];
		} else {
			const pos = entityWorldPosition(entity, _tmpPos);
			entry.pos = [pos.x, pos.y, pos.z];
			entry.range = light.range ?? 10;

			if (type === LIGHT_TYPE.SPOT) {
				const dir = lightShinesDownWorldY(entity, _tmpDir);
				entry.dir = [dir.x, dir.y, dir.z];
				const inner = (light.innerConeAngle ?? 40) * (Math.PI / 180);
				const outer = (light.outerConeAngle ?? 45) * (Math.PI / 180);
				entry.spot = [inner, outer, 0, 0];
			}
		}

		appendLightShadowScalars(entry, light, camera);
		lights.push(entry);
	}

	return { ambient, lights, count: lights.length };
}

export function bindFallbackShadowMaps(material, device, useFloatShadow = false) {
	const tex = useFloatShadow ? getFallbackFloatShadowMap(device) : getFallbackShadowMap(device);
	if (!material || !tex) return;
	for (let i = 0; i < MAX_SCENE_LIGHTS; i++) bindShadowMap(material, i, tex);
}

function syncShadowUniformsFromScope(meshInstance, device, lightCount) {
	const scope = device?.scope;
	if (!scope || !meshInstance || lightCount <= 0) return;

	for (let i = 0; i < Math.min(lightCount, MAX_SCENE_LIGHTS); i++) {
		const matrixScope = scope.resolve(`light${i}_shadowMatrix`);
		const paramsScope = scope.resolve(`light${i}_shadowParams`);
		if (matrixScope?.value) meshInstance.setParameter(`sceneLight${i}ShadowMatrix`, matrixScope.value);
		if (paramsScope?.value) meshInstance.setParameter(`sceneLight${i}ShadowParams`, paramsScope.value);
	}
}

function syncShadowMapsFromScope(meshInstance, device, lightCount, shadowBuffers, useFloatShadow = false) {
	const scope = device?.scope;
	const fallback = useFloatShadow ? getFallbackFloatShadowMap(device) : getFallbackShadowMap(device);
	if (!scope || !meshInstance || !fallback) return;

	for (let i = 0; i < MAX_SCENE_LIGHTS; i++) {
		let tex = fallback;
		if (i < lightCount) {
			tex = resolveShadowMapTexture(shadowBuffers, device, i) || fallback;
		}
		meshInstance.setParameter(`sceneLight${i}ShadowMap`, tex);
		meshInstance.setParameter(`sceneLight${i}ShadowMapSampler`, tex);
	}
}

function bindFallbackShadowMapsToMeshInstance(meshInstance, device, useFloatShadow = false) {
	const tex = useFloatShadow ? getFallbackFloatShadowMap(device) : getFallbackShadowMap(device);
	if (!meshInstance || !tex) return;
	for (let i = 0; i < MAX_SCENE_LIGHTS; i++) {
		meshInstance.setParameter(`sceneLight${i}ShadowMap`, tex);
		meshInstance.setParameter(`sceneLight${i}ShadowMapSampler`, tex);
	}
}

function applyShadowPassUniforms(meshInstance, instance) {
	if (!meshInstance || !instance?._viewportMetrics) return;
	const { pixelW, pixelH } = instance._viewportMetrics();
	meshInstance.setParameter("screenViewportSize", [pixelW, pixelH]);
}

/**
 * Wrap meshInstance.setParameters so that, at draw time, we (a) supply the
 * viewport + fallback shadow maps during the shadow pass, and (b) sync the
 * engine's per-light shadow matrices / maps during the forward pass.
 */
export function installDrawTimeShadowSync(instance, meshInstance) {
	if (!meshInstance || meshInstance._gpuParticleShadowSync) return;

	const original = meshInstance.setParameters.bind(meshInstance);
	meshInstance.setParameters = (device, passFlag) => {
		const render = instance.config?.render || {};
		const isShadowPass = (passFlag & SHADER_SHADOW_PASS_FLAG) !== 0;
		const useFloat = !!instance._shadowMapFloat;
		if (render.receiveShadow || render.castShadow) {
			if (isShadowPass) {
				applyShadowPassUniforms(meshInstance, instance);
				bindFallbackShadowMapsToMeshInstance(meshInstance, device, useFloat);
			} else if (render.receiveShadow) {
				const floatMode = detectShadowMapUsesFloatSampling(
					instance._shadowBuffers,
					device,
					instance._sceneLightCount || 0,
				);
				if (floatMode !== instance._shadowMapFloat) {
					instance._updateShadowShaderMode(floatMode);
				}
				syncShadowUniformsFromScope(meshInstance, device, instance._sceneLightCount || 0);
				syncShadowMapsFromScope(
					meshInstance,
					device,
					instance._sceneLightCount || 0,
					instance._shadowBuffers,
					floatMode,
				);
			}
		}
		return original(device, passFlag);
	};
	meshInstance._gpuParticleShadowSync = true;
}

function cacheShadowBuffersFromLights(lights) {
	const buffers = new Array(MAX_SCENE_LIGHTS).fill(null);
	if (!Array.isArray(lights)) return buffers;
	for (let i = 0; i < Math.min(lights.length, MAX_SCENE_LIGHTS); i++) {
		buffers[i] = lights[i]?.shadowBuffer || null;
	}
	return buffers;
}

/** Fully assign every per-light uniform member (L may be null for an empty slot). */
function setLightUniforms(material, i, L) {
	material.setParameter(`sceneLight${i}Type`, L ? L.type : -1);
	material.setParameter(`sceneLight${i}Color`, L?.color || [0, 0, 0]);
	material.setParameter(`sceneLight${i}Dir`, L?.dir || [0, -1, 0]);
	material.setParameter(`sceneLight${i}Pos`, L?.pos || [0, 0, 0]);
	material.setParameter(`sceneLight${i}Range`, L?.range ?? 0);
	material.setParameter(`sceneLight${i}Spot`, L?.spot || [0, 0, 0, 0]);
	material.setParameter(`sceneLight${i}CastShadow`, L?.castShadow ? 1 : 0);
	material.setParameter(`sceneLight${i}ShadowMatrix`, L?.shadowMatrix || IDENTITY_MAT4);
	material.setParameter(`sceneLight${i}ShadowParams`, L?.shadowParams || [1, 0, 0, 0]);
}

/**
 * Push scene-light + shadow uniforms to the particle material. Returns the
 * light count + cached shadow buffers used by the draw-time sync.
 */
export function applySceneLighting(material, app, meshMask, layerIds, options = {}) {
	const useLighting = !!options.useLighting;
	const receiveShadow = !!options.receiveShadow;
	const camera = options.camera ?? getActiveCamera(app);

	material?.setParameter("receiveShadow", receiveShadow ? 1 : 0);

	if (!material) {
		return { count: 0, shadowBuffers: [] };
	}

	if (!useLighting && !receiveShadow) {
		material.setParameter("sceneLightCount", 0);
		material.setParameter("sceneAmbient", [0, 0, 0]);
		// Initialize every per-light uniform member so the WGSL uniform buffer is
		// fully assigned (otherwise PlayCanvas warns "Value was not set ...").
		for (let i = 0; i < MAX_SCENE_LIGHTS; i++) setLightUniforms(material, i, null);
		return { count: 0, shadowBuffers: [] };
	}

	const pack = gatherSceneLights(app, meshMask, layerIds, camera);
	material.setParameter("sceneAmbient", pack.ambient);
	material.setParameter("sceneLightCount", pack.count);

	for (let i = 0; i < MAX_SCENE_LIGHTS; i++) {
		setLightUniforms(material, i, pack.lights[i]);
	}

	const shadowBuffers = cacheShadowBuffersFromLights(pack.lights);
	return {
		count: pack.count,
		shadowBuffers,
		shadowMapUsesFloat: detectShadowMapUsesFloatSampling(shadowBuffers, material?.device, pack.count),
	};
}
