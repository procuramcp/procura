// Updating a source to a new version of its API description (D-048): what changed, and how
// the toolsets and plans built on it are carried over. Pure: the caller loads and stores.
import type { AccessProfile, ProfileRule } from "./access.ts";
import type { IrDocument } from "./ir/document.ts";
import { OperationId } from "./ir/ids.ts";
import { objectPropertyNames, requiredPropertyNames } from "./ir/json-schema.ts";
import type { Operation } from "./ir/operation.ts";
import { curateSideEffect, type SideEffect } from "./ir/side-effect.ts";
import type { AuthScheme } from "./ir/source.ts";
import { resolveToolset, Toolset, type ToolsetIssue } from "./ir/toolset.ts";
import { sameJson as same, truncate } from "./util.ts";

export type OperationRef = { id: string; title: string; method: string; path: string; class: SideEffect };

export type OperationChangeKind = "request" | "inputs" | "output" | "description" | "auth" | "deprecated" | "side_effect" | "details";

export type OperationChange = OperationRef & {
  /** The id before, when the operation was matched by method and path instead. */
  renamedFrom?: string;
  kinds: OperationChangeKind[];
  /** One short line per change, for a person to read. */
  details: string[];
};

export type SourceDiff = {
  added: OperationRef[];
  removed: OperationRef[];
  /** Matched operations that differ, renamed ones included (even with nothing else changed). */
  changed: OperationChange[];
  unchanged: number;
  name?: { from: string; to: string };
  /** The document's base URL differs from the current one; `used` says which the update keeps. */
  baseUrl?: { current: string; document: string; used: "current" | "document" };
  authSchemes: { added: string[]; removed: string[]; changed: string[] };
  classifications: {
    /** People's classifications carried to the new version (D-043). */
    kept: Array<{ id: string; class: SideEffect }>;
    /** Ones whose operation is gone. */
    dropped: Array<{ id: string; class: SideEffect }>;
    /** Ones the new version now agrees with, so they're no longer needed. */
    nowAutomatic: Array<{ id: string; class: SideEffect }>;
    /** Where ingest's own classification changed, whether or not a person overrode it. */
    automaticChanged: Array<{ id: string; from: SideEffect; to: SideEffect; curated?: SideEffect }>;
  };
};

export type ToolsetEffect = {
  toolsetId: string;
  name: string;
  /** Tools whose operation was removed: dropped from the toolset. */
  removedTools: Array<{ name: string; operationId: string; enabled: boolean }>;
  /** Tools that follow a renamed operation. */
  renamedTools: Array<{ name: string; from: string; to: string }>;
  /** Enabled tools turned off because a pinned input no longer exists (pins kept, to re-check). */
  disabledTools: Array<{ name: string; operationId: string; pins: string[] }>;
  /** Enabled tools whose class changed: this changes who may call them (D-023). */
  sideEffectChanged: Array<{ name: string; operationId: string; from: SideEffect; to: SideEffect }>;
  /** Tool titles and descriptions nobody had edited, updated to the API's new text. */
  refreshedTexts: number;
  /** Problems left after the update (should be none); the toolset would fail closed (D-015). */
  issues: ToolsetIssue[];
};

export type ProfileEffect = {
  profileId: string;
  name: string;
  /** Operations a rule listed that are gone, dropped from the rule. */
  removedOperations: Array<{ toolsetId: string; operationId: string }>;
  /** Rules left with no operations, removed (they allowed nothing that still exists). */
  removedRules: string[];
};

export type SourceUpdatePlan = {
  /** The new version to store: the new document plus what people curated on the old one. */
  ir: IrDocument;
  diff: SourceDiff;
  /** Only the toolsets and profiles that change, as they should be stored. */
  toolsets: Toolset[];
  profiles: AccessProfile[];
  effects: { toolsets: ToolsetEffect[]; profiles: ProfileEffect[] };
};

/**
 * Plan an update of `current` to `next` (a fresh ingest of the new document, with the same
 * source id). `toolsets` and `profiles` are the tenant's; only those on this source are touched.
 */
