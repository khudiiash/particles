export const BLEND_MODES = [
    { id: "additiveAlpha", label: "Additive (soft)" },
    { id: "additive", label: "Additive (hard)" },
    { id: "normal", label: "Alpha blend" },
    { id: "premultiplied", label: "Premultiplied" },
    { id: "multiply", label: "Multiply" },
    { id: "screen", label: "Screen" },
];


export const COLLISION_MODES = [
    { id: "none", label: "None" },
    { id: "plane", label: "Ground plane" },
    { id: "box", label: "Box" },
    { id: "sphere", label: "Sphere" },
];

export const PARTICLE_SHAPES = [
    { id: "disc", label: "Disc (soft)" },
    { id: "sphere", label: "Sphere" },
    { id: "cube", label: "Cube" },
    { id: "cylinder", label: "Cylinder" },
    { id: "cone", label: "Cone" },
];

export const DEFAULT_RENDER = {
    blendMode: "normal",
    depthSoftness: 0,
    depthWrite: false,
    depthSort: false,
    castShadow: false,
    receiveShadow: false,
    useLighting: false,
    lightIntensity: 0,
    particleRotation: 0, // deprecated — use curves.rotation
    stretchAlongMotion: 0,
    colorMap: "",
    colorMapMix: 1,
    alphaCutoff: 0.05,
    particleShape: "disc",
    shapeWidth: 1,
    shapeHeight: 1,
    shapeDepth: 1,
};

export function particleShapeIndex(shapeId) {
    const i = PARTICLE_SHAPES.findIndex((s) => s.id === shapeId);
    return i >= 0 ? i : 0;
}

export const EXTENDED_PARAMS = [
    { key: "collisionMode", label: "Bounds", type: "select", options: COLLISION_MODES, default: "none" },
    { key: "groundY", label: "Floor Y", step: 0.1, default: 0, collision: "plane box sphere" },
    { key: "boundsWidth", label: "Width", step: 0.1, min: 0.1, max: 50, default: 1, collision: "box" },
    { key: "boundsHeight", label: "Height", step: 0.1, min: 0.1, max: 50, default: 1, collision: "box" },
    { key: "boundsDepth", label: "Depth", step: 0.1, min: 0.1, max: 50, default: 1, collision: "box" },
    { key: "boundsRadius", label: "Radius", step: 0.1, min: 0.1, max: 50, default: 1, collision: "sphere" },
    { key: "bounce", label: "Bounce", step: 0.05, min: 0, max: 1, default: 0.35 },
    { key: "groundFriction", label: "Wall friction", step: 0.05, min: 0, max: 1, default: 0.2 },
    { key: "selfCollide", label: "Self collide", type: "checkbox", default: 0 },
];

export function mergeRender(render) {
    const r = { ...DEFAULT_RENDER, ...(render || {}) };
    if (r.useLighting === undefined && (r.lightIntensity ?? 0) > 0) {
        r.useLighting = true;
    }
    if (r.useLighting && !(r.lightIntensity > 0)) {
        r.lightIntensity = 1;
    }
    delete r.lightDirX;
    delete r.lightDirY;
    delete r.lightDirZ;
    return r;
}

export function collisionModeIndex(mode) {
    const i = COLLISION_MODES.findIndex((m) => m.id === mode);
    return i >= 0 ? i : 0;
}

export function normalizeCollisionMode(params = {}) {
    if (params.collisionMode) return params.collisionMode;
    if (params.groundPlane) return "plane";
    return "none";
}

/** Half-extents for box bounds + sphere radius (legacy boundsSize fills all). */
export function mergeBoundsHalf(params = {}) {
    const size = params.boundsSize ?? 1;
    return {
        boundsHalfX: params.boundsWidth ?? params.boundsHalfX ?? size,
        boundsHalfY: params.boundsHeight ?? params.boundsHalfY ?? size,
        boundsHalfZ: params.boundsDepth ?? params.boundsHalfZ ?? size,
        boundsRadius: params.boundsRadius ?? size,
        boundsWidth: params.boundsWidth ?? params.boundsHalfX ?? size,
        boundsHeight: params.boundsHeight ?? params.boundsHalfY ?? size,
        boundsDepth: params.boundsDepth ?? params.boundsHalfZ ?? size,
    };
}

