import type { RuntimeMessage, WorkerToContentMessage } from "../shared/protocol";
import type { PageInfo } from "../shared/types";
import { isRuntimeMessage } from "../shared/protocol";
import { CaptureController } from "./capture";
import { candidateFromElement, detectCollections } from "./detector";
import { detectLimitations, inaccessibleFrameCount } from "./dom";
import { SelectionOverlay } from "./overlay";

declare global {
  interface Window {
    __flowScrapeLoaded?: boolean;
    __flowScrapeCleanup?: () => void;
    __flowScrapeInstance?: string;
  }
}

// A previous content context can become orphaned when an unpacked extension is
// reloaded. Always tear it down and install a fresh receiver instead of trusting
// a boolean marker whose chrome.runtime connection may already be invalid.
try { window.__flowScrapeCleanup?.(); } catch { /* stale extension context */ }
{
  const instanceId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  window.__flowScrapeLoaded = true;
  window.__flowScrapeInstance = instanceId;
  let capture: CaptureController | undefined;
  const overlay = new SelectionOverlay();

  const pageInfo = (): PageInfo => ({
    url: location.href,
    title: document.title,
    hostname: location.hostname,
    inaccessibleFrames: inaccessibleFrameCount(),
    limitations: detectLimitations()
  });

  const send = (message: RuntimeMessage) => chrome.runtime.sendMessage(message).catch(() => undefined);
  send({ type: "CONTENT_READY", page: pageInfo() });

  chrome.runtime.onMessage.addListener((unknownMessage: unknown, _sender, sendResponse) => {
    if (!isRuntimeMessage(unknownMessage) || !unknownMessage.type.startsWith("CONTENT_")) return false;
      const message = unknownMessage as WorkerToContentMessage;
      try {
        switch (message.type) {
        case "CONTENT_PING": break;
        case "CONTENT_DETECT": {
          const run = () => send({ type: "DETECTION_RESULT", candidates: detectCollections(), page: pageInfo() });
          if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 700 }); else setTimeout(run, 0);
          break;
        }
        case "CONTENT_START":
          capture?.stop();
          capture = new CaptureController(message.maxRecords, (batch) => send({ type: "CAPTURE_BATCH", ...batch }));
          capture.start(message.candidate, message.fields);
          break;
        case "CONTENT_POINT_SELECT":
          overlay.startCollection((element) => {
            const candidate = candidateFromElement(element);
            if (candidate) send({ type: "POINT_SELECTED", candidate });
            else send({ type: "CONTENT_ERROR", error: "That element does not appear to belong to a repeated collection." });
          });
          break;
        case "CONTENT_FIELD_SELECT":
          overlay.startField(message.fieldId, message.candidate, (selector, suggestedType, attribute) => send({ type: "FIELD_SELECTED", fieldId: message.fieldId, selector, suggestedType, attribute }));
          break;
        case "CONTENT_CANCEL_SELECT": overlay.stop(); break;
        case "CONTENT_PAUSE": capture?.pause(); break;
        case "CONTENT_RESUME": capture?.resume(); break;
        case "CONTENT_STOP": capture?.stop(); overlay.stop(); break;
        case "CONTENT_UPDATE_FIELDS": capture?.updateFields(message.fields); break;
      }
      sendResponse({ ok: true });
    } catch (error) {
      send({ type: "CONTENT_ERROR", error: error instanceof Error ? error.message : "Unexpected extraction failure." });
      sendResponse({ ok: false });
    }
    return true;
  });

  let knownUrl = location.href;
  const navigationCheck = setInterval(() => {
    if (location.href === knownUrl) return;
    knownUrl = location.href;
    capture?.stop();
    send({ type: "DETECTION_RESULT", candidates: detectCollections(), page: pageInfo() });
  }, 500);

  const cleanup = () => {
    clearInterval(navigationCheck);
    capture?.stop();
    overlay.stop();
    removeEventListener("pagehide", cleanup);
    if (window.__flowScrapeInstance === instanceId) {
      window.__flowScrapeLoaded = false;
      window.__flowScrapeCleanup = undefined;
      window.__flowScrapeInstance = undefined;
    }
  };
  window.__flowScrapeCleanup = cleanup;
  addEventListener("pagehide", cleanup, { once: true });
}
