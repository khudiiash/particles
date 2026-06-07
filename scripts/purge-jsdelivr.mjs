#!/usr/bin/env node
// Purges jsDelivr's edge cache for a package's floating (unversioned / @latest)
// CDN paths so that a stable URL like
//   https://cdn.jsdelivr.net/npm/<pkg>@latest/dist/index.mjs
// starts serving the just-published bytes immediately instead of the previous
// build (jsDelivr caches floating versions aggressively).
//
// Usage: node scripts/purge-jsdelivr.mjs <package-name> [distFile]
//   distFile defaults to "dist/index.mjs"

const pkg = process.argv[2];
const distFile = process.argv[3] || "dist/index.mjs";

if (!pkg) {
	console.error("usage: purge-jsdelivr.mjs <package-name> [distFile]");
	process.exit(1);
}

const paths = [
	`npm/${pkg}/${distFile}`,
	`npm/${pkg}@latest/${distFile}`,
	`npm/${pkg}/${distFile}.map`,
	`npm/${pkg}`,
];

async function purge(p) {
	const url = `https://purge.jsdelivr.net/${p}`;
	try {
		const res = await fetch(url);
		const body = await res.json().catch(() => ({}));
		const status = body?.status || res.status;
		console.log(`purged ${p} -> ${status}`);
	} catch (err) {
		console.warn(`purge failed for ${p}: ${err.message}`);
	}
}

await Promise.all(paths.map(purge));
console.log(`jsDelivr cache purge requested for ${pkg}. @latest may take ~1 min to fully propagate across edges.`);
