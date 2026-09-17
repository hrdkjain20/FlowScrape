import contentScript from "../content/bootstrap.ts?script";
import { aiPlanCacheKey, applyCleanupPlan, buildAiProfile, cacheSafeCleanupPlan, evaluateCleanDataset, validateCleanupPlan } from "../ai/cleanup";
import { GroqApiError, requestGroqPlan, testGroqKey, validGroqKey } from "../ai/groq";
import { sessionRepository } from "../db/repository";
import type { ContentToWorkerMessage, PanelToWorkerMessage, WorkerToContentMessage, WorkerToPanelMessage } from "../shared/protocol";
import { isRuntimeMessage } from "../shared/protocol";
import type { AiCleanupPlan, AiStatus, PageInfo, SessionState, Settings } from "../shared/types";
import { DEFAULT_SETTINGS, isRestrictedUrl, isSensitiveSite } from "../shared/types";
import { makeId } from "../shared/utils";

const ports = new Set<chrome.runtime.Port>();
let activeSession: SessionState | null = null;
let settings: Settings = DEFAULT_SETTINGS;
let lastBatchIds: string[] = [];
const activationTasks = new Map<number, Promise<void>>();
const GROQ_ORIGIN = "https://api.groq.com/*";
const AI_KEY = "groqApiKey";
const AI_CACHE = "aiPlanCache";
let aiStatus: AiStatus = { configured: false, persistent: false, testing: false, cleaning: false, model: DEFAULT_SETTINGS.aiModel };
let aiAbort: AbortController | null = null;
let aiRequestId = 0;

// Keep the action event as the single activation gate so Chrome grants activeTab
// before injection. The panel is opened explicitly from that user gesture.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

const broadcast = (message: WorkerToPanelMessage) => {
  for (const port of ports) { try { port.postMessage(message); } catch { ports.delete(port); } }
};

const persist = async () => {
  if (!activeSession) return;
  activeSession.updatedAt = new Date().toISOString();
  await Promise.all([
    sessionRepository.saveSession(activeSession),
    chrome.storage.local.set({ activeSessionId: activeSession.id, sessionMeta: activeSession })
  ]);
};

const loadState = async () => {
  const [stored, sessionSecret] = await Promise.all([
    chrome.storage.local.get(["activeSessionId", "sessionMeta", "settings", AI_KEY]),
    chrome.storage.session.get(AI_KEY)
  ]);
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings> | undefined) };
  aiStatus = { ...aiStatus, configured: Boolean(sessionSecret[AI_KEY] || stored[AI_KEY]), persistent: Boolean(stored[AI_KEY]), model: settings.aiModel };
  if (stored.activeSessionId) {
    const recovered = await sessionRepository.getSession(String(stored.activeSessionId)) ?? (stored.sessionMeta as SessionState | undefined) ?? null;
    if (recovered?.page.url) activeSession = recovered;
    else await chrome.storage.local.remove(["activeSessionId", "sessionMeta"]);
  }
};
const stateReady = loadState();

const broadcastAiStatus = () => broadcast({ type: "AI_STATUS", status: { ...aiStatus } });

const groqPermissionGranted = async () => chrome.permissions.contains({ origins: [GROQ_ORIGIN] });

const getGroqKey = async (): Promise<string> => {
  const [sessionSecret, localSecret] = await Promise.all([chrome.storage.session.get(AI_KEY), chrome.storage.local.get(AI_KEY)]);
  const key = String(sessionSecret[AI_KEY] ?? localSecret[AI_KEY] ?? "");
  if (!validGroqKey(key)) throw new Error("Add a valid Groq API key in FlowScrape Settings first.");
  return key;
};

const abortableDelay = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

const withGroqRetry = async <T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> => {
  try { return await operation(); }
  catch (error) {
    if (!(error instanceof GroqApiError) || !error.retryable || signal.aborted) throw error;
    await abortableDelay(error.retryAfterMs || 350, signal);
    return operation();
  }
};

const beginAiRequest = (timeoutMs: number) => {
  aiAbort?.abort(new Error("Superseded by a newer AI request."));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Groq did not respond before the timeout.")), timeoutMs);
  aiAbort = controller;
  return { controller, finish: () => { clearTimeout(timeout); if (aiAbort === controller) aiAbort = null; } };
};

