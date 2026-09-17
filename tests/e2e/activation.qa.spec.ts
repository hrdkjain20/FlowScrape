import { test, expect, chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type RuntimeRecord = Record<string, unknown> & { type?: string };

let context: BrowserContext;
let extensionId: string;
let origin: string;
let server: Server;
let worker: Worker;
let qaExtensionPath: string;
const workerErrors: string[] = [];
let groqMode: "ok" | "unauthorized" | "slow" = "ok";
const TEST_KEY = "gsk_" + "TEST_ONLY_NOT_A_REAL_KEY";

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

const openHarness = async (): Promise<Page> => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/privacy/index.html`);
  await page.evaluate(() => {
    const qaWindow = window as typeof window & {
      __qaMessages?: unknown[];
      __qaPort?: chrome.runtime.Port;
    };
    qaWindow.__qaMessages = [];
    qaWindow.__qaPort = chrome.runtime.connect({ name: "flowscrape-panel" });
    qaWindow.__qaPort.onMessage.addListener((message) => qaWindow.__qaMessages?.push(message));
  });
  return page;
};

const messages = async (harness: Page): Promise<RuntimeRecord[]> => harness.evaluate(() => {
  const qaWindow = window as typeof window & { __qaMessages?: RuntimeRecord[] };
  return qaWindow.__qaMessages ?? [];
});

const send = async (harness: Page, message: RuntimeRecord): Promise<void> => {
  await harness.evaluate((payload) => {
    const qaWindow = window as typeof window & { __qaPort?: chrome.runtime.Port };
    qaWindow.__qaPort?.postMessage(payload);
  }, message);
};

const waitForState = async (harness: Page, predicate: (state: RuntimeRecord) => boolean): Promise<RuntimeRecord> => {
  await expect.poll(async () => {
    const all = await messages(harness);
    return all.filter((message) => message.type === "STATE").map((message) => message.state as RuntimeRecord | null).some((state) => Boolean(state) && predicate(state!));
  }, { timeout: 10_000 }).toBe(true);
  const all = await messages(harness);
  return all.filter((message) => message.type === "STATE").map((message) => message.state as RuntimeRecord | null).filter((state): state is RuntimeRecord => Boolean(state)).reverse().find(predicate)!;
};

const waitForMessage = async (harness: Page, type: string): Promise<RuntimeRecord> => {
  await expect.poll(async () => (await messages(harness)).some((message) => message.type === type), { timeout: 15_000 }).toBe(true);
  return (await messages(harness)).filter((message) => message.type === type).at(-1)!;
};

const activate = async (fixture: string): Promise<{ target: Page; harness: Page; state: RuntimeRecord }> => {
  const target = await context.newPage();
  await target.goto(`${origin}/${fixture}`);
  const harness = await openHarness();
  await target.bringToFront();
  await send(harness, { type: "PANEL_CONNECT" });
  const state = await waitForState(harness, (candidate) => candidate.status === "ready" && (candidate.page as RuntimeRecord)?.url === target.url());
  return { target, harness, state };
};

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    try {
      const rawPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const relativePath = rawPath === "/" ? "index.html" : decodeURIComponent(rawPath.slice(1));
      const fixtureRoot = path.resolve("fixtures");
      const filePath = path.resolve(fixtureRoot, relativePath);
      if (!filePath.startsWith(`${fixtureRoot}${path.sep}`) && filePath !== path.join(fixtureRoot, "index.html")) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { "content-type": contentTypes[path.extname(filePath)] ?? "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed to bind.");
  origin = `http://127.0.0.1:${address.port}`;

  const extensionPath = path.resolve("dist");
  qaExtensionPath = await mkdtemp(path.join(tmpdir(), "flowscrape-qa-"));
  await cp(extensionPath, qaExtensionPath, { recursive: true });
  const qaManifestPath = path.join(qaExtensionPath, "manifest.json");
  const qaManifest = JSON.parse(await readFile(qaManifestPath, "utf8")) as Record<string, unknown>;
  qaManifest.host_permissions = ["http://127.0.0.1/*", "https://www.facebook.com/*", "https://api.groq.com/*"];
  await writeFile(qaManifestPath, JSON.stringify(qaManifest, null, 2));
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${qaExtensionPath}`, `--load-extension=${qaExtensionPath}`]
  });
  await context.route("https://api.groq.com/**", async (route) => {
    const mode = groqMode;
    if (mode === "unauthorized") { await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { message: "invalid" } }) }); return; }
    if (route.request().url().endsWith("/models")) { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) }); return; }
    if (mode === "slow") await new Promise((resolve) => setTimeout(resolve, 4_000));
    const body = route.request().postDataJSON() as { messages: Array<{ content: string }> };
    const input = JSON.parse(body.messages[1].content) as { fieldProfiles: Array<{ id: string; name: string; type: string }> };
    const selected = input.fieldProfiles.slice(0, 2);
    const plan = {
      recordType: "QA products",
      fields: selected.map((field, index) => ({ name: `Clean ${field.name} ${index + 1}`, type: ["text", "number", "price", "date", "url", "image", "email", "phone"].includes(field.type) ? field.type : "text", sources: [field.id], operation: "copy", pattern: "", multiple: false, reason: "Useful QA field", confidence: 0.95 })),
      droppedSources: input.fieldProfiles.slice(2).map((field) => field.id),
      deduplicateBy: [`Clean ${selected[0].name} 1`],
      summary: "QA generated a dynamic schema."
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }) });
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
  worker.on("console", (message) => {
    if (message.type() === "error") workerErrors.push(message.text());
  });
});

test.afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
  await rm(qaExtensionPath, { recursive: true, force: true });
});

test("rejects restricted pages without creating Untitled error state", async () => {
  const target = await context.newPage();
  await target.goto("chrome://version/");
  const harness = await openHarness();
  await target.bringToFront();
  await send(harness, { type: "PANEL_CONNECT" });
  await expect.poll(async () => (await messages(harness)).some((message) => message.type === "NOTICE" && /toolbar icon.*grant access/i.test(String(message.message))), { timeout: 5_000 }).toBe(true);
  const states = (await messages(harness)).filter((message) => message.type === "STATE").map((message) => message.state as RuntimeRecord | null).filter(Boolean);
  expect(states.some((state) => state?.status === "error" || (state?.page as RuntimeRecord | undefined)?.title === "Untitled page")).toBe(false);
  await Promise.all([target.close(), harness.close()]);
});

for (const fixture of ["products.html", "shadow.html"]) {
  test(`injects, handshakes, and detects on ${fixture}`, async () => {
    const { target, harness, state } = await activate(fixture);
    expect((state.page as RuntimeRecord).title).not.toBe("Untitled page");
    expect((state.page as RuntimeRecord).hostname).toBe("127.0.0.1");
    expect((state.candidates as unknown[]).length).toBeGreaterThan(0);
    const ping = await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" }), Number(state.tabId));
    expect(ping).toEqual({ ok: true });
    await Promise.all([target.close(), harness.close()]);
  });
}

for (const fixture of ["csp.html", "large.html"]) {
  test(`injects and handshakes on ${fixture}`, async () => {
    const { target, harness, state } = await activate(fixture);
    expect((state.page as RuntimeRecord).title).not.toBe("Untitled page");
    const ping = await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" }), Number(state.tabId));
    expect(ping).toEqual({ ok: true });
    await Promise.all([target.close(), harness.close()]);
  });

  test(`detects the repeated collection on ${fixture}`, async () => {
    const { target, harness, state } = await activate(fixture);
    expect((state.candidates as unknown[]).length).toBeGreaterThan(0);
    if (fixture === "large.html") expect(Number(((state.candidates as RuntimeRecord[])[0]).itemCount)).toBe(10_000);
    await Promise.all([target.close(), harness.close()]);
  });
}

test("coalesces concurrent panel activation without a receiving-end race", async () => {
  const target = await context.newPage();
  await target.goto(`${origin}/products.html`);
  const harnesses = await Promise.all(Array.from({ length: 5 }, () => openHarness()));
  await target.bringToFront();
  await Promise.all(harnesses.map((harness) => send(harness, { type: "PANEL_CONNECT" })));
  await Promise.all(harnesses.map((harness) => waitForState(harness, (state) => state.status === "ready" && (state.page as RuntimeRecord)?.url === target.url())));
  for (const harness of harnesses) {
    expect((await messages(harness)).filter((message) => message.type === "NOTICE")).toEqual([]);
  }
  await Promise.all([target.close(), ...harnesses.map((harness) => harness.close())]);
});

test("reinjects and resumes detection after the webpage reloads", async () => {
  const { target, harness } = await activate("products.html");
  await target.reload();
  await send(harness, { type: "DETECT" });
  const recoveredState = await waitForState(harness, (state) => state.status === "ready" && (state.page as RuntimeRecord)?.url === target.url());
  const ping = await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" }), Number(recoveredState.tabId));
  expect(ping).toEqual({ ok: true });
  expect((await messages(harness)).filter((message) => message.type === "NOTICE")).toEqual([]);
  await Promise.all([target.close(), harness.close()]);
});

test("tracks SPA navigation", async () => {
  const spa = await activate("spa.html");
  await spa.target.getByRole("button", { name: "Beta route" }).click();
  await waitForState(spa.harness, (state) => (state.page as RuntimeRecord)?.url === `${origin}/spa.html#beta` && state.status === "ready");
  await Promise.all([spa.target.close(), spa.harness.close()]);
});

