import { isRecord } from "@cairnmcp/core";
import type { z } from "zod";

/** Thrown when an operation cannot be mapped. The operation is skipped with an error diagnostic. */
export class MappingError extends Error {
  readonly code: string;
  readonly pointer: string | undefined;
  constructor(code: string, message: string, pointer?: string) {
    super(message);
    this.code = code;
    this.pointer = pointer;
  }
}

export function escapePointerToken(token: string): string {
  return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function unescapePointerToken(token: string): string {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

/** Resolve a local JSON Pointer (`#/a/b`) against the document. Returns undefined if absent. */
export function resolvePointer(doc: unknown, pointer: string): unknown {
  if (!pointer.startsWith("#")) return undefined;
  const path = pointer.slice(1);
  if (path === "") return doc;
  if (!path.startsWith("/")) return undefined;
  let node: unknown = doc;
  for (const raw of path.slice(1).split("/")) {
    const token = unescapePointerToken(decodeURIComponent(raw));
    if (Array.isArray(node)) node = node[Number(token)];
    else if (isRecord(node) && Object.hasOwn(node, token)) node = node[token];
    else return undefined;
  }
  return node;
}

const MAX_REF_HOPS = 16;

/**
 * Follow `$ref` (local only) until a non-ref object, then parse it with `model`.
 * Returns the parsed value and the pointer it was found at.
 */
export function deref<T>(doc: unknown, value: unknown, model: z.ZodType<T>, pointer: string): { value: T; pointer: string } {
  let node = value;
  let at = pointer;
  for (let hops = 0; isRecord(node) && typeof node["$ref"] === "string"; hops++) {
    if (hops >= MAX_REF_HOPS) throw new MappingError("ref_cycle", `too many $ref hops (cycle?) from ${pointer}`, pointer);
    const ref = node["$ref"];
    if (!ref.startsWith("#")) {
      throw new MappingError("external_ref", `external $ref is not supported: ${ref} (bundle the document first)`, at);
    }
    const target = resolvePointer(doc, ref);
    if (target === undefined) throw new MappingError("unresolved_ref", `$ref target not found: ${ref}`, at);
    node = target;
    at = ref;
  }
  const parsed = model.safeParse(node);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MappingError("invalid_object", `invalid object at ${at}: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`, at);
  }
  return { value: parsed.data, pointer: at };
}
