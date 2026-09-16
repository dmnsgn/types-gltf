# types-gltf

[![npm version](https://img.shields.io/npm/v/types-gltf)](https://www.npmjs.com/package/types-gltf)
[![stability-stable](https://img.shields.io/badge/stability-stable-green.svg)](https://www.npmjs.com/package/types-gltf)
[![npm minzipped size](https://img.shields.io/bundlephobia/minzip/types-gltf)](https://bundlephobia.com/package/types-gltf)
[![dependencies](https://img.shields.io/librariesio/release/npm/types-gltf)](https://github.com/dmnsgn/types-gltf/blob/main/package.json)
[![types](https://img.shields.io/npm/types/types-gltf)](https://github.com/microsoft/TypeScript)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-fa6673.svg)](https://conventionalcommits.org)
[![styled with prettier](https://img.shields.io/badge/styled_with-Prettier-f8bc45.svg?logo=prettier)](https://github.com/prettier/prettier)
[![linted with eslint](https://img.shields.io/badge/linted_with-ES_Lint-4B32C3.svg?logo=eslint)](https://github.com/eslint/eslint)
[![license](https://img.shields.io/github/license/dmnsgn/types-gltf)](https://github.com/dmnsgn/types-gltf/blob/main/LICENSE.md)

TypeScript declarations for the [glTF 2.0](https://github.com/KhronosGroup/glTF) specification and every registry extension marked Complete, generated from the Khronos JSON Schema. No runtime, no dependencies.

[![paypal](https://img.shields.io/badge/donate-paypal-informational?logo=paypal)](https://paypal.me/dmnsgn)
[![coinbase](https://img.shields.io/badge/donate-coinbase-informational?logo=coinbase)](https://commerce.coinbase.com/checkout/56cbdf28-e323-48d8-9c98-7019e72c97f3)
[![twitter](https://img.shields.io/twitter/follow/dmnsgn?style=social)](https://twitter.com/dmnsgn)
[![bluesky](https://img.shields.io/badge/-blue?logo=bluesky&label=Follow%20%40dmnsgn.me&style=social)](https://bsky.app/profile/dmnsgn.me)

## Installation

```bash
npm install types-gltf
```

## Usage

Import the specification as a namespace: the spec's own type names (`Node`,
`Image`, `Buffer`, `Texture`) shadow DOM globals otherwise.

```ts
import type * as GLTF from "types-gltf";

function pickBaseColor(material: GLTF.Material) {
  return material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
}
```

Extensions live under `types-gltf/extensions`, one module each, and are
namespaced for the same reason — every module names its types after the object
the extension attaches to, so `Material` and `Node` recur across them:

```ts
import type { KHR_materials_ior } from "types-gltf/extensions";

const ior = (
  material.extensions?.KHR_materials_ior as KHR_materials_ior.Material
)?.ior;
```

`extensions` on the core types stays an open index signature rather than a union
over the registry. Typing it would pull every extension module into every
consumer's build, and would still be wrong for the extensions that ship no
schema.

## License

MIT. See [license file](https://github.com/dmnsgn/types-gltf/blob/main/LICENSE.md).
