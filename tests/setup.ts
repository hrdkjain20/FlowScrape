import "@testing-library/jest-dom/vitest";

if (typeof HTMLElement !== "undefined") {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40, toJSON() { return {}; } }; }
  });
}

class TestIntersectionObserver implements IntersectionObserver {
  readonly root = null; readonly rootMargin = "0px"; readonly thresholds = [0];
  constructor(private readonly callback: IntersectionObserverCallback) { void this.callback; }
  disconnect() {} observe() {} unobserve() {} takeRecords() { return []; }
}
globalThis.IntersectionObserver = TestIntersectionObserver;
globalThis.requestIdleCallback = ((callback: IdleRequestCallback) => setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0)) as unknown as typeof requestIdleCallback;
globalThis.cancelIdleCallback = ((id: number) => clearTimeout(id)) as typeof cancelIdleCallback;