const cancelAiCleanupForContextChange = (reason: string) => {
  if (!aiStatus.cleaning) return;
  aiRequestId += 1;
  aiAbort?.abort(new Error(reason));
  aiAbort = null;
  aiStatus = { ...aiStatus, cleaning: false, lastError: undefined };
  broadcastAiStatus();
};

type CachedPlan = { plan: AiCleanupPlan; createdAt: number };
const readCachedPlan = async (key: string): Promise<AiCleanupPlan | null> => {
  if (!settings.aiCachePlans) return null;
  const stored = await chrome.storage.local.get(AI_CACHE);
  const cache = (stored[AI_CACHE] ?? {}) as Record<string, CachedPlan>;
  const entry = cache[key];
  return entry && Date.now() - entry.createdAt < 30 * 24 * 60 * 60 * 1000 ? entry.plan : null;
};

const saveCachedPlan = async (key: string, plan: AiCleanupPlan) => {
  if (!settings.aiCachePlans) return;
  const stored = await chrome.storage.local.get(AI_CACHE);
  const cache = (stored[AI_CACHE] ?? {}) as Record<string, CachedPlan>;
  cache[key] = { plan, createdAt: Date.now() };
  const trimmed = Object.fromEntries(Object.entries(cache).sort((a, b) => b[1].createdAt - a[1].createdAt).slice(0, 30));
  await chrome.storage.local.set({ [AI_CACHE]: trimmed });
};

const activeTab = async (): Promise<chrome.tabs.Tab | undefined> => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];

const pageFromTab = (tab: chrome.tabs.Tab): PageInfo => {
  const url = tab.url ?? "";
  let hostname = "";
  try { hostname = new URL(url).hostname; } catch { /* non-web URL */ }
  return { url, title: tab.title ?? "Untitled page", hostname, inaccessibleFrames: 0, limitations: [] };
};

const newSession = (tab: chrome.tabs.Tab): SessionState => {
  const now = new Date().toISOString();
  const page = pageFromTab(tab);
  return {
    id: makeId("session"), tabId: tab.id ?? -1, status: "idle", page, candidates: [], fields: [],
    stats: { total: 0, duplicates: 0, incomplete: 0, batches: 0 }, createdAt: now, updatedAt: now,
    warning: isSensitiveSite(page.hostname) ? "This may be a sensitive site. Review every selected field and never collect credentials or private form data." : undefined
  };
};

const ensureContent = async (tab: chrome.tabs.Tab): Promise<boolean> => {
  if (!tab.id || !tab.url || isRestrictedUrl(tab.url) || !/^https?:|^file:/.test(tab.url)) throw new Error("Chrome does not allow extensions to inspect this page.");
  if (settings.blockedDomains.some((domain) => pageFromTab(tab).hostname === domain || pageFromTab(tab).hostname.endsWith(`.${domain}`))) throw new Error("This domain is on your FlowScrape blocklist.");
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "CONTENT_PING" } satisfies WorkerToContentMessage);
    return false;
  }
  catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [contentScript] });
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "CONTENT_PING" } satisfies WorkerToContentMessage);
        return true;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`FlowScrape was injected but did not become ready: ${lastError instanceof Error ? lastError.message : "content script unavailable"}`);
  }
};

const initializeForTab = async (tab: chrome.tabs.Tab, detect = true) => {
  if (!tab.id) throw new Error("No active webpage is available.");
  if (!activeSession || activeSession.tabId !== tab.id || activeSession.page.url !== tab.url) {
    cancelAiCleanupForContextChange("AI cleanup cancelled because the active page changed.");
    activeSession = newSession(tab);
    lastBatchIds = [];
  }
  const injected = await ensureContent(tab);
  const shouldDetect = detect || injected || activeSession.status === "error" || (!activeSession.candidates.length && activeSession.status !== "capturing");
  if (shouldDetect) {
    activeSession.status = "detecting";
    activeSession.error = undefined;
    await persist();
    await chrome.tabs.sendMessage(tab.id, { type: "CONTENT_DETECT" } satisfies WorkerToContentMessage);
  }
  broadcast({ type: "STATE", state: activeSession });
};