test("captures paced updates from recycled virtual rows", async () => {
  const virtual = await activate("virtualized.html");
  const candidate = (virtual.state.candidates as RuntimeRecord[])[0];
  await send(virtual.harness, { type: "START_CAPTURE", candidateId: candidate.id, fields: candidate.fields });
  await waitForState(virtual.harness, (state) => state.status === "capturing");
  for (let index = 0; index < 3; index += 1) {
    await virtual.target.getByRole("button", { name: "Next" }).click();
    await expect.poll(async () => {
      const all = await messages(virtual.harness);
      const states = all.filter((message) => message.type === "STATE").map((message) => message.state as RuntimeRecord);
      return Number((states.at(-1)?.stats as RuntimeRecord)?.total ?? 0);
    }, { timeout: 5_000 }).toBeGreaterThanOrEqual((index + 2) * 10);
  }
  await Promise.all([virtual.target.close(), virtual.harness.close()]);
});

test("does not drop rapid intermediate states from recycled virtual rows", async () => {
  const virtual = await activate("virtualized.html");
  const candidate = (virtual.state.candidates as RuntimeRecord[])[0];
  await send(virtual.harness, { type: "START_CAPTURE", candidateId: candidate.id, fields: candidate.fields });
  await waitForState(virtual.harness, (state) => state.status === "capturing");
  for (let index = 0; index < 3; index += 1) await virtual.target.getByRole("button", { name: "Next" }).click();
  await expect.poll(async () => {
    const all = await messages(virtual.harness);
    const states = all.filter((message) => message.type === "STATE").map((message) => message.state as RuntimeRecord);
    return Number((states.at(-1)?.stats as RuntimeRecord)?.total ?? 0);
  }, { timeout: 3_000 }).toBeGreaterThanOrEqual(40);
  await Promise.all([virtual.target.close(), virtual.harness.close()]);
});

