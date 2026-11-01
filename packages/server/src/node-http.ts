import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";

/** Serve a fetch-style handler with node:http. */
export function serve(handler: (request: Request) => Promise<Response>, options: { port: number; host?: string; publicUrl: string }): Server {
  const server = createServer((req, res) => {
    void handle(handler, req, res, options.publicUrl);
  });
  server.listen(options.port, options.host);
  return server;
}

async function handle(handler: (request: Request) => Promise<Response>, req: IncomingMessage, res: ServerResponse, publicUrl: string): Promise<void> {
  try {
    const response = await handler(toRequest(req, publicUrl));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch {
    // Never echo internals to the client.
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(res.headersSent ? undefined : JSON.stringify({ error: "internal_error" }));
  }
}

// The URL is built from the configured public URL, not the Host header, so a
// spoofed Host can't change the resource that tokens are checked against.
function toRequest(req: IncomingMessage, publicUrl: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(new URL(req.url ?? "/", publicUrl), {
    method: req.method ?? "GET",
    headers,
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
  });
}
