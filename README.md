# @khudiiash/gpu-particle-editor

WebGPU particle editor with effect library, texture uploads, and Express integration.

## Install

```bash
npm install @khudiiash/gpu-particle-editor
```

For local development alongside this monorepo:

```json
{
  "dependencies": {
    "@khudiiash/gpu-particle-editor": "file:../gpu-particle-editor"
  }
}
```

## Standalone dev server

```bash
npm start
# open http://localhost:3099/particle-editor
```

## Express integration

```js
const express = require("express");
const { mountParticleEditor } = require("@khudiiash/gpu-particle-editor");

const app = express();
mountParticleEditor(app);

app.listen(3000);
```

This mounts:

- `GET /particle-editor` — editor UI
- Static assets under `/particles`, `/particle-effects`, `/particle-textures`
- REST API at `/api/particle-effects` and `/api/particle-textures`

### Colyseus / uWebSockets

Pass a custom body reader when your framework buffers request bodies differently:

```js
const { mountParticleEditor } = require("@khudiiash/gpu-particle-editor");

mountParticleEditor(app, {
  readBody: async (req) => {
    if (typeof req.readBody === "function") await req.readBody();
    const raw = (req._rawbody && req._rawbody.toString()) || req.body || "";
    return JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
  },
});
```

## Programmatic API

```js
const {
  particleEffectManager,
  particleTextureManager,
  applyCanonicalShaders,
  PUBLIC_DIR,
} = require("@khudiiash/gpu-particle-editor");

const effects = particleEffectManager.list();
const withShaders = applyCanonicalShaders(particleEffectManager.get("basic"));
```

## Client modules

Browser ES modules live in `public/particles/` and are served as static files:

```js
import { mergeParams } from "./particles/curves.js";
```

When bundling, import from the package export map:

```js
import { mergeParams } from "@khudiiash/gpu-particle-editor/particles/curves.js";
```

## Shader sync scripts (optional)

Maintenance scripts sync canonical WGSL from the Photon game client:

```bash
PHOTON_ROOT=../Photon npm run sync:simulation
PHOTON_ROOT=../Photon npm run sync:render
PHOTON_ROOT=../Photon npm run inject:noise
PHOTON_ROOT=../Photon npm run inject:shapes
```

Defaults to `../../Photon` relative to this package.

## Package layout

```
public/
  particle-editor.html
  particle-effects/     # saved effect JSON
  particle-textures/    # uploaded textures
  particles/            # editor runtime modules + canonical WGSL
src/
  server/               # Express integration + file managers
scripts/                # WGSL sync utilities
```
