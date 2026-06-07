/**
 * Render-side curve uniforms (rotation + per-life color gradient) for the
 * canonical PlayCanvas particle material. The simulation already bakes most
 * curves into the particle buffer; these two are evaluated in the render shader
 * (rotation billboards/meshes, hair strand color), so they need their own
 * uniforms here. Reuses the core curve helpers so behaviour matches the editor.
 */
import { rotationCurveToRadians, mergeColorCurve, hexToRgb, easingIndex } from "@khudiiash/particles-core";

export function applyRotationRenderUniforms(material, curves) {
	const rotation = rotationCurveToRadians(curves?.rotation);
	material.setParameter("rotationStartMin", rotation.startMin);
	material.setParameter("rotationStartMax", rotation.startMax);
	material.setParameter("rotationEndMin", rotation.endMin);
	material.setParameter("rotationEndMax", rotation.endMax);
	material.setParameter("rotationRandom", rotation.random ? 1 : 0);
	material.setParameter("rotationEasing", easingIndex(rotation.easing));
}

export function applyColorRenderUniforms(material, curves) {
	const color = mergeColorCurve(curves?.color);
	material.setParameter("colorRandom", color.random ? 1 : 0);
	material.setParameter("colorRandomBetween", color.randomBetween ? 1 : 0);
	material.setParameter("colorEasing", easingIndex(color.easing));
	material.setParameter("colorKeyCount", color.keys.length);
	for (let i = 0; i < 4; i++) {
		const k = color.keys[i] || color.keys[color.keys.length - 1];
		const rgb = hexToRgb(k.color);
		material.setParameter(`colorKey${i}`, [k.t, rgb[0], rgb[1], rgb[2]]);
	}
}
