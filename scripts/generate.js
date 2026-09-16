#!/usr/bin/env node
/**
 * Regenerates `src/specification.ts` and `src/extensions/*.ts` from the Khronos
 * glTF 2.0 JSON Schema. The output is checked in.
 *
 *     node scripts/generate.js [--ref <branch-or-tag>] [--keep]
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const REPO = "https://github.com/KhronosGroup/glTF.git";
const DEFAULT_REF = "main";
const SPECIFICATION = "specification/2.0/schema";
const EXTENSIONS = "extensions/2.0";
const ROOT_SCHEMA = "glTF.schema.json";

/**
 * Status an extension's README must declare. Draft and Release Candidate still
 * move; Archived describes files nothing writes any more.
 */
const COMPLETE = /^complete\b/i;

const args = process.argv.slice(2);
const ref = args.includes("--ref")
  ? args[args.indexOf("--ref") + 1]
  : DEFAULT_REF;
const keep = args.includes("--keep");

const packageRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const source = path.join(packageRoot, "src");
const cache = path.join(packageRoot, "node_modules/.cache/types-gltf");
const checkout = path.join(cache, "glTF");
const staging = path.join(cache, "staging");

const repoPath = (...segments) => path.join(checkout, ...segments);

/**
 * Schema directories and the READMEs carrying their status, as a blobless
 * sparse clone: ~1 MB against a 71 MB tarball, and no rate limit to hit like
 * the ~250 requests the registry costs through the contents API.
 */
async function fetchSchemas() {
  await fs.rm(checkout, { recursive: true, force: true });
  await fs.mkdir(cache, { recursive: true });

  await run("git", [
    "clone",
    "--quiet",
    "--depth=1",
    `--branch=${ref}`,
    "--filter=blob:none",
    "--no-checkout",
    REPO,
    checkout,
  ]);
  await run(
    "git",
    [
      "sparse-checkout",
      "set",
      "--no-cone",
      `/${SPECIFICATION}`,
      `/${EXTENSIONS}/**/schema`,
      `/${EXTENSIONS}/**/README.md`,
    ],
    { cwd: checkout },
  );
  await run("git", ["checkout", "--quiet", ref], { cwd: checkout });

  const { stdout } = await run("git", ["rev-parse", "--short", "HEAD"], {
    cwd: checkout,
  });

  return stdout.trim();
}

/**
 * First non-empty line under the README's `## Status`. Only the heading's
 * opening is matched: some carry a trailing `<!-- omit in toc -->`.
 */