function collisionDefaults(params = {}) {
    const bounds = mergeBoundsHalf(params);
    return {
        collisionMode: normalizeCollisionMode(params),
        groundY: params.groundY ?? 0,
        boundsSize: params.boundsSize ?? 1,
        ...bounds,
        bounce: params.bounce ?? params.groundBounce ?? 0.35,
        groundFriction: params.groundFriction ?? 0.2,
        selfCollide: params.selfCollide ?? 0,
    };
}

function checkboxHtml(id, label, checked, extraClass = "", extraAttrs = "") {
    return `<label class="chk${extraClass ? ` ${extraClass}` : ""}"${extraAttrs}><input id="${id}" type="checkbox"${checked ? " checked" : ""} /> ${label}</label>`;
}

/**
 * Texture persistence backend. Defaults to the legacy Express REST API; the
 * serverless editor injects a client-side (localStorage) backend instead.
 */
const serverTextureBackend = {
	async list() {
		const res = await fetch("/api/particle-textures");
		if (!res.ok) throw new Error(await res.text());
		const { textures } = await res.json();
		return textures;
	},
	async upload(file) {
		const res = await fetch(
			`/api/particle-textures/upload?filename=${encodeURIComponent(file.name)}`,
			{
				method: "POST",
				headers: { "Content-Type": file.type || "application/octet-stream" },
				body: file,
			},
		);
		if (!res.ok) {
			const text = await res.text();
			throw new Error(text.replace(/<[^>]+>/g, " ").trim() || `Upload failed (${res.status})`);
		}
		return res.json();
	},
};

let textureBackend = serverTextureBackend;

/** Override how the texture picker lists/uploads images (e.g. client storage). */
export function setTextureBackend(backend) {
	textureBackend = backend || serverTextureBackend;
}

export function updateColorMapLabel(path) {
    const label = document.getElementById("r-colorMapLabel");
    if (!label) return;
    if (!path) {
        label.textContent = "No texture selected";
        label.title = "";
        return;
    }
    const name = path.split("/").pop();
    label.textContent = name;
    label.title = path;
}