export function planSourceUpdate(input: {
  current: IrDocument;
  next: IrDocument;
  toolsets: readonly Toolset[];
  profiles: readonly AccessProfile[];
  /** Which base URL to keep when they differ. A different host is a person's call. */
  baseUrl: "current" | "document";
}): SourceUpdatePlan {
  const { current, next } = input;
  if (current.source.id !== next.source.id) throw new Error(`source ids differ: ${current.source.id} and ${next.source.id}`);

  const match = matchOperations(current.operations, next.operations);
  const oldById = new Map(current.operations.map((op) => [op.id as string, op]));

  // The new operations, with people's classifications carried over (D-043).
  const classifications: SourceDiff["classifications"] = { kept: [], dropped: [], nowAutomatic: [], automaticChanged: [] };
  const operations = next.operations.map((op) => {
    const from = match.newToOld.get(op.id);
    const old = from === undefined ? undefined : oldById.get(from);
    if (!old) return op;
    const oldAutomatic = old.sideEffect.basis === "curated" ? old.sideEffect.automatic : old.sideEffect;
    const curated = old.sideEffect.basis === "curated" ? old.sideEffect.class : undefined;
    if (oldAutomatic && oldAutomatic.class !== op.sideEffect.class) {
      classifications.automaticChanged.push({ id: op.id, from: oldAutomatic.class, to: op.sideEffect.class, ...(curated ? { curated } : {}) });
    }
    if (curated === undefined) return op;
    const sideEffect = curateSideEffect(op.sideEffect, curated, old.sideEffect.reason);
    if (sideEffect.basis === "curated") classifications.kept.push({ id: op.id, class: curated });
    else classifications.nowAutomatic.push({ id: op.id, class: curated });
    return { ...op, sideEffect };
  });
  for (const id of match.removed) {
    const old = oldById.get(id)!;
    if (old.sideEffect.basis === "curated") classifications.dropped.push({ id, class: old.sideEffect.class });
  }

  // Source-level curation: fixed basic-auth usernames, and the base URL unless asked otherwise.
  const oldSchemes = new Map(current.source.authSchemes.map((s) => [s.id, s]));
  const authSchemes = next.source.authSchemes.map((s): AuthScheme => {
    const old = oldSchemes.get(s.id);
    if (s.type === "http_basic" && old?.type === "http_basic" && old.fixedUsername && !s.fixedUsername) return { ...s, fixedUsername: old.fixedUsername };
    return s;
  });
  const baseUrlDiffers = current.source.baseUrl !== next.source.baseUrl;
  const baseUrl = baseUrlDiffers && input.baseUrl === "current" ? current.source.baseUrl : next.source.baseUrl;
  const ir: IrDocument = { ...next, source: { ...next.source, baseUrl, authSchemes }, operations };

  const newById = new Map(ir.operations.map((op) => [op.id as string, op]));
  const diff: SourceDiff = {
    added: match.added.map((id) => ref(newById.get(id)!)),
    removed: match.removed.map((id) => ref(oldById.get(id)!)),
    changed: [],
    unchanged: 0,
    authSchemes: diffSchemes(current.source.authSchemes, authSchemes),
    classifications,
  };
  for (const [newId, oldId] of match.newToOld) {
    const change = compareOperations(oldById.get(oldId)!, newById.get(newId)!);
    if (change) diff.changed.push(change);
    else diff.unchanged++;
  }
  diff.changed.sort((a, b) => a.id.localeCompare(b.id));
  if (current.source.name !== next.source.name) diff.name = { from: current.source.name, to: next.source.name };
  if (baseUrlDiffers) diff.baseUrl = { current: current.source.baseUrl, document: next.source.baseUrl, used: input.baseUrl };

  const toolsets: Toolset[] = [];
  const toolsetEffects: ToolsetEffect[] = [];
  for (const toolset of input.toolsets) {
    if (toolset.sourceId !== current.source.id) continue;
    const { updated, effect } = carryToolset(toolset, { oldById, newById, oldToNew: match.oldToNew, ir });
    toolsetEffects.push(effect);
    if (!same(updated, Toolset.parse(toolset))) toolsets.push(updated);
  }

  const onSource = new Set(input.toolsets.filter((t) => t.sourceId === current.source.id).map((t) => t.id as string));
  const profiles: AccessProfile[] = [];
  const profileEffects: ProfileEffect[] = [];
  for (const profile of input.profiles) {
    const { updated, effect } = carryProfile(profile, onSource, match.oldToNew);
    if (!updated) continue;
    profiles.push(updated);
    profileEffects.push(effect);
  }

  return { ir, diff, toolsets, profiles, effects: { toolsets: toolsetEffects, profiles: profileEffects } };
}