const activateTab = async (tab: chrome.tabs.Tab, detect = true): Promise<void> => {
  await stateReady;
  if (!tab.id) throw new Error("No active webpage is available.");
  const existing = activationTasks.get(tab.id);
  if (existing) return existing;
  const task = initializeForTab(tab, detect).finally(() => activationTasks.delete(tab.id!));
  activationTasks.set(tab.id, task);
  return task;
};

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  void chrome.storage.local.get("settings").then(({ settings: saved }) => { if (!saved) return chrome.storage.local.set({ settings: DEFAULT_SETTINGS }); });
});

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) void chrome.sidePanel.open({ tabId: tab.id }).catch((error) => broadcast({ type: "NOTICE", message: error instanceof Error ? error.message : "Could not open the FlowScrape side panel." }));
  void activateTab(tab).catch(async (error) => {
    const text = error instanceof Error ? error.message : "Unable to activate FlowScrape.";
    const session = activeSession;
    if (session && session.tabId === tab.id) { session.status = "error"; session.error = text; await persist(); }
    broadcast({ type: "NOTICE", message: text });
    broadcast({ type: "STATE", state: activeSession });
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "flowscrape-panel") return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  void stateReady.then(() => {
    try {
      port.postMessage({ type: "STATE", state: activeSession } satisfies WorkerToPanelMessage);
      port.postMessage({ type: "SETTINGS", settings } satisfies WorkerToPanelMessage);
      port.postMessage({ type: "AI_STATUS", status: aiStatus } satisfies WorkerToPanelMessage);
    } catch { ports.delete(port); }
  });
  port.onMessage.addListener((message: unknown) => { if (isRuntimeMessage(message)) void handlePanelMessage(message as PanelToWorkerMessage); });
});

const sendContent = async (message: WorkerToContentMessage) => {
  if (!activeSession) throw new Error("No active scraping session.");
  try {
    await chrome.tabs.sendMessage(activeSession.tabId, message);
  } catch {
    const tab = await chrome.tabs.get(activeSession.tabId);
    if (!tab.url) throw new Error("FlowScrape no longer has access to this tab. Click the toolbar icon on the webpage to reconnect.");
    try {
      await ensureContent(tab);
      await chrome.tabs.sendMessage(activeSession.tabId, message);
    } catch (error) {
      throw new Error(`Could not reconnect to the webpage. Refresh it, then click the FlowScrape toolbar icon again. ${error instanceof Error ? error.message : ""}`.trim());
    }
  }
};