export function renderPanelHtml(render = {}, params = {}) {
    const r = mergeRender(render);
    const collision = collisionDefaults(params);
    const mode = collision.collisionMode;

    const extFields = EXTENDED_PARAMS.filter((f) => f.type !== "checkbox").map((f) => {
        const val = collision[f.key] ?? f.default;
        const hidden = f.collision && !f.collision.split(" ").includes(mode);
        const style = hidden ? ' style="display:none"' : "";
        let cls = "";
        let dataAttrs = "";
        if (f.collision) {
            cls += " collision-field";
            dataAttrs += ` data-collision="${f.collision}"`;
        }
        if (f.type === "select") {
            const opts = f.options.map((o) =>
                `<option value="${o.id}"${val === o.id ? " selected" : ""}>${o.label}</option>`).join("");
            return `<div class="field compact${cls}"${dataAttrs}${style}><label>${f.label}</label><select id="r-${f.key}">${opts}</select></div>`;
        }
        const attrs = [`step="${f.step}"`, f.min != null ? `min="${f.min}"` : "", f.max != null ? `max="${f.max}"` : ""].filter(Boolean).join(" ");
        return `<div class="field compact${cls}"${dataAttrs}${style}><label>${f.label}</label><input id="r-${f.key}" type="number" ${attrs} value="${val}" /></div>`;
    }).join("");

    const blendOpts = BLEND_MODES.map((o) =>
        `<option value="${o.id}"${r.blendMode === o.id ? " selected" : ""}>${o.label}</option>`).join("");

    const colorMapName = r.colorMap ? r.colorMap.split("/").pop() : "No texture selected";

    const shapeOpts = PARTICLE_SHAPES.map((o) =>
        `<option value="${o.id}"${r.particleShape === o.id ? " selected" : ""}>${o.label}</option>`).join("");

    return `
        <h2>Render</h2>
        <div class="field compact"><label>Blend mode</label><select id="r-blendMode">${blendOpts}</select></div>
        <div class="field compact"><label>Particle shape</label><select id="r-particleShape">${shapeOpts}</select></div>
        <div class="param-grid">
            <div class="field compact"><label>Alpha cutoff</label><input id="r-alphaCutoff" type="number" step="0.01" min="0" max="1" value="${r.alphaCutoff}" /></div>
            <div class="field compact"><label>Depth soften</label><input id="r-depthSoftness" type="number" step="0.05" min="0" max="1" value="${r.depthSoftness}" /></div>
            <div class="field compact"><label>Light intensity</label><input id="r-lightIntensity" type="number" step="0.05" min="0" max="2" value="${r.lightIntensity}" /></div>
            <div class="field compact"><label>Motion stretch</label><input id="r-stretchAlongMotion" type="number" step="0.1" min="0" max="8" value="${r.stretchAlongMotion}" /></div>
            <div class="field compact"><label>Color map mix</label><input id="r-colorMapMix" type="number" step="0.05" min="0" max="1" value="${r.colorMapMix}" /></div>
            <div class="field compact"><label>Shape width</label><input id="r-shapeWidth" type="number" step="0.05" min="0.05" max="8" value="${r.shapeWidth}" /></div>
            <div class="field compact"><label>Shape height</label><input id="r-shapeHeight" type="number" step="0.05" min="0.05" max="8" value="${r.shapeHeight}" /></div>
            <div class="field compact"><label>Shape depth</label><input id="r-shapeDepth" type="number" step="0.05" min="0.05" max="8" value="${r.shapeDepth}" /></div>
        </div>
        <p class="curve-hint">Shape dimensions scale particle size on X / Y / Z (cylinder &amp; cone use width as radius, height as length)</p>
        <div class="check-row">
            ${checkboxHtml("r-depthWrite", "Depth write", r.depthWrite)}
            ${checkboxHtml("r-depthSort", "Depth sort", r.depthSort)}
            ${checkboxHtml("r-useLighting", "Use lighting", r.useLighting)}
            ${checkboxHtml("r-castShadow", "Cast shadow", r.castShadow)}
            ${checkboxHtml("r-receiveShadow", "Receive shadow", r.receiveShadow)}
        </div>
        <p class="curve-hint">Use lighting samples PlayCanvas scene lights (directional, omni, spot) plus ambient · Light intensity blends between unlit and lit</p>
        <p class="curve-hint">Cast / receive shadow apply in PlayCanvas only — enable Cast Shadows on scene lights too</p>
        <div class="field compact">
            <label>Color map texture</label>
            <div class="texture-row">
                <button type="button" id="btn-choose-texture">Choose image…</button>
                <span class="texture-path" id="r-colorMapLabel" title="${r.colorMap || ""}">${colorMapName}</span>
            </div>
            <input id="r-colorMapFile" type="file" accept="image/png,image/jpeg,image/jpg,image/webp" />
            <input id="r-colorMap" type="hidden" value="${r.colorMap || ""}" />
        </div>
        <div class="field compact">
            <label>Previously uploaded</label>
            <select id="r-colorMapSelect"><option value="">Loading…</option></select>
        </div>
        <p class="curve-hint">Color map mix: 0 = gradient color only · 1 = gradient × texture color (shape still from texture alpha)</p>
        <p class="curve-hint">Depth sort orders particles back-to-front for correct transparency · depth write occludes scene geometry (best with sort + alpha cutoff)</p>
        <h2>Collision</h2>
        <div class="param-grid">${extFields}</div>
        <div class="check-row">
            ${checkboxHtml("r-selfCollide", "Self collide", !!collision.selfCollide)}
            ${checkboxHtml("r-showBounds", "Show bounds", params.showBounds !== false, "collision-field", ' data-collision="plane box sphere"')}
        </div>
        <p class="curve-hint">Box: half-width / half-height / half-depth on X / Y / Z · sphere radius · centered on emitter XZ, sitting on floor</p>
        <p class="curve-hint">Self collide adds fluid-like repulsion between particles</p>
    `;
}

export function bindCollisionPanel(onChange) {
    const select = document.getElementById("r-collisionMode");
    if (!select || select.dataset.collisionBound) return;
    select.dataset.collisionBound = "1";

    const sync = () => {
        const mode = select.value;
        document.querySelectorAll(".collision-field").forEach((row) => {
            const modes = (row.dataset.collision || "").split(" ");
            row.style.display = modes.includes(mode) ? "" : "none";
        });
        onChange?.();
    };

    select.addEventListener("change", sync);
    sync();
}

