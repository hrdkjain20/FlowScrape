import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const dist = path.resolve("dist");
const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("Production manifest is not MV3.");
if (manifest.host_permissions?.length) throw new Error("Production build unexpectedly has required host permissions.");
if (manifest.permissions?.includes("<all_urls>")) throw new Error("Production build unexpectedly requires <all_urls>.");

const assets = await readdir(path.join(dist, "assets"));
const loaderName = assets.find((name) => /^bootstrap.*-loader-.*\.js$/.test(name));
if (!loaderName) throw new Error("Injectable content-script loader was not emitted.");
const loader = await readFile(path.join(dist, "assets", loaderName), "utf8");
if (!loader.includes("await import(") || !loader.includes("chrome.runtime.getURL")) {
  throw new Error("Content entry is not using the CRX dynamic-import loader.");
}
if (/^\s*import\s/m.test(loader)) throw new Error("Content loader contains a static import and cannot be injected as a classic script.");

globalThis.console.log(`Verified MV3 artifact and injectable content loader: ${loaderName}`);
