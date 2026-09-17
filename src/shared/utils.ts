export const makeId = (prefix = "id"): string =>
  `${prefix}_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;

export const normalizeWhitespace = (value: string): string =>
  value.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();

export const hashString = (input: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const cssEscape = (value: string): string =>
  typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");

export const debounce = <Args extends unknown[]>(fn: (...args: Args) => void, delay: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: Args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
};

export const safeFilename = (hostname: string, extension: string, now = new Date()): string => {
  const host = hostname.replace(/[^a-z0-9.-]+/gi, "_").slice(0, 80) || "page";
  return `flowscrape_${host}_${now.toISOString().replace(/[:.]/g, "-")}.${extension}`;
};

export const requestIdle = (callback: () => void): number => {
  if ("requestIdleCallback" in globalThis) {
    return globalThis.requestIdleCallback(callback, { timeout: 250 });
  }
  return globalThis.setTimeout(callback, 16) as unknown as number;
};
