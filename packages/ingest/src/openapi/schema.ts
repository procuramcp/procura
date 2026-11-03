import { isRecord, type JsonSchema } from "@procura/core";
import { MappingError, resolvePointer, unescapePointerToken } from "./refs.ts";

/**
 * `input`: the schema describes data the agent sends (drop `readOnly` properties).
 * `output`: data the API returns (drop `writeOnly` properties).
 */
export type Direction = "input" | "output";

export type OasDialect = "3.0" | "3.1";

const COMPONENT_PREFIX = "#/components/schemas/";

// Keywords whose value is a schema, a map of schemas, or a list of schemas.
const SCHEMA_KEYS = new Set([
  "contentSchema",
  "items",
  "additionalProperties",
  "not",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "dependentSchemas", "$defs"]);
const SCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

// OpenAPI-only keywords, converted or dropped silently because their meaning is known.
const DROPPED_KEYS = new Set(["discriminator", "xml", "externalDocs", "nullable", "example"]);

// Every other keyword kept in IR schemas: JSON Schema 2020-12 vocabularies, minus
// `$id`, `$schema`, `$anchor` and `$dynamic*`, which would change how refs resolve.
const DATA_KEYS = new Set([
  "$comment",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "maxContains",
  "minContains",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "format",
  "contentEncoding",
  "contentMediaType",
]);

const MAX_INLINE_DEPTH = 32;

type Schema = Record<string, unknown> | boolean;

/** Reports something the converter changed. Called at most once per code and keyword. */
export type ConversionNote = (code: string, message: string, pointer: string) => void;

/**
 * Converts OpenAPI schemas to self-contained JSON Schema 2020-12.
 *
 * Component refs (`#/components/schemas/X`) become `#/$defs/X`, and `bundle`
 * attaches the transitive closure of referenced components under `$defs`, so
 * recursive schemas work without inlining. Components are converted once per
 * direction and cached.
 */
export class SchemaConverter {
  readonly #doc: unknown;
  readonly #dialect: OasDialect;
  readonly #components = new Map<string, { schema: Schema; refs: Set<string> }>();
  readonly #note: ConversionNote;
  readonly #noted = new Set<string>();

  constructor(doc: unknown, dialect: OasDialect, note: ConversionNote = () => {}) {
    this.#doc = doc;
    this.#dialect = dialect;
    this.#note = note;
  }

  #noteOnce(code: string, key: string, message: string, pointer: string): void {
    const id = `${code}:${key}`;
    if (this.#noted.has(id)) return;
    this.#noted.add(id);
    this.#note(code, message, pointer);
  }

  /** Convert one schema; component names it references are added to `refs`. */
  convert(schema: unknown, direction: Direction, pointer: string, refs: Set<string>): Schema {
    return this.#node(schema, direction, pointer, refs, 0);
  }