const handleAiPanelMessage = async (message: PanelToWorkerMessage): Promise<boolean> => {
  if (!message.type.startsWith("AI_")) return false;
  if (message.type === "AI_CANCEL") {
    aiRequestId += 1;
    aiAbort?.abort(new Error("AI cleanup cancelled."));
    aiAbort = null;
    aiStatus = { ...aiStatus, testing: false, cleaning: false, lastError: undefined };
    broadcastAiStatus();
    broadcast({ type: "NOTICE", message: "AI cleanup cancelled. Original records were not changed." });
    return true;
  }
  if (message.type === "AI_DELETE_KEY") {
    aiRequestId += 1;
    aiAbort?.abort(new Error("Groq key deleted."));
    aiAbort = null;
    await Promise.all([chrome.storage.session.remove(AI_KEY), chrome.storage.local.remove([AI_KEY, AI_CACHE])]);
    aiStatus = { ...aiStatus, configured: false, persistent: false, testing: false, cleaning: false, lastError: undefined };
    broadcastAiStatus();
    broadcast({ type: "NOTICE", message: "Groq API key and cached cleanup plans deleted." });
    return true;
  }
  if (!await groqPermissionGranted()) throw new Error("Allow access to api.groq.com from FlowScrape Settings first.");
  if (message.type === "AI_SAVE_KEY") {
    const key = message.key.trim();
    if (!validGroqKey(key)) throw new Error("Groq keys begin with gsk_. Paste a complete key from console.groq.com.");
    if (message.persistent) {
      await Promise.all([chrome.storage.local.set({ [AI_KEY]: key }), chrome.storage.session.remove(AI_KEY)]);
    } else {
      await Promise.all([chrome.storage.session.set({ [AI_KEY]: key }), chrome.storage.local.remove(AI_KEY)]);
    }
    aiStatus = { ...aiStatus, configured: true, persistent: message.persistent, testing: true, lastError: undefined };
    broadcastAiStatus();
    const request = beginAiRequest(12_000);
    try {
      await withGroqRetry(() => testGroqKey(key, request.controller.signal), request.controller.signal);
      broadcast({ type: "NOTICE", message: `Groq connected. The key is stored ${message.persistent ? "locally on this browser profile" : "for this browser session only"}.` });
    } finally {
      request.finish();
      aiStatus = { ...aiStatus, testing: false };
      broadcastAiStatus();
    }
    return true;
  }
  if (message.type === "AI_TEST") {
    const key = await getGroqKey();
    aiStatus = { ...aiStatus, testing: true, lastError: undefined };
    broadcastAiStatus();
    const request = beginAiRequest(12_000);
    try {
      await withGroqRetry(() => testGroqKey(key, request.controller.signal), request.controller.signal);
      broadcast({ type: "NOTICE", message: "Groq connection succeeded." });
    } finally {
      request.finish();
      aiStatus = { ...aiStatus, testing: false };
      broadcastAiStatus();
    }
    return true;
  }
  if (message.type === "AI_CLEAN") {
    if (!activeSession) throw new Error("Capture records before running AI cleanup.");
    const instruction = message.instruction.trim();
    if (instruction.length > 1_000) throw new Error("AI instructions must be 1,000 characters or fewer.");
    const records = await sessionRepository.getRecords(activeSession.id);
    if (!records.length) throw new Error("Capture at least one record before running AI cleanup.");
    const profiles = buildAiProfile(message.fields, records);
    if (!profiles.length) throw new Error("No visible fields are available for AI cleanup.");
    const key = await getGroqKey();
    const cacheKey = await aiPlanCacheKey(activeSession.page.hostname, settings.aiModel, instruction, profiles);
    const cached = await readCachedPlan(cacheKey);
    const requestId = ++aiRequestId;
    const sessionId = activeSession.id;
    aiStatus = { ...aiStatus, cleaning: true, model: settings.aiModel, lastError: undefined };
    broadcastAiStatus();
    const request = beginAiRequest(35_000);
    try {
      let cacheHit = false;
      let plan: AiCleanupPlan;
      if (cached) {
        try { plan = validateCleanupPlan(cached, profiles); cacheHit = true; }
        catch { plan = validateCleanupPlan(await withGroqRetry(() => requestGroqPlan({ key, model: settings.aiModel, profiles, instruction, signal: request.controller.signal }), request.controller.signal), profiles); }
      } else {
        plan = validateCleanupPlan(await withGroqRetry(() => requestGroqPlan({ key, model: settings.aiModel, profiles, instruction, signal: request.controller.signal }), request.controller.signal), profiles);
      }
      let cleaned = applyCleanupPlan(plan, records);
      const qualityIssues = evaluateCleanDataset(cleaned.fields, cleaned.records);
      if (!cached && qualityIssues.length) {
        try {
          const corrected = validateCleanupPlan(await withGroqRetry(() => requestGroqPlan({ key, model: settings.aiModel, profiles, instruction, previousPlan: plan, critique: qualityIssues, signal: request.controller.signal }), request.controller.signal), profiles);
          const correctedDataset = applyCleanupPlan(corrected, records);
          if (correctedDataset.records.length && evaluateCleanDataset(correctedDataset.fields, correctedDataset.records).length <= qualityIssues.length) {
            plan = corrected;
            cleaned = correctedDataset;
          }
        } catch (error) {
          if (request.controller.signal.aborted) throw error;
          cacheHit = false;
        }
      }
      if (requestId !== aiRequestId || activeSession?.id !== sessionId) return true;
      const latestRecords = await sessionRepository.getRecords(sessionId);
      if (latestRecords.length !== records.length) {
        broadcast({ type: "NOTICE", message: "New records arrived during AI cleanup. Run cleanup again so the preview includes them." });
        return true;
      }
      const cacheSafePlan = cacheSafeCleanupPlan(plan, profiles);
      if (cacheSafePlan) await saveCachedPlan(cacheKey, cacheSafePlan);
      broadcast({ type: "AI_CLEAN_RESULT", result: { ...cleaned, plan, originalCount: records.length, cleanedCount: cleaned.records.length, cacheHit } });
      broadcast({ type: "NOTICE", message: `AI prepared ${cleaned.records.length.toLocaleString()} clean records from ${records.length.toLocaleString()}. Review before exporting.` });
    } catch (error) {
      if (request.controller.signal.aborted && requestId !== aiRequestId) return true;
      throw error;
    } finally {
      request.finish();
      if (requestId === aiRequestId) {
        aiStatus = { ...aiStatus, cleaning: false };
        broadcastAiStatus();
      }
    }
    return true;
  }
  return true;
};