test("continues capture when an infinite feed appends a new page", async () => {
  const feed = await activate("infinite.html");
  const candidate = (feed.state.candidates as RuntimeRecord[])[0];
  await send(feed.harness, { type: "START_CAPTURE", candidateId: candidate.id, fields: candidate.fields });
  await waitForState(feed.harness, (state) => state.status === "capturing");
  await feed.target.evaluate(() => scrollTo(0, document.body.scrollHeight));
  await expect.poll(async () => {
    const all = await messages(feed.harness);
    const states = all.filter((message) => message.type === "STATE").map((message) => message.state as RuntimeRecord);
    return Number((states.at(-1)?.stats as RuntimeRecord)?.total ?? 0);
  }, { timeout: 10_000 }).toBeGreaterThanOrEqual(40);
  await Promise.all([feed.target.close(), feed.harness.close()]);
});

test("AI cleanup uses a dynamic Groq plan while preserving original records and capture state", async () => {
  const activated = await activate("products.html");
  const candidate = (activated.state.candidates as RuntimeRecord[])[0];
  const candidateFields = candidate.fields as RuntimeRecord[];
  await send(activated.harness, { type: "START_CAPTURE", candidateId: candidate.id, fields: candidateFields });
  await waitForState(activated.harness, (state) => state.status === "capturing");
  const originalMessage = await waitForMessage(activated.harness, "RECORDS");
  const originalRecords = originalMessage.records as RuntimeRecord[];
  expect(originalRecords.length).toBeGreaterThan(0);

  await send(activated.harness, { type: "AI_SAVE_KEY", key: TEST_KEY, persistent: false });
  await expect.poll(async () => {
    const statuses = (await messages(activated.harness)).filter((message) => message.type === "AI_STATUS").map((message) => message.status as RuntimeRecord);
    return statuses.some((status) => status.configured === true && status.testing === false);
  }).toBe(true);
  const sessionKeyState = await worker.evaluate(async () => ({
    session: await chrome.storage.session.get("groqApiKey"),
    local: await chrome.storage.local.get(["groqApiKey", "sessionMeta", "settings"])
  }));
  expect(sessionKeyState.session.groqApiKey).toBe(TEST_KEY);
  expect(sessionKeyState.local.groqApiKey).toBeUndefined();
  expect(JSON.stringify({ sessionMeta: sessionKeyState.local.sessionMeta, settings: sessionKeyState.local.settings })).not.toContain(TEST_KEY);
  expect(JSON.stringify(await messages(activated.harness))).not.toContain(TEST_KEY);
  await send(activated.harness, { type: "AI_CLEAN", instruction: "Keep useful product fields", fields: candidateFields });
  const resultMessage = await waitForMessage(activated.harness, "AI_CLEAN_RESULT");
  const result = resultMessage.result as RuntimeRecord;
  expect(result.originalCount).toBe(originalRecords.length);
  expect(Number(result.cleanedCount)).toBeGreaterThan(0);
  expect(((result.plan as RuntimeRecord).recordType)).toBe("QA products");

  await send(activated.harness, { type: "GET_RECORDS" });
  const latestOriginal = (await messages(activated.harness)).filter((message) => message.type === "RECORDS").at(-1)?.records as RuntimeRecord[];
  expect(latestOriginal).toEqual(originalRecords);
  const cachedPlans = await worker.evaluate(async () => (await chrome.storage.local.get("aiPlanCache")).aiPlanCache);
  const serializedCache = JSON.stringify(cachedPlans);
  expect(serializedCache).not.toContain(TEST_KEY);
  expect(serializedCache).not.toContain("Birch Desk");

  await activated.harness.evaluate(() => { (window as typeof window & { __qaMessages?: unknown[] }).__qaMessages = []; });
  await send(activated.harness, { type: "AI_CLEAN", instruction: "Keep useful product fields", fields: candidateFields });
  const cachedResult = (await waitForMessage(activated.harness, "AI_CLEAN_RESULT")).result as RuntimeRecord;
  expect(cachedResult.cacheHit).toBe(true);

  groqMode = "unauthorized";
  await send(activated.harness, { type: "AI_TEST" });
  await expect.poll(async () => (await messages(activated.harness)).filter((message) => message.type === "AI_STATUS").some((message) => /rejected the API key/i.test(String((message.status as RuntimeRecord).lastError ?? "")))).toBe(true);
  const latestState = await worker.evaluate(async () => (await chrome.storage.local.get("sessionMeta")).sessionMeta) as RuntimeRecord;
  expect(latestState.status).not.toBe("error");
  groqMode = "ok";
  await send(activated.harness, { type: "AI_SAVE_KEY", key: TEST_KEY, persistent: true });
  await expect.poll(async () => {
    const status = (await messages(activated.harness)).filter((message) => message.type === "AI_STATUS").at(-1)?.status as RuntimeRecord;
    return status?.persistent === true && status?.testing === false;
  }).toBe(true);
  const persistentKeyState = await worker.evaluate(async () => ({ session: await chrome.storage.session.get("groqApiKey"), local: await chrome.storage.local.get("groqApiKey") }));
  expect(persistentKeyState.session.groqApiKey).toBeUndefined();
  expect(persistentKeyState.local.groqApiKey).toBe(TEST_KEY);
  await send(activated.harness, { type: "AI_DELETE_KEY" });
  await expect.poll(async () => worker.evaluate(async () => {
    const [session, local] = await Promise.all([chrome.storage.session.get("groqApiKey"), chrome.storage.local.get(["groqApiKey", "aiPlanCache"])]);
    return !session.groqApiKey && !local.groqApiKey && !local.aiPlanCache;
  })).toBe(true);
  await Promise.all([activated.target.close(), activated.harness.close()]);
});