  /** Attach `$defs` for every component reachable from `refs`. */
  bundle(root: Record<string, unknown>, direction: Direction, refs: Set<string>): JsonSchema {
    const defs: Record<string, Schema> = {};
    const queue = [...refs];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (name in defs) continue;
      const component = this.#component(name, direction);
      defs[name] = component.schema;
      for (const r of component.refs) if (!(r in defs)) queue.push(r);
    }
    const sorted = Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)));
    return (Object.keys(sorted).length > 0 ? { ...root, $defs: sorted } : root) as JsonSchema;
  }

  /**
   * Like `bundle`, but keeps the JSON under `maxChars` by leaving components beyond some
   * number of hops from the root open: just their title, description, and type (D-042). That
   * only loosens the schema, so it still accepts everything the full one does. `openAt` is the
   * first open level (1 = the components the root names directly). Undefined when even that is
   * too big.
   */
  bundleWithin(
    root: Record<string, unknown>,
    direction: Direction,
    refs: Set<string>,
    maxChars: number,
  ): { schema: JsonSchema; openAt?: number } | undefined {
    const full = this.bundle(root, direction, refs);
    if (JSON.stringify(full).length <= maxChars) return { schema: full };

    // levels[i]: components first reached i + 1 hops from the root. A component's refs are at
    // its own level or the next, so keeping levels below `keep` whole and opening level `keep`
    // leaves no dangling ref.
    const levels: string[][] = [];
    const seen = new Set(refs);
    for (let frontier = [...refs]; frontier.length > 0; ) {
      levels.push(frontier);
      const next: string[] = [];
      for (const name of frontier) {
        for (const r of this.#component(name, direction).refs) {
          if (!seen.has(r)) {
            seen.add(r);
            next.push(r);
          }
        }
      }
      frontier = next;
    }

    let best: { schema: JsonSchema; openAt: number } | undefined;
    for (let keep = 0; keep < levels.length; keep++) {
      const defs: Record<string, Schema> = {};
      for (const [i, names] of levels.entries()) {
        if (i > keep) break;
        for (const name of names) {
          const schema = this.#component(name, direction).schema;
          defs[name] = i < keep ? schema : openSchema(schema);
        }
      }
      const sorted = Object.fromEntries(Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)));
      const schema = { ...root, $defs: sorted } as JsonSchema;
      if (JSON.stringify(schema).length > maxChars) break;
      best = { schema, openAt: keep + 1 };
    }
    return best;
  }

  #component(name: string, direction: Direction): { schema: Schema; refs: Set<string> } {
    const key = `${direction}:${name}`;
    const cached = this.#components.get(key);
    if (cached) return cached;
    const pointer = `${COMPONENT_PREFIX}${name}`;
    const raw = resolvePointer(this.#doc, pointer);
    if (raw === undefined) throw new MappingError("unresolved_ref", `$ref target not found: ${pointer}`, pointer);
    const refs = new Set<string>();
    // Cache a placeholder first so self-references terminate.
    const entry = { schema: {} as Schema, refs };
    this.#components.set(key, entry);
    entry.schema = this.#node(raw, direction, pointer, refs, 0);
    return entry;
  }

  #node(schema: unknown, direction: Direction, pointer: string, refs: Set<string>, depth: number): Schema {
    if (typeof schema === "boolean") return schema;
    if (!isRecord(schema)) throw new MappingError("invalid_schema", `schema must be an object at ${pointer}`, pointer);

    if (typeof schema["$ref"] === "string") {
      const converted = this.#ref(schema["$ref"], direction, pointer, refs, depth);
      // OpenAPI 3.0 ignores siblings of $ref; 3.1 (JSON Schema 2020-12) applies them.
      if (this.#dialect === "3.0") return converted;
      const { $ref: _ignored, ...siblings } = schema;
      const rest = this.#node(siblings, direction, pointer, refs, depth);
      return typeof rest === "boolean" ? converted : { ...(converted as object), ...rest };
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (DROPPED_KEYS.has(key) || key.startsWith("x-") || key === "$ref") continue;
      const at = `${pointer}/${key}`;
      if (SCHEMA_KEYS.has(key) && (isRecord(value) || typeof value === "boolean")) {
        out[key] = this.#node(value, direction, at, refs, depth);
      } else if (SCHEMA_MAP_KEYS.has(key) && key !== "patternProperties" && isRecord(value)) {
        out[key] = Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, this.#node(v, direction, `${at}/${k}`, refs, depth)]),
        );
      } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
        out[key] = value.map((v, i) => this.#node(v, direction, `${at}/${i}`, refs, depth));
      } else if (key === "pattern" && typeof value === "string") {
        const fixed = unicodePattern(value);
        if (fixed === undefined) this.#noteOnce("pattern_dropped", at, `pattern ${JSON.stringify(value)} is not a valid regular expression; dropped`, at);
        else {
          if (fixed !== value) this.#noteOnce("pattern_rewritten", at, `pattern ${JSON.stringify(value)} rewritten as ${JSON.stringify(fixed)} (needless escapes)`, at);
          out[key] = fixed;
        }
      } else if (key === "patternProperties" && isRecord(value)) {
        const props: Record<string, Schema> = {};
        for (const [p, v] of Object.entries(value)) {
          const fixed = unicodePattern(p);
          // Skip an unusable property pattern. Rare; it only tightens a schema that also
          // forbids additional properties.
          if (fixed === undefined) this.#noteOnce("pattern_dropped", `${at}/${p}`, `property pattern ${JSON.stringify(p)} is not a valid regular expression; dropped`, at);
          else props[fixed] = this.#node(v, direction, `${at}/${p}`, refs, depth);
        }
        out[key] = props;
      } else if (key === "enum" && Array.isArray(value) && value.length === 0) {
        // Matches nothing, so it is always a spec bug; usually another keyword carries the values.
        this.#noteOnce("empty_enum", at, "empty enum would accept no value; dropped", at);
      } else if (DATA_KEYS.has(key)) {
        out[key] = value;
      } else {
        this.#noteOnce(
          "unknown_schema_keyword",
          key,
          `"${key}" is not a JSON Schema 2020-12 keyword; dropped (first seen here)`,
          at,
        );
      }
    }

    if (this.#dialect === "3.0") convertExclusiveBounds(schema, out);
    if (schema["example"] !== undefined && out["examples"] === undefined) out["examples"] = [schema["example"]];
    pruneByDirection(schema, out, direction);

    if (this.#dialect === "3.0" && schema["nullable"] === true) return makeNullable(out);
    return out;
  }

  #ref(ref: string, direction: Direction, pointer: string, refs: Set<string>, depth: number): Schema {
    if (!ref.startsWith("#")) {
      throw new MappingError("external_ref", `external $ref is not supported: ${ref} (bundle the document first)`, pointer);
    }
    const tail = ref.slice(COMPONENT_PREFIX.length);
    if (ref.startsWith(COMPONENT_PREFIX) && !tail.includes("/")) {
      const name = unescapePointerToken(tail);
      if (resolvePointer(this.#doc, ref) === undefined) {
        throw new MappingError("unresolved_ref", `$ref target not found: ${ref}`, pointer);
      }
      refs.add(name);
      return { $ref: `#/$defs/${tail}` };
    }
    // Any other local ref (e.g. into a property of a component): inline it.
    if (depth >= MAX_INLINE_DEPTH) throw new MappingError("ref_cycle", `inline $ref nesting too deep at ${pointer}`, pointer);
    const target = resolvePointer(this.#doc, ref);
    if (target === undefined) throw new MappingError("unresolved_ref", `$ref target not found: ${ref}`, pointer);
    return this.#node(target, direction, ref, refs, depth + 1);
  }
}

// Characters a regex may escape in Unicode mode (ECMA-262 SyntaxCharacter, plus "/" and "-").
const ESCAPABLE = new Set([..."^$\\.*+?()[]{}|/-"]);

/**
 * A pattern that compiles in Unicode mode, as JSON Schema validators run them. Specs often
 * escape characters needlessly (DigitalOcean: `^[a-zA-Z0-9_\-\:]+$`), which plain JavaScript
 * allows and Unicode mode refuses; those escapes are removed, which doesn't change the match.
 * Undefined if it still doesn't compile.
 */
export function unicodePattern(pattern: string): string | undefined {
  if (compiles(pattern)) return pattern;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    const next = pattern[i + 1];
    if (c === "\\" && next !== undefined) {
      out += /[A-Za-z0-9]/.test(next) || ESCAPABLE.has(next) ? c + next : next;
      i++;
    } else out += c;
  }
  return compiles(out) ? out : undefined;
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/** A component reduced to what describes it, without constraints on its contents or refs. */
function openSchema(schema: Schema): Schema {
  if (typeof schema === "boolean") return schema;
  const out: Record<string, unknown> = {};
  for (const key of ["title", "description", "type"]) if (schema[key] !== undefined) out[key] = schema[key];
  return out;
}

/** OpenAPI 3.0 `nullable: true` → JSON Schema `null` type. */
function makeNullable(schema: Record<string, unknown>): Schema {
  const type = schema["type"];
  if (typeof type === "string") {
    const out: Record<string, unknown> = { ...schema, type: [type, "null"] };
    if (Array.isArray(schema["enum"]) && !schema["enum"].includes(null)) out["enum"] = [...schema["enum"], null];
    return out;
  }
  if (Array.isArray(type)) return type.includes("null") ? schema : { ...schema, type: [...type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

/** OpenAPI 3.0 boolean `exclusiveMinimum`/`exclusiveMaximum` → numeric form. */
function convertExclusiveBounds(source: Record<string, unknown>, out: Record<string, unknown>): void {
  for (const [flag, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ] as const) {
    if (typeof source[flag] !== "boolean") continue;
    if (source[flag] === true && typeof source[bound] === "number") {
      out[flag] = source[bound];
      delete out[bound];
    } else {
      delete out[flag];
    }
  }
}

/** Drop properties the agent should not send (readOnly) or will not receive (writeOnly). */
function pruneByDirection(source: Record<string, unknown>, out: Record<string, unknown>, direction: Direction): void {
  const props = source["properties"];
  if (!isRecord(props)) return;
  const flag = direction === "input" ? "readOnly" : "writeOnly";
  const dropped = Object.entries(props)
    .filter(([, v]) => isRecord(v) && v[flag] === true)
    .map(([k]) => k);
  if (dropped.length === 0) return;
  const outProps = out["properties"] as Record<string, unknown>;
  for (const name of dropped) delete outProps[name];
  if (Array.isArray(out["required"])) out["required"] = out["required"].filter((r) => !dropped.includes(r as string));
}