const handlePanelMessage = async (message: PanelToWorkerMessage) => {
  try {
    await stateReady;
    if (message.type === "PANEL_CONNECT") {
      const tab = await activeTab();
      if (!tab?.url) {
        broadcast({ type: "STATE", state: activeSession });
        broadcast({ type: "NOTICE", message: "Click the FlowScrape toolbar icon while viewing an HTTP(S) page to grant access and start detection." });
        return;
      }
      await activateTab(tab, !activeSession || activeSession.tabId !== tab.id);
      broadcast({ type: "STATE", state: activeSession });
      return;
    }
    if (await handleAiPanelMessage(message)) return;
    if (!activeSession) throw new Error("Open FlowScrape from a webpage first.");
    switch (message.type) {
      case "DETECT": activeSession.status = "detecting"; await sendContent({ type: "CONTENT_STOP" }); await sendContent({ type: "CONTENT_DETECT" }); break;
      case "START_CAPTURE": {
        const candidate = activeSession.candidates.find((item) => item.id === message.candidateId);
        if (!candidate) throw new Error("The selected collection is no longer available.");
        activeSession.selectedCandidateId = candidate.id;
        activeSession.fields = message.fields;
        activeSession.status = "capturing";
        await sendContent({ type: "CONTENT_START", candidate, fields: message.fields, maxRecords: settings.maxRecords });
        break;
      }
      case "START_POINT_SELECT": activeSession.status = "selecting"; await sendContent({ type: "CONTENT_POINT_SELECT" }); break;
      case "START_FIELD_SELECT": {
        const candidate = activeSession.candidates.find((item) => item.id === message.candidateId);
        if (!candidate) throw new Error("Select a collection before picking a field.");
        activeSession.fields = message.fields;
        activeSession.status = "selecting";
        await sendContent({ type: "CONTENT_FIELD_SELECT", fieldId: message.fieldId, candidate });
        break;
      }
      case "CANCEL_SELECT": activeSession.status = "ready"; await sendContent({ type: "CONTENT_CANCEL_SELECT" }); break;
      case "PAUSE": activeSession.status = "paused"; await sendContent({ type: "CONTENT_PAUSE" }); break;
      case "RESUME": activeSession.status = "capturing"; await sendContent({ type: "CONTENT_RESUME" }); break;
      case "STOP": activeSession.status = "stopped"; await sendContent({ type: "CONTENT_STOP" }); break;
      case "UPDATE_FIELDS": activeSession.fields = message.fields; await sendContent({ type: "CONTENT_UPDATE_FIELDS", fields: message.fields }); break;
      case "UNDO": {
        const existing = await sessionRepository.getRecords(activeSession.id);
        const batchId = lastBatchIds.pop() ?? existing.at(-1)?.batchId;
        if (batchId) {
          const before = existing.length;
          await sessionRepository.removeBatch(activeSession.id, batchId);
          const after = (await sessionRepository.getRecords(activeSession.id)).length;
          activeSession.stats.total = after;
          activeSession.stats.batches = Math.max(0, activeSession.stats.batches - 1);
          broadcast({ type: "NOTICE", message: `Removed ${before - after} records from the last batch.` });
        }
        break;
      }
      case "CLEAR": {
        cancelAiCleanupForContextChange("AI cleanup cancelled because the session was cleared.");
        await sendContent({ type: "CONTENT_STOP" }).catch(() => undefined);
        await sessionRepository.clear(activeSession.id);
        const tab = await chrome.tabs.get(activeSession.tabId);
        activeSession = newSession(tab);
        lastBatchIds = [];
        break;
      }
      case "GET_RECORDS": broadcast({ type: "RECORDS", records: await sessionRepository.getRecords(activeSession.id) }); return;
      case "SETTINGS_UPDATE": settings = { ...DEFAULT_SETTINGS, ...message.settings }; aiStatus = { ...aiStatus, model: settings.aiModel }; await chrome.storage.local.set({ settings }); broadcast({ type: "SETTINGS", settings }); broadcastAiStatus(); break;
    }
    await persist();
    broadcast({ type: "STATE", state: activeSession });
  } catch (error) {
    const text = error instanceof Error ? error.message : "The requested action failed.";
    const aiRequest = message.type.startsWith("AI_");
    if (aiRequest && /cancelled|superseded|key deleted/i.test(text)) {
      aiStatus = { ...aiStatus, testing: false, cleaning: false, lastError: undefined };
      broadcastAiStatus();
      return;
    }
    if (aiRequest) {
      aiStatus = { ...aiStatus, testing: false, cleaning: false, lastError: text };
      broadcastAiStatus();
    } else if (activeSession) { activeSession.status = "error"; activeSession.error = text; await persist(); }
    broadcast({ type: "NOTICE", message: text });
    if (!aiRequest) broadcast({ type: "STATE", state: activeSession });
  }
};

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!isRuntimeMessage(message) || !sender.tab?.id) return;
  void handleContentMessage(message as ContentToWorkerMessage, sender.tab.id);
});