test("cancels a slow AI cleanup on SPA navigation without publishing stale results", async () => {
  const activated = await activate("spa.html");
  const candidate = (activated.state.candidates as RuntimeRecord[])[0];
  const candidateFields = candidate.fields as RuntimeRecord[];
  await send(activated.harness, { type: "START_CAPTURE", candidateId: candidate.id, fields: candidateFields });
  await waitForState(activated.harness, (state) => state.status === "capturing");
  const originalRecords = (await waitForMessage(activated.harness, "RECORDS")).records as RuntimeRecord[];
  expect(originalRecords.length).toBeGreaterThan(0);
  await send(activated.harness, { type: "STOP" });
  await waitForState(activated.harness, (state) => state.status === "stopped");

  await send(activated.harness, { type: "AI_SAVE_KEY", key: TEST_KEY, persistent: false });
  await expect.poll(async () => {
    const status = (await messages(activated.harness)).filter((message) => message.type === "AI_STATUS").at(-1)?.status as RuntimeRecord;
    return status?.configured === true && status?.testing === false;
  }).toBe(true);

  await activated.harness.evaluate(() => { (window as typeof window & { __qaMessages?: unknown[] }).__qaMessages = []; });
  groqMode = "slow";
  try {
    await send(activated.harness, { type: "AI_CLEAN", instruction: `Slow route cancellation ${Date.now()}`, fields: candidateFields });
    await expect.poll(async () => {
      const status = (await messages(activated.harness)).filter((message) => message.type === "AI_STATUS").at(-1)?.status as RuntimeRecord;
      return status?.cleaning;
    }).toBe(true);

    await activated.target.getByRole("button", { name: "Beta route" }).click();
    await waitForState(activated.harness, (state) => state.status === "ready" && (state.page as RuntimeRecord)?.url === `${origin}/spa.html#beta`);
    await expect.poll(async () => {
      const status = (await messages(activated.harness)).filter((message) => message.type === "AI_STATUS").at(-1)?.status as RuntimeRecord;
      return status?.cleaning;
    }).toBe(false);
    await activated.target.waitForTimeout(4_200);

    expect((await messages(activated.harness)).some((message) => message.type === "AI_CLEAN_RESULT")).toBe(false);
    await send(activated.harness, { type: "GET_RECORDS" });
    const latestOriginal = (await waitForMessage(activated.harness, "RECORDS")).records as RuntimeRecord[];
    expect(latestOriginal).toEqual(originalRecords);
  } finally {
    groqMode = "ok";
    await send(activated.harness, { type: "AI_DELETE_KEY" });
    await expect.poll(async () => worker.evaluate(async () => {
      const [session, local] = await Promise.all([chrome.storage.session.get("groqApiKey"), chrome.storage.local.get(["groqApiKey", "aiPlanCache"])]);
      return !session.groqApiKey && !local.groqApiKey && !local.aiPlanCache;
    })).toBe(true);
    await Promise.all([activated.target.close(), activated.harness.close()]);
  }
});