function readStatus(readme) {
  const heading = readme.search(/^#+ +status\b/im);
  if (heading === -1) return "";

  return (
    readme
      .slice(heading)
      .split("\n")
      .slice(1)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}

const schemaFiles = async (directory) =>
  (await fs.readdir(directory).catch(() => []))
    .filter((file) => file.endsWith(".schema.json"))
    .sort();

/** Every registry extension that is Complete and ships a schema. */
async function discoverExtensions() {
  const extensions = [];
  const skipped = [];

  for (const vendor of (await fs.readdir(repoPath(EXTENSIONS))).sort()) {
    for (const name of (
      await fs.readdir(repoPath(EXTENSIONS, vendor))
    ).sort()) {
      const directory = repoPath(EXTENSIONS, vendor, name);
      const readme = await fs
        .readFile(path.join(directory, "README.md"), "utf8")
        .catch(() => null);
      const status = readme === null ? "" : readStatus(readme);

      if (!COMPLETE.test(status)) {
        skipped.push(
          `${name} (${status || (readme === null ? "no README" : "no status")})`,
        );
        continue;
      }

      const schemas = await schemaFiles(path.join(directory, "schema"));
      // KHR_mesh_quantization and GODOT_single_root constrain how the core
      // schema is used rather than adding an object.
      if (!schemas.length) {
        skipped.push(`${name} (no schema)`);
        continue;
      }

      extensions.push({ name, vendor, directory, status, schemas });
    }
  }

  return { extensions, skipped };
}

/**
 * Type name from the schema file name: the registry names a schema after the
 * object the extension attaches to, `<host>.<extension>.schema.json`.
 *
 * Some vendors file node and texture extensions under `glTF.*` anyway, and
 * their titles say no more than "glTF extension" — the file name is the only
 * host the registry states, so deriving anything else would invent one.
 */
function typeName(basename, extension) {
  const host = basename.endsWith(`.${extension}`)
    ? basename.slice(0, -extension.length - 1)
    : basename;

  // Filed under the extension's own name: no host stated.
  if (!host || host === extension) {
    return extension.split("_").map(capitalize).join("");
  }

  return (
    host
      .split(".")
      // Vendors spell it both ways.
      .map((segment) =>
        /^gltf$/i.test(segment) ? "GlTF" : capitalize(segment),
      )
      .join("")
  );
}

const capitalize = (word) => word[0].toUpperCase() + word.slice(1);

/**
 * `$ref`s are bare file names against a flat namespace shared with the core
 * schema, so an extension compiles from a directory holding both. One directory
 * each rather than a shared pool: `light.schema.json` exists in two
 * extensions.
 */
async function stage(extension, names) {
  const directory = path.join(staging, extension.name);
  await fs.rm(directory, { recursive: true, force: true });
  await fs.mkdir(directory, { recursive: true });

  for (const file of await schemaFiles(repoPath(SPECIFICATION))) {
    await fs.copyFile(
      repoPath(SPECIFICATION, file),
      path.join(directory, file),
    );
  }

  for (const file of extension.schemas) {
    const schema = JSON.parse(
      await fs.readFile(path.join(extension.directory, "schema", file), "utf8"),
    );
    // Types are named after the schema's `title`, so rewriting it is what
    // yields `Material` over `KHRMaterialsIorGlTFMaterialExtension`. Core
    // schemas keep theirs, already the published names.
    schema.title = names.get(file);
    await fs.writeFile(path.join(directory, file), JSON.stringify(schema));
  }

  return directory;
}

/**
 * Khronos keeps closed sets open to future revisions — `anyOf: [{const: 5120},
 * …, {type: "integer"}]` — and that tail arrives as `| number`, swallowing the
 * union.
 *
 * `mimeType` keeps its tail: extensions really do add to it (KHR_texture_basisu
 * `image/ktx2`, EXT_texture_webp `image/webp`).
 */
function closeEnums(source) {
  return source.replaceAll(
    /(\w+)(\??: )((?:"[^"]*"|-?\d+)(?: \| (?:"[^"]*"|-?\d+))+) \| (?:number|string)\b/g,
    (match, property, separator, union) =>
      property === "mimeType" ? match : `${property}${separator}${union}`,
  );
}

/**
 * `allOf: [{type: "string"}]` beside an `anyOf` arrives as `("a" | "b" |
 * string) & string`. Runs before `closeEnums`, which has to see the tail.
 */
function unwrapIntersectedUnions(source) {
  return source.replaceAll(
    /\(((?:"[^"]*"|-?\d+|number|string)(?: \| (?:"[^"]*"|-?\d+|number|string))+)\) & (?:number|string)\b/g,
    "$1",
  );
}

/**
 * `additionalProperties: false` clears the index signatures that let a misspelt
 * property type-check, and with them the one in extension.schema.json that
 * makes `extensions` readable.
 */
function restoreExtensionValues(source) {
  return source.replace(
    /export interface Extension \{\n\s*\[k: string]: \{};\n}/,
    "export interface Extension {\n  [k: string]: Record<string, unknown>;\n}",
  );
}

/**
 * An inherited property is re-listed as `"name": {}` and arrives as `name?:
 * unknown`. The intersection still resolves to `string`; this drops a line that
 * reads as if it did not.
 */
function dropRedeclaredProperties(source) {
  return source.replaceAll(/^ *\w+\?: unknown;\n/gm, "");
}

/**
 * A `oneOf` of bare range constraints — KHR_materials_ior allows 0, or 1 and up
 * — states no type, so each branch arrives as an open object intersected with
 * the primitive.
 */
function dropConstraintObjects(source) {
  return source.replaceAll(
    /\b(number|string|boolean) & \{\n\s*\[k: string]: unknown;\n\s*}/g,
    "$1",
  );
}

