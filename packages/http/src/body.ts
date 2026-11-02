/** A request body that is too large or malformed. Its message is safe to show the client. */
export class BodyError extends Error {}

/**
 * The body as text, read as a stream and abandoned past `maxBytes`, so an
 * oversized upload is never held in memory. Throws `BodyError` when too large.
 */
export async function readText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new BodyError("request body is too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyError("request body is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The body parsed as JSON. Throws `BodyError` when too large or not JSON. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await readText(request, maxBytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BodyError("request body must be JSON");
  }
}

/**
 * The body as form parameters, or undefined unless it is
 * `application/x-www-form-urlencoded`. Throws `BodyError` when too large.
 */
export async function readForm(request: Request, maxBytes: number): Promise<URLSearchParams | undefined> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return undefined;
  return new URLSearchParams(await readText(request, maxBytes));
}
