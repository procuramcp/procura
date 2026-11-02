/** A cookie's value from the request, or undefined if absent or empty. */
export function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
  return undefined;
}

export type CookieOptions = { path: string; maxAgeSeconds: number; secure: boolean };

/** A `Set-Cookie` value: always HttpOnly and SameSite=Lax. A max age of 0 deletes it. */
export function setCookie(name: string, value: string, options: CookieOptions): string {
  return `${name}=${value}; Path=${options.path}; HttpOnly; SameSite=Lax; Max-Age=${options.maxAgeSeconds}${options.secure ? "; Secure" : ""}`;
}
