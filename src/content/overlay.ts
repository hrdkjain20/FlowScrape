import type { FieldType } from "../shared/types";
import type { CollectionCandidate } from "../shared/types";
import { relativeSelector, safeQueryAll } from "./dom";
import { inferType } from "./schema";

export class SelectionOverlay {
  private host?: HTMLElement;
  private box?: HTMLElement;
  private mode?: "collection" | "field";
  private fieldId?: string;

  startCollection(onSelect: (element: Element) => void) { this.start("collection", undefined, (element) => onSelect(element)); }
  startField(fieldId: string, candidate: CollectionCandidate, onSelect: (selector: string, type: FieldType, attribute?: string) => void) {
    this.start("field", fieldId, (element) => {
      const type = inferType(element);
      const container = safeQueryAll(document, candidate.containerSelector)[0];
      const item = container ? safeQueryAll(container, candidate.itemSelector).find((possible) => possible === element || possible.contains(element)) : undefined;
      onSelect(item ? relativeSelector(element, item) : ":scope", type, type === "url" ? "href" : type === "image" ? "src" : undefined);
    });
  }

  private start(mode: "collection" | "field", fieldId: string | undefined, onSelect: (element: Element) => void) {
    this.stop();
    this.mode = mode;
    this.fieldId = fieldId;
    this.host = document.createElement("div");
    this.host.dataset.flowscrapeOverlay = "true";
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `:host{all:initial}.box{position:fixed;pointer-events:none;border:2px solid #6d5dfc;background:#6d5dfc22;z-index:2147483000;border-radius:4px;transition:all 40ms}.tip{position:absolute;left:0;top:-30px;background:#17152b;color:white;padding:5px 8px;border-radius:4px;font:12px system-ui;white-space:nowrap}`;
    this.box = document.createElement("div");
    this.box.className = "box";
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.textContent = mode === "collection" ? "Click an item in the repeated collection · Esc to cancel" : "Click the value for this field · Esc to cancel";
    this.box.append(tip);
    shadow.append(style, this.box);
    document.documentElement.append(this.host);
    const move = (event: MouseEvent) => {
      const target = event.composedPath().find((node): node is Element => node instanceof Element && node !== this.host);
      if (!target || !this.box) return;
      const rect = target.getBoundingClientRect();
      Object.assign(this.box.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const click = (event: MouseEvent) => {
      const target = event.composedPath().find((node): node is Element => node instanceof Element && node !== this.host);
      if (!target) return;
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.stop(); onSelect(target);
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") this.stop(); };
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    this.cleanup = () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
    };
  }

  private cleanup: () => void = () => undefined;
  stop() { this.cleanup(); this.cleanup = () => undefined; this.host?.remove(); this.host = undefined; this.box = undefined; this.mode = undefined; this.fieldId = undefined; }
}