/** Old and new operations paired by id, then leftovers by method and path (one to one). */
function matchOperations(oldOps: readonly Operation[], newOps: readonly Operation[]) {
  const newIds = new Set(newOps.map((op) => op.id as string));
  const oldToNew = new Map<string, string>();
  for (const op of oldOps) if (newIds.has(op.id)) oldToNew.set(op.id, op.id);

  const key = (op: Operation) => `${op.mapping.method} ${op.mapping.pathTemplate}`;
  const unmatchedNew = newOps.filter((op) => !oldToNew.has(op.id));
  const byKey = new Map<string, string[]>();
  for (const op of unmatchedNew) byKey.set(key(op), [...(byKey.get(key(op)) ?? []), op.id]);
  const oldByKey = new Map<string, string[]>();
  for (const op of oldOps) if (!oldToNew.has(op.id)) oldByKey.set(key(op), [...(oldByKey.get(key(op)) ?? []), op.id]);
  for (const [k, olds] of oldByKey) {
    const news = byKey.get(k);
    // Only an unambiguous pair counts as a rename.
    if (olds.length === 1 && news?.length === 1) oldToNew.set(olds[0]!, news[0]!);
  }

  const newToOld = new Map([...oldToNew].map(([o, n]) => [n, o]));
  return {
    oldToNew,
    newToOld,
    added: newOps.filter((op) => !newToOld.has(op.id)).map((op) => op.id as string),
    removed: oldOps.filter((op) => !oldToNew.has(op.id)).map((op) => op.id as string),
  };
}

function ref(op: Operation): OperationRef {
  return { id: op.id, title: op.title, method: op.mapping.method, path: op.mapping.pathTemplate, class: op.sideEffect.class };
}

function compareOperations(old: Operation, op: Operation): OperationChange | undefined {
  const kinds: OperationChangeKind[] = [];
  const details: string[] = [];
  const note = (kind: OperationChangeKind, detail: string) => {
    if (!kinds.includes(kind)) kinds.push(kind);
    details.push(detail);
  };

  if (old.mapping.method !== op.mapping.method || old.mapping.pathTemplate !== op.mapping.pathTemplate) {
    note("request", `${old.mapping.method} ${old.mapping.pathTemplate} → ${op.mapping.method} ${op.mapping.pathTemplate}`);
  }
  const before = new Set(objectPropertyNames(old.input));
  const after = new Set(objectPropertyNames(op.input));
  const added = [...after].filter((p) => !before.has(p));
  const removed = [...before].filter((p) => !after.has(p));
  const wasRequired = new Set(requiredPropertyNames(old.input));
  const nowRequired = requiredPropertyNames(op.input).filter((p) => !wasRequired.has(p) && before.has(p));
  if (added.length) note("inputs", `new inputs: ${list(added)}`);
  if (removed.length) note("inputs", `removed inputs: ${list(removed)}`);
  if (nowRequired.length) note("inputs", `now required: ${list(nowRequired)}`);
  if (!added.length && !removed.length && !nowRequired.length && !same(old.input, op.input)) note("inputs", "input details changed");
  if (!same(old.output, op.output)) note("output", "response schema changed");
  if (old.title !== op.title || old.description !== op.description) note("description", old.title !== op.title ? `title: ${old.title} → ${op.title}` : "description changed");
  if (!same(old.auth, op.auth)) note("auth", "sign-in requirements changed");
  if (!old.deprecated && op.deprecated) note("deprecated", "now deprecated");
  if (old.deprecated && !op.deprecated) note("deprecated", "no longer deprecated");
  if (old.sideEffect.class !== op.sideEffect.class) note("side_effect", `${old.sideEffect.class} → ${op.sideEffect.class}`);
  // Bindings for added or removed inputs are already reported above.
  const shared = (m: Operation["mapping"]) => ({ ...m, parameters: m.parameters.filter((p) => before.has(p.property) && after.has(p.property)) });
  if (!kinds.includes("request") && !same(shared(old.mapping), shared(op.mapping))) note("details", "how the request is sent changed");

  if (kinds.length === 0 && old.id === op.id) return undefined;
  return { ...ref(op), ...(old.id !== op.id ? { renamedFrom: old.id } : {}), kinds, details };
}

