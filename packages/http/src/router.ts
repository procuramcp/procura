/**
 * One endpoint: a method (or several) and a path pattern whose capture groups
 * are passed to `handle` in order. `C` is whatever the caller's handlers need
 * (the request, the signed-in user, ...).
 */
export type Route<C> = {
  method: string | readonly string[];
  path: RegExp;
  handle: (context: C, params: string[]) => Promise<Response>;
};

/**
 * Run the first route whose pattern matches `path` and whose method matches,
 * or return undefined when none does. Patterns should be anchored (`^...$`).
 */
export function dispatch<C>(routes: readonly Route<C>[], context: C, method: string, path: string): Promise<Response> | undefined {
  for (const route of routes) {
    const methods = typeof route.method === "string" ? [route.method] : route.method;
    if (!methods.includes(method)) continue;
    const match = route.path.exec(path);
    if (match) return route.handle(context, match.slice(1).map((p) => p ?? ""));
  }
  return undefined;
}
