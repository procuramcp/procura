// procura was called cairnmcp until D-047, and its settings were CAIRNMCP_*. Until existing
// deployments rename their env files, an old name still works when the new one is unset.
// Remove once no deployment uses the old names (D-047).
const OLD = "CAIRNMCP_";
const NEW = "PROCURA_";

/**
 * Copy each set `CAIRNMCP_X` to `PROCURA_X` where that is unset, in place.
 * Returns the old names it used, for a warning. Never reads out values.
 */
export function applyLegacyEnvNames(env: Record<string, string | undefined> = process.env): string[] {
  const used: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith(OLD) || value === undefined || value === "") continue;
    const renamed = NEW + name.slice(OLD.length);
    if (env[renamed] !== undefined && env[renamed] !== "") continue;
    env[renamed] = value;
    used.push(name);
  }
  return used.sort();
}

/** `applyLegacyEnvNames` for a script's entry point, with a warning on stderr. */
export function acceptLegacyEnvNames(): void {
  const used = applyLegacyEnvNames();
  if (used.length) console.warn(`warning: rename ${used.join(", ")} to ${NEW}* (procura was cairnmcp, D-047); the old names stop working in a later release`);
}