test("live Meta Ads Library semantic detection", async () => {
  test.skip(process.env.FLOW_SCRAPE_LIVE_META !== "1", "Run explicitly because this depends on Meta and network availability.");
  const target = await context.newPage();
  await target.goto("https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=IN&is_targeted_country=false&media_type=all&q=distributer&search_type=keyword_unordered", { waitUntil: "domcontentloaded", timeout: 20_000 });
  expect(new URL(target.url()).hostname).toMatch(/(^|\.)facebook\.com$/);
  await target.waitForFunction(() => document.body?.innerText.includes("Library ID") ?? false, undefined, { timeout: 20_000 });
  const harness = await openHarness();
  await target.bringToFront();
  await send(harness, { type: "PANEL_CONNECT" });
  try {
    await waitForState(harness, (candidate) => ["detecting", "ready"].includes(String(candidate.status)) && String((candidate.page as RuntimeRecord)?.hostname).endsWith("facebook.com"));
  } catch {
    throw new Error(`Meta activation messages: ${JSON.stringify(await messages(harness))}`);
  }
  await target.waitForTimeout(1_000);
  await harness.evaluate(() => { (window as typeof window & { __qaMessages?: unknown[] }).__qaMessages = []; });
  await send(harness, { type: "DETECT" });
  const recovered = await waitForState(harness, (candidate) => candidate.status === "ready" && String((candidate.page as RuntimeRecord)?.hostname).endsWith("facebook.com"));
  const candidates = recovered.candidates as RuntimeRecord[];
  expect(candidates.length).toBeGreaterThan(0);
  const inferredNames = candidates.flatMap((candidate) => (candidate.fields as RuntimeRecord[]).map((field) => String(field.name)));
  expect(inferredNames).toContain("Library ID");
  expect(inferredNames.some((name) => /Advertiser Name|Link Text/.test(name))).toBe(true);
  const ping = await worker.evaluate(async (tabId) => chrome.tabs.sendMessage(tabId, { type: "CONTENT_PING" }), Number(recovered.tabId));
  expect(ping).toEqual({ ok: true });
  expect((await messages(harness)).filter((message) => message.type === "NOTICE")).toEqual([]);
  await Promise.all([target.close(), harness.close()]);
});

test("never emits loader or receiving-end errors in covered activation paths", () => {
  expect(workerErrors.filter((message) => /Receiving end does not exist|Could not establish connection|bootstrap|dynamic import/i.test(message))).toEqual([]);
});
