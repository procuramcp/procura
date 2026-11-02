import { resolveToolset, type IrDocument, type ResolveResult, type TenantId, type Toolset } from "@cairnmcp/core";

/** A toolset resolved against its source, as served at one version of both rows. */
export type ResolvedToolset = { version: string; toolset: Toolset; ir: IrDocument; resolved: ResolveResult };

/**
 * Resolved toolsets by tenant and toolset id, reused while their version
 * (`toolsetVersion` in @cairnmcp/db) is unchanged. Loading, parsing, and
 * resolving a big IR on every MCP request is the expensive part of a call;
 * reusing the same resolved tool objects also lets the runtime reuse its
 * compiled input validators. Least recently used entries are evicted.
 *
 * Only derived data is cached: membership and access are still checked on
 * every request.
 */
export class ToolsetCache {
  readonly #entries = new Map<string, ResolvedToolset>();
  readonly #max: number;

  constructor(options: { maxEntries?: number } = {}) {
    this.#max = options.maxEntries ?? 200;
  }

  /** The cached entry if it is at `version`, else what `load` returns (cached when found). */
  async get(
    tenantId: TenantId,
    toolsetId: string,
    version: string,
    load: () => Promise<{ toolset: Toolset; ir: IrDocument } | undefined>,
  ): Promise<ResolvedToolset | undefined> {
    const key = `${tenantId}/${toolsetId}`;
    const hit = this.#entries.get(key);
    if (hit?.version === version) {
      // Re-insert so iteration order is least recently used first.
      this.#entries.delete(key);
      this.#entries.set(key, hit);
      return hit;
    }
    const loaded = await load();
    if (!loaded) {
      this.#entries.delete(key);
      return undefined;
    }
    const entry = { version, ...loaded, resolved: resolveToolset(loaded.toolset, loaded.ir) };
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    while (this.#entries.size > this.#max) this.#entries.delete(this.#entries.keys().next().value!);
    return entry;
  }

  get size(): number {
    return this.#entries.size;
  }
}
