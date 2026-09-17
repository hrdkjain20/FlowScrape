import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("fixtures");
const mime = new Map([[".html", "text/html; charset=utf-8"], [".css", "text/css; charset=utf-8"], [".js", "text/javascript; charset=utf-8"]]);

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new globalThis.URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const requested = path.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!requested.startsWith(`${root}${path.sep}`)) throw new Error("Outside fixture root");
    const body = await readFile(requested);
    response.writeHead(200, { "content-type": mime.get(path.extname(requested)) ?? "application/octet-stream", "cache-control": "no-store" });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(4174, "127.0.0.1", () => globalThis.console.log("FlowScrape fixtures: http://127.0.0.1:4174"));