/** `minItems: 1` on the root arrays would otherwise read as a non-empty tuple. */
function collapseNonEmptyTuples(source) {
  return source.replaceAll(/\[(\w+), \.\.\.\1\[]]/g, "$1[]");
}

/**
 * Every schema pairs `allOf: [{$ref: glTFProperty}]` with its own `properties`,
 * emitted once per branch — a type intersected with itself. Doubles the file.
 */
function dedupeIntersections(source) {
  const heading = /^export type \w+ = /gm;
  let result = "";
  let copied = 0;

  for (const match of source.matchAll(heading)) {
    const start = match.index + match[0].length;
    const end = declarationEnd(source, start, "type");
    const members = splitIntersection(source.slice(start, end));
    const unique = [...new Set(members)];

    result +=
      source.slice(copied, start) +
      (unique.length === members.length
        ? source.slice(start, end)
        : unique.join(" & "));
    copied = end;
  }

  return result + source.slice(copied);
}

/**
 * Index of a declaration's terminator: `;` for an `export type`, `}` for an
 * `export interface`. Braces only — doc comments carry unbalanced parentheses.
 */
function declarationEnd(source, start, kind) {
  let depth = 0;

  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      if (--depth === 0 && kind === "interface") return i;
    } else if (source[i] === ";" && depth === 0 && kind === "type") {
      return i;
    }
  }

  return source.length;
}

/** Splits on `&` at brace depth zero, so nested object types stay intact. */
function splitIntersection(body) {
  const members = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    else if (depth === 0 && body.startsWith(" & ", i)) {
      members.push(body.slice(start, i));
      start = i + 3;
      i += 2;
    }
  }
  members.push(body.slice(start));

  return members;
}

/** Every `export type`/`export interface` with its leading doc comment. */
function* declarations(source) {
  const heading = /^export (type|interface) (\w+)/gm;

  for (const match of source.matchAll(heading)) {
    const [text, kind, name] = match;
    yield {
      name,
      start: documentedFrom(source, match.index),
      end: declarationEnd(source, match.index + text.length, kind) + 1,
    };
  }
}

/** Start of the declaration at `index`, doc comment included. */
function documentedFrom(source, index) {
  const preceding = source.slice(0, index).trimEnd();
  if (!preceding.endsWith("*/")) return index;

  const comment = preceding.lastIndexOf("/**");

  return comment === -1 ? index : comment;
}

/**
 * Everything reachable from a schema is declared, so each module arrives with
 * its own copy of `GlTFProperty` and friends. Drop those and import them, for
 * one `TextureInfo` package-wide.
 *
 * A module's own types are exempt where the name collides: `Material` in
 * KHR_materials_ior is what hangs off a material, not the material.
 */
function importCoreTypes(source, core, own) {
  let result = "";
  let copied = 0;

  for (const { name, start, end } of declarations(source)) {
    if (!core.has(name) || own.has(name)) continue;
    result += source.slice(copied, start);
    copied = end;
  }
  result += source.slice(copied);

  // Doc comment prose is full of capitalised words.
  const code = result.replaceAll(/\/\*\*[\S\s]*?\*\//g, "");
  const imported = [
    ...new Set(
      [...code.matchAll(/\b[A-Z]\w*/g)]
        .map(([name]) => name)
        .filter((name) => core.has(name) && !own.has(name)),
    ),
  ].sort();

  if (!imported.length) return result;

  return (
    `import type { ${imported.join(", ")} } from ` +
    `"../specification.js";\n\n${result}`
  );
}

const { compileFromFile } = await import("json-schema-to-typescript");
const { format } = await import("prettier");

/**
 * Only the rules a file trips — an unused `eslint-disable` is itself an error.
 * `@minItems`/`@maxItems` are schema bounds; the enum values are WebGL
 * constants the spec writes ungrouped.
 */
function directives(source) {
  const rules = [
    /@(?:min|max)Items\b/.test(source) && "jsdoc/check-tag-names",
    /\b\d{5,}\b/.test(source) && "unicorn/numeric-separators-style",
  ].filter(Boolean);

  return rules.length ? `/* eslint-disable ${rules.join(", ")} */\n` : "";
}

async function write(file, banner, body) {
  const formatted = await format(`${directives(body)}${banner}\n${body}`, {
    parser: "typescript",
  });
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, formatted);

  return formatted;
}