const handleContentMessage = async (message: ContentToWorkerMessage, tabId: number) => {
  if (!activeSession || activeSession.tabId !== tabId) return;
  if ((message.type === "CONTENT_READY" || message.type === "DETECTION_RESULT") && message.page.url !== activeSession.page.url) {
    cancelAiCleanupForContextChange("AI cleanup cancelled because the webpage navigated.");
  }
  switch (message.type) {
    case "CONTENT_READY": activeSession.page = message.page; break;
    case "DETECTION_RESULT":
      activeSession.page = message.page;
      activeSession.candidates = message.candidates;
      activeSession.selectedCandidateId = undefined;
      activeSession.fields = [];
      activeSession.status = "ready";
      activeSession.error = undefined;
      break;
    case "CAPTURE_BATCH":
      if (message.records.length) {
        await sessionRepository.addRecords(activeSession.id, message.records);
        const batchId = message.records[0].batchId;
        if (lastBatchIds.at(-1) !== batchId) lastBatchIds.push(batchId);
        activeSession.stats.total += message.records.length;
        activeSession.stats.batches += 1;
      }
      activeSession.stats.duplicates += message.duplicateCount;
      activeSession.stats.incomplete += message.incompleteCount;
      break;
    case "POINT_SELECTED":
      activeSession.candidates = [message.candidate, ...activeSession.candidates.filter((item) => item.id !== message.candidate.id)];
      activeSession.status = "ready";
      break;
    case "FIELD_SELECTED":
      activeSession.fields = activeSession.fields.map((field) => field.id === message.fieldId ? { ...field, selector: message.selector, selectors: undefined, pattern: undefined, patternFlags: undefined, type: message.suggestedType, attribute: message.attribute } : field);
      activeSession.status = activeSession.selectedCandidateId ? "capturing" : "ready";
      break;
    case "CONTENT_ERROR": activeSession.status = "error"; activeSession.error = message.error; break;
  }
  await persist();
  broadcast({ type: "STATE", state: activeSession });
  if (message.type === "CAPTURE_BATCH") broadcast({ type: "RECORDS", records: await sessionRepository.getRecords(activeSession.id) });
};

chrome.tabs.onRemoved.addListener((tabId) => { if (activeSession?.tabId === tabId) { cancelAiCleanupForContextChange("AI cleanup cancelled because the tab closed."); activeSession.status = "stopped"; void persist(); broadcast({ type: "STATE", state: activeSession }); } });