export function readShowBoundsFromUI() {
    const el = document.getElementById("r-showBounds");
    return el ? el.checked : true;
}

export function readRenderFromUI(base = {}) {
    const r = mergeRender(base);
    for (const key of ["depthSoftness", "lightIntensity", "stretchAlongMotion", "colorMapMix", "alphaCutoff", "shapeWidth", "shapeHeight", "shapeDepth"]) {
        const el = document.getElementById(`r-${key}`);
        if (el) r[key] = parseFloat(el.value);
    }
    const shapeEl = document.getElementById("r-particleShape");
    if (shapeEl) r.particleShape = shapeEl.value;
    const depthWriteEl = document.getElementById("r-depthWrite");
    if (depthWriteEl) r.depthWrite = depthWriteEl.checked;
    const depthSortEl = document.getElementById("r-depthSort");
    if (depthSortEl) r.depthSort = depthSortEl.checked;
    const useLightingEl = document.getElementById("r-useLighting");
    if (useLightingEl) r.useLighting = useLightingEl.checked;
    const castShadowEl = document.getElementById("r-castShadow");
    if (castShadowEl) r.castShadow = castShadowEl.checked;
    const receiveShadowEl = document.getElementById("r-receiveShadow");
    if (receiveShadowEl) r.receiveShadow = receiveShadowEl.checked;
    const blendEl = document.getElementById("r-blendMode");
    if (blendEl) r.blendMode = blendEl.value;
    const mapEl = document.getElementById("r-colorMap");
    const selectEl = document.getElementById("r-colorMapSelect");
    r.colorMap = (selectEl?.value || mapEl?.value || "").trim();
    return r;
}

export function readExtendedParamsFromUI(params = {}) {
    const out = { ...params };
    const modeEl = document.getElementById("r-collisionMode");
    if (modeEl) out.collisionMode = modeEl.value;
    for (const key of ["groundY", "boundsWidth", "boundsHeight", "boundsDepth", "boundsRadius", "bounce", "groundFriction"]) {
        const el = document.getElementById(`r-${key}`);
        if (el) out[key] = parseFloat(el.value);
    }
    for (const key of ["selfCollide"]) {
        const el = document.getElementById(`r-${key}`);
        if (el) out[key] = el.checked ? 1 : 0;
    }
    return out;
}

export async function bindTextureUpload(onChange, onStatus) {
    const fileInput = document.getElementById("r-colorMapFile");
    const chooseBtn = document.getElementById("btn-choose-texture");
    const select = document.getElementById("r-colorMapSelect");
    const hidden = document.getElementById("r-colorMap");
    if (!fileInput || !chooseBtn || !select) return;

    chooseBtn.addEventListener("click", () => {
        fileInput.click();
    });

    async function refreshList(selected = "") {
        const current = selected || hidden?.value || "";
        updateColorMapLabel(current);
        try {
            const textures = await textureBackend.list();
            select.innerHTML = `<option value="">— none —</option>${textures.map((t) =>
                `<option value="${t.path}"${t.path === current ? " selected" : ""}>${t.id}</option>`).join("")}`;
        } catch (err) {
            select.innerHTML = `<option value="">Failed to load list</option>`;
            console.error(err);
        }
    }

    select.addEventListener("change", () => {
        const path = select.value;
        if (hidden) hidden.value = path;
        updateColorMapLabel(path);
        onChange?.();
    });

    fileInput.addEventListener("change", async () => {
        const file = fileInput.files?.[0];
        if (!file) return;

        onStatus?.(`Copying ${file.name}…`);
        chooseBtn.disabled = true;

        try {
            const saved = await textureBackend.upload(file);
            if (hidden) hidden.value = saved.path;
            updateColorMapLabel(saved.path);
            await refreshList(saved.path);
            select.value = saved.path;
            fileInput.value = "";
            onStatus?.(`Copied to ${saved.path}`);
            onChange?.();
        } catch (err) {
            console.error(err);
            onStatus?.(err.message || "Failed to copy texture", true);
        } finally {
            chooseBtn.disabled = false;
        }
    });

    await refreshList(hidden?.value || "");
}