function list(names: string[]): string {
  return names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
}

function diffSchemes(old: readonly AuthScheme[], next: readonly AuthScheme[]): SourceDiff["authSchemes"] {
  const oldById = new Map(old.map((s) => [s.id, s]));
  const newIds = new Set(next.map((s) => s.id));
  return {
    added: next.filter((s) => !oldById.has(s.id)).map((s) => s.id),
    removed: old.filter((s) => !newIds.has(s.id)).map((s) => s.id),
    changed: next.filter((s) => oldById.has(s.id) && !same(oldById.get(s.id), s)).map((s) => s.id),
  };
}

function carryToolset(
  toolset: Toolset,
  ctx: { oldById: Map<string, Operation>; newById: Map<string, Operation>; oldToNew: Map<string, string>; ir: IrDocument },
): { updated: Toolset; effect: ToolsetEffect } {
  const effect: ToolsetEffect = { toolsetId: toolset.id, name: toolset.name, removedTools: [], renamedTools: [], disabledTools: [], sideEffectChanged: [], refreshedTexts: 0, issues: [] };
  const tools: Toolset["tools"] = [];
  for (const binding of toolset.tools) {
    const to = ctx.oldToNew.get(binding.operationId);
    const old = ctx.oldById.get(binding.operationId);
    const op = to === undefined ? undefined : ctx.newById.get(to);
    if (!op) {
      // A binding for an operation that was already missing stays as it was: not this update's doing.
      if (old) effect.removedTools.push({ name: binding.name, operationId: binding.operationId, enabled: binding.enabled });
      else tools.push(binding);
      continue;
    }
    let next = binding;
    if (op.id !== binding.operationId) {
      next = { ...next, operationId: OperationId.parse(op.id) };
      effect.renamedTools.push({ name: binding.name, from: binding.operationId, to: op.id });
    }
    // Text nobody edited follows the API; edited text stays.
    if (old && next.description === truncate(old.description, 4000) && old.description !== op.description) {
      next = { ...next, description: truncate(op.description, 4000) };
      effect.refreshedTexts++;
    }
    if (old && next.title === old.title && old.title !== op.title) next = { ...next, title: op.title };
    if (next.enabled) {
      const inputs = new Set(objectPropertyNames(op.input));
      const missing = Object.keys(next.pinnedInputs).filter((k) => !inputs.has(k));
      if (missing.length) {
        // Off, not unpinned: if an input was renamed, dropping its pin would hand agents a value
        // the toolset kept from them. A person re-checks the pins and turns it back on.
        next = { ...next, enabled: false };
        effect.disabledTools.push({ name: binding.name, operationId: op.id, pins: missing });
      } else if (old && old.sideEffect.class !== op.sideEffect.class) {
        effect.sideEffectChanged.push({ name: binding.name, operationId: op.id, from: old.sideEffect.class, to: op.sideEffect.class });
      }
    }
    tools.push(next);
  }
  const updated = Toolset.parse({ ...toolset, tools });
  const resolved = resolveToolset(updated, ctx.ir);
  if (!resolved.ok) effect.issues = resolved.issues;
  return { updated, effect };
}

function carryProfile(profile: AccessProfile, onSource: Set<string>, oldToNew: Map<string, string>): { updated?: AccessProfile; effect: ProfileEffect } {
  const effect: ProfileEffect = { profileId: profile.id, name: profile.name, removedOperations: [], removedRules: [] };
  let changed = false;
  const rules: ProfileRule[] = [];
  for (const rule of profile.rules) {
    if (!onSource.has(rule.toolsetId) || rule.operations === null) {
      rules.push(rule);
      continue;
    }
    const operations: OperationId[] = [];
    for (const id of rule.operations) {
      const to = oldToNew.get(id);
      if (to === undefined) {
        effect.removedOperations.push({ toolsetId: rule.toolsetId, operationId: id });
        changed = true;
      } else {
        if (to !== id) changed = true;
        operations.push(OperationId.parse(to));
      }
    }
    if (operations.length === 0) {
      // Nothing it allowed still exists; an empty list would mean "every tool" if kept as null.
      effect.removedRules.push(rule.toolsetId);
      continue;
    }
    rules.push({ ...rule, operations });
  }
  return changed ? { updated: { ...profile, rules }, effect } : { effect };
}
