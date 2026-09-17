import { cssEscape } from "../shared/utils";

export const isVisible = (element: Element): boolean => {
  const html = element as HTMLElement;
  const style = (element.ownerDocument.defaultView ?? window).getComputedStyle(html);
  const rect = html.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 1 && rect.height > 1;
};

export const deepElements = (root: Document | ShadowRoot | Element = document): Element[] => {
  const output: Element[] = [];
  const visit = (scope: Document | ShadowRoot | Element) => {
    for (const element of Array.from(scope.querySelectorAll("*"))) {
      output.push(element);
      if (element.shadowRoot) visit(element.shadowRoot);
      if (element instanceof HTMLIFrameElement) {
        try { if (element.contentDocument) visit(element.contentDocument); } catch { /* cross-origin frame */ }
      }
    }
  };
  visit(root);
  return output;
};

export const safeQueryAll = (root: ParentNode, selector: string): Element[] => {
  try {
    const frameParts = selector.split(" >>>FRAME>>> ");
    let scope: ParentNode = root;
    for (let index = 0; index < frameParts.length; index += 1) {
      const shadowParts = frameParts[index].split(" >>> ");
      let matches: Element[] = [];
      for (let shadowIndex = 0; shadowIndex < shadowParts.length; shadowIndex += 1) {
        matches = Array.from(scope.querySelectorAll(shadowParts[shadowIndex]));
        if (shadowIndex < shadowParts.length - 1) {
          const host = matches[0];
          if (!host?.shadowRoot) return [];
          scope = host.shadowRoot;
        }
      }
      if (index < frameParts.length - 1) {
        const frame = matches[0];
        if (!(frame instanceof HTMLIFrameElement) || !frame.contentDocument) return [];
        scope = frame.contentDocument;
      } else return matches;
    }
    return [];
  } catch { return []; }
};

const qualifySelector = (element: Element, local: string, stopAt?: Element): string => {
  if (stopAt) {
    const root = element.getRootNode();
    if (root instanceof ShadowRoot && root.host !== stopAt && stopAt.contains(root.host)) return `${uniqueSelector(root.host, stopAt)} >>> ${local}`;
    return local;
  }
  const root = element.getRootNode();
  if (root instanceof ShadowRoot) return `${uniqueSelector(root.host)} >>> ${local}`;
  if (root instanceof Document) {
    try {
      const frame = root.defaultView?.frameElement;
      if (frame) return `${uniqueSelector(frame)} >>>FRAME>>> ${local}`;
    } catch { /* top document or inaccessible owner */ }
  }
  return local;
};

export const uniqueSelector = (element: Element, stopAt?: Element): string => {
  if (element.id) return `#${cssEscape(element.id)}`;
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== stopAt && current !== document.documentElement) {
    let part = current.tagName.toLowerCase();
    const stableClasses = Array.from(current.classList)
      .filter((name) => !/^(active|selected|hover|focus|css-|sc-|jsx-|[a-f\d]{6,})/i.test(name))
      .slice(0, 2);
    if (stableClasses.length) part += stableClasses.map((name) => `.${cssEscape(name)}`).join("");
    const parentElement: Element | null = current.parentElement;
    if (parentElement) {
      const siblings = Array.from(parentElement.children) as Element[];
      const matches = siblings.filter((child: Element) => child.matches(part));
      if (matches.length > 1) part += `:nth-of-type(${siblings.filter((child: Element) => child.tagName === current?.tagName).indexOf(current) + 1})`;
    }
    parts.unshift(part);
    const selector = parts.join(" > ");
    try {
      const scope = stopAt ?? document;
      if (scope.querySelectorAll(selector).length === 1) return qualifySelector(element, selector, stopAt);
    } catch { /* continue with a more specific path */ }
    current = parentElement;
  }
  const local = parts.join(" > ");
  return qualifySelector(element, local, stopAt);
};

export const relativeSelector = (element: Element, item: Element): string => {
  if (element === item) return ":scope";
  const full = uniqueSelector(element, item);
  return full || element.tagName.toLowerCase();
};

export const detectLimitations = (): string[] => {
  const limitations: string[] = [];
  if (document.contentType === "application/pdf") limitations.push("PDF content cannot be inspected as a webpage DOM.");
  if (document.querySelector("canvas") && document.body.innerText.trim().length < 50) limitations.push("This page appears canvas-based; pixels cannot be converted into structured DOM data.");
  const closedHints = deepElements().filter((element) => element.tagName.includes("-") && !element.shadowRoot && element.childElementCount === 0);
  if (closedHints.length) limitations.push("Some web components may use closed shadow roots and cannot be inspected.");
  return limitations;
};

export const inaccessibleFrameCount = (): number => {
  let count = 0;
  for (const frame of Array.from(document.querySelectorAll("iframe"))) {
    try { void frame.contentDocument?.body; } catch { count += 1; }
    if (!frame.contentDocument) count += 1;
  }
  return count;
};
