import { defineConfig } from "vite";

// `base` is "./" so the static build works on any host path (Netlify root,
// GitHub Pages project subpath, etc.) without rewriting asset URLs.
export default defineConfig({
	base: "./",
	build: {
		target: "esnext",
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 5173,
	},
});