const compile = async (directory, file) =>
  compileFromFile(path.join(directory, file), {
    cwd: `${directory}/`,
    additionalProperties: false,
    declareExternallyReferenced: true,
    bannerComment: "",
    // The fix-ups match against this layout; Prettier reformats at the end.
    format: true,
  });

const FIXES = [
  unwrapIntersectedUnions,
  closeEnums,
  dropConstraintObjects,
  dropRedeclaredProperties,
  collapseNonEmptyTuples,
  dedupeIntersections,
];

const applyFixes = (generated) =>
  FIXES.reduce((accumulator, fix) => fix(accumulator), generated);

const provenance = (revision) =>
  `// Generated by scripts/generate.js from KhronosGroup/glTF@${revision}.\n` +
  `// Run that script to update; do not edit by hand.\n`;

async function generateSpecification(revision) {
  const body = restoreExtensionValues(
    applyFixes(await compile(repoPath(SPECIFICATION), ROOT_SCHEMA)),
  );
  const formatted = await write(
    path.join(source, "specification.ts"),
    `${provenance(revision)}// The glTF 2.0 core specification, from ${SPECIFICATION}.`,
    body,
  );

  return {
    formatted,
    names: new Set([...declarations(formatted)].map((d) => d.name)),
  };
}

async function generateExtension(extension, core, revision) {
  const names = new Map(
    extension.schemas.map((file) => [
      file,
      typeName(file.replace(/\.schema\.json$/, ""), extension.name),
    ]),
  );

  const taken = new Set();
  const collisions = [...names.values()].filter(
    (name) => taken.size === taken.add(name).size,
  );
  if (collisions.length) {
    throw new Error(`two schemas both map to ${collisions.join(", ")}`);
  }

  const directory = await stage(extension, names);
  // Every schema is a root: an extension with several hosts has no single entry
  // point, and an unreferenced schema would never be declared.
  const compiled = await Promise.all(
    extension.schemas.map((file) => compile(directory, file)),
  );

  // Per-root compilation repeats what they share; first declaration wins.
  const seen = new Set();
  let body = "";
  for (const generated of compiled) {
    for (const { name, start, end } of declarations(generated)) {
      if (seen.has(name)) continue;
      seen.add(name);
      body += `${generated.slice(start, end)}\n\n`;
    }
  }

  const header = [
    `// ${extension.name} — ${extension.status}`,
    ...[...names].map(([file, name]) => `//   ${name.padEnd(24)} ${file}`),
  ].join("\n");

  await write(
    path.join(source, "extensions", `${extension.name}.ts`),
    `${provenance(revision)}${header}`,
    importCoreTypes(applyFixes(body), core, new Set(names.values())),
  );
}

async function generateExtensionsIndex(extensions, revision) {
  await write(
    path.join(source, "extensions", "index.ts"),
    `${provenance(revision)}// Every registry extension whose status is Complete.`,
    // Namespaced: types are named after the host object, so `Material` and
    // `Node` recur across modules.
    extensions
      .map(({ name }) => `export type * as ${name} from "./${name}.js";`)
      .join("\n"),
  );
}

try {
  const revision = await fetchSchemas();
  console.log(`KhronosGroup/glTF@${ref} is ${revision}`);

  const core = await generateSpecification(revision);
  console.log(
    `specification.ts: ${core.formatted.split("\n").length} lines, ${core.names.size} types`,
  );

  const { extensions, skipped } = await discoverExtensions();
  for (const extension of extensions) {
    try {
      await generateExtension(extension, core.names, revision);
    } catch (error) {
      // Prettier reports a parse failure with its minified bundle in the
      // stack, naming no schema.
      throw new Error(`${extension.name}: ${error.message.split("\n")[0]}`, {
        cause: error,
      });
    }
  }
  await generateExtensionsIndex(extensions, revision);

  console.log(
    [
      `extensions: ${extensions.length} generated, ${skipped.length} skipped`,
      ...skipped.map((entry) => `  ${entry}`),
    ].join("\n"),
  );
} finally {
  if (keep) console.log(`schemas kept in ${cache}`);
  else await fs.rm(cache, { recursive: true, force: true });
}
