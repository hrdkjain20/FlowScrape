import type { FieldDefinition, FieldType } from "../shared/types";
import { cssEscape, hashString, normalizeWhitespace } from "../shared/utils";
import { isVisible, relativeSelector, safeQueryAll } from "./dom";

const MAX_SCHEMA_ITEMS = 16;
const MAX_ELEMENTS_PER_ITEM = 260;
const MAX_FIELDS = 30;
const excluded = "input,textarea,select,option,button,script,style,template,noscript,[hidden],[aria-hidden=true],[contenteditable=true]";
const genericNames = new Set(["item", "row", "card", "content", "wrapper", "container", "inner", "outer", "root", "main", "data", "body", "text"]);
const volatileClass = /active|selected|hover|focus|disabled|\d{3,}|css-|jsx-|sc-|^_[a-z\d]{5,}|^[a-f\d]{6,}$/i;

type NameInference = { name: string; explanation: string; confidence: number };
type Prototype = NameInference & { selector: string; fallbacks: string[]; type: FieldType; attribute?: string; multiple: boolean; score: number };

const titleCase = (value: string): string => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
const attributeSelector = (name: string, value: string): string => `[${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
const directText = (element: Element): string => normalizeWhitespace(Array.from(element.childNodes).filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent ?? "").join(" "));

export const inferType = (element: Element, sample = normalizeWhitespace(element.textContent ?? "")): FieldType => {
  const tag = element.tagName.toLowerCase();
  const lower = `${sample} ${element.getAttribute("class") ?? ""} ${element.getAttribute("itemprop") ?? ""} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
  if (tag === "img" || element.hasAttribute("srcset") || tag === "video" || tag === "source") return "image";
  if (tag === "a" && element.hasAttribute("href")) return "url";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sample)) return "email";
  if (/^\+?[\d\s().-]{7,}$/.test(sample) && /\d/.test(sample)) return "phone";
  if (/price|cost|amount|mrp|rate|[$€£¥₹]\s?\d|\d\s?(usd|eur|gbp|inr)\b/i.test(lower)) return "price";
  if (tag === "time" || /date|time|published|started running|joined/.test(lower)) return "date";
  if (/^[+-]?[\d,.]+$/.test(sample)) return "number";
  return "text";
};

const linkRole = (element: HTMLAnchorElement): { text: string; url: string } => {
  const href = element.href || element.getAttribute("href") || "";
  const label = normalizeWhitespace(element.textContent ?? element.getAttribute("aria-label") ?? "");
  if (/^mailto:/i.test(href)) return { text: "Email", url: "Email URL" };
  if (/^tel:/i.test(href)) return { text: "Phone", url: "Phone URL" };
  let target: URL | null = null;
  try { target = new URL(href, document.baseURI); } catch { /* malformed page URL */ }
  const path = target?.pathname.toLowerCase() ?? "";
  const host = target?.hostname.replace(/^www\./, "") ?? "";
  const currentHost = location.hostname.replace(/^www\./, "");
  if (currentHost.endsWith("facebook.com") && host.endsWith("facebook.com") && !path.includes("/ads/library")) return { text: "Advertiser Name", url: "Advertiser URL" };
  if (/product|item|listing|catalog|detail|offer/.test(path)) return { text: "Product Name", url: "Product URL" };
  if (target && host && host !== currentHost && !host.endsWith(`.${currentHost}`)) return { text: "Destination", url: "Destination URL" };
  if (element.closest("h1,h2,h3,h4,h5,h6")) return { text: "Title", url: "Title URL" };
  return { text: label.length > 1 && label.length < 80 ? "Link Text" : "Link", url: "URL" };
};

const meaningfulName = (element: Element, index: number): NameInference => {
  const text = normalizeWhitespace(element.textContent ?? "");
  const labelled = text.match(/^([\p{L}][\p{L}\p{N} &/_-]{1,38})\s*[:：]\s*(.+)$/u);
  if (labelled && labelled[2].length <= 240) return { name: titleCase(labelled[1]), explanation: "Named from a repeated label/value pair.", confidence: 0.96 };
  const phrase = [[/^started running on\b/i, "Started Running"], [/^library id\b/i, "Library ID"], [/^sponsored\b/i, "Sponsorship"], [/minimum order|\bmoq\b/i, "Minimum Order"], [/rating/i, "Rating"], [/reviews?/i, "Reviews"], [/location|address/i, "Location"]] as Array<[RegExp, string]>;
  const recognized = phrase.find(([expression]) => expression.test(text));
  if (recognized) return { name: recognized[1], explanation: "Named from recognized page language.", confidence: 0.92 };
  const sources: Array<[string | null, string, number]> = [[element.getAttribute("aria-label"), "aria-label", 0.95], [element.getAttribute("itemprop"), "itemprop", 0.94], [element.getAttribute("data-label"), "data-label", 0.92], [element.getAttribute("title"), "title", 0.78]];
  if (element.matches("h1,h2,h3,h4,h5,h6")) sources.unshift(["Title", "heading semantics", 0.94]);
  for (const [raw, source, confidence] of sources) if (raw && normalizeWhitespace(raw).length <= 60) return { name: titleCase(raw), explanation: `Named from ${source}.`, confidence };
  const className = Array.from(element.classList).find((name) => name.length > 2 && !genericNames.has(name.toLowerCase()) && !volatileClass.test(name));
  if (className) return { name: titleCase(className), explanation: "Named from a stable, meaningful class.", confidence: 0.72 };
  if (element.matches("img")) return { name: "Image", explanation: "Inferred from image semantics.", confidence: 0.9 };
  if (element.matches("video,source")) return { name: "Media", explanation: "Inferred from media semantics.", confidence: 0.88 };
  if (text.length >= 90) return { name: "Description", explanation: "Inferred from a consistently long text block.", confidence: 0.7 };
  return { name: `Field ${index + 1}`, explanation: "Inferred from its stable position across records.", confidence: 0.48 };
};

const structuralPath = (element: Element, item: Element): string => {
  if (element === item) return ":scope";
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== item && parts.length < 8) {
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    const sameTag = Array.from(parent.children).filter((child) => child.tagName === current?.tagName);
    const position = sameTag.length > 1 ? `:nth-of-type(${sameTag.indexOf(current) + 1})` : "";
    parts.unshift(`${current.tagName.toLowerCase()}${position}`);
    current = parent;
  }
  return current === item ? `:scope > ${parts.join(" > ")}` : relativeSelector(element, item);
};

const locatorCandidates = (element: Element, item: Element): string[] => {
  const locators: string[] = [];
  for (const name of ["itemprop", "data-label", "aria-label", "role"]) {
    const value = element.getAttribute(name);
    if (value && value.length <= 80 && !/\d{5,}/.test(value)) locators.push(`${element.tagName.toLowerCase()}${attributeSelector(name, value)}`);
  }
  const stableClasses = Array.from(element.classList).filter((name) => name.length > 2 && !volatileClass.test(name)).slice(0, 2);
  if (stableClasses.length) locators.push(`${element.tagName.toLowerCase()}${stableClasses.map((name) => `.${cssEscape(name)}`).join("")}`);
  locators.push(structuralPath(element, item), relativeSelector(element, item));
  return locators.filter((selector, index, all) => selector && all.indexOf(selector) === index);
};

const fieldElements = (item: Element): Element[] => {
  if (item.matches("tr")) return Array.from(item.querySelectorAll(":scope > th, :scope > td"));
  return safeQueryAll(item, "*").slice(0, MAX_ELEMENTS_PER_ITEM).filter((element) => {
    if (element.matches(excluded) || !isVisible(element)) return false;
    if (element.matches("a[href],img[src],video[src],source[src],time,[itemprop],[data-label],[aria-label]")) return true;
    const text = directText(element);
    return text.length >= 2 && text.length <= 700;
  });
};

const expandedTableHeaders = (table: HTMLTableElement | null): string[] => {
  if (!table) return [];
  const labels: string[][] = [];
  const blockedUntil: number[] = [];
  Array.from(table.querySelectorAll(":scope > thead > tr")).forEach((row, rowIndex) => {
    let column = 0;
    for (const cell of Array.from(row.children).filter((element) => element.matches("th,td"))) {
      while ((blockedUntil[column] ?? 0) > rowIndex) column += 1;
      const colspan = Math.max(1, Number.parseInt(cell.getAttribute("colspan") ?? "1", 10));
      const rowspan = Math.max(1, Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10));
      const label = normalizeWhitespace(cell.textContent ?? "");
      for (let offset = 0; offset < colspan; offset += 1) {
        const target = column + offset;
        labels[target] ??= [];
        if (label && labels[target].at(-1) !== label) labels[target].push(label);
        if (rowspan > 1) blockedUntil[target] = rowIndex + rowspan;
      }
      column += colspan;
    }
  });
  return labels.map((parts) => parts.join(" "));
};

const textOf = (element: Element, type: FieldType): string => {
  if (type === "url") return (element as HTMLAnchorElement).href || element.getAttribute("href") || "";
  if (type === "image") return (element as HTMLImageElement).currentSrc || element.getAttribute("src") || element.getAttribute("srcset") || "";
  if (type === "attribute") return element.getAttribute("alt") ?? "";
  return normalizeWhitespace(element.textContent ?? "");
};

const coverageFor = (items: Element[], selectors: string[], type: FieldType): { coverage: number; uniqueness: number; variation: number } => {
  const values: string[] = [];
  let matched = 0;
  let unique = 0;
  for (const item of items) {
    let matches: Element[] = [];
    for (const selector of selectors) {
      matches = safeQueryAll(item, selector).filter((element) => textOf(element, type).length > 0);
      if (matches.length) break;
    }
    if (!matches.length) continue;
    matched += 1;
    if (matches.length === 1) unique += 1;
    values.push(matches.map((element) => textOf(element, type)).join("|"));
  }
  return { coverage: matched / Math.max(items.length, 1), uniqueness: unique / Math.max(matched, 1), variation: new Set(values).size / Math.max(values.length, 1) };
};

const prototypes = (items: Element[]): Prototype[] => {
  const output: Prototype[] = [];
  items.slice(0, 8).forEach((item) => fieldElements(item).forEach((element, index) => {
    const locators = locatorCandidates(element, item);
    if (!locators.length) return;
    const inferred = meaningfulName(element, index);
    const variants: Array<{ name: string; type: FieldType; attribute?: string; confidence?: number }> = [];
    if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
      const role = linkRole(element);
      if (normalizeWhitespace(element.textContent ?? "").length > 1) variants.push({ name: role.text, type: "text", confidence: 0.84 });
      variants.push({ name: role.url, type: "url", attribute: "href", confidence: 0.9 });
    } else if (element.matches("img")) {
      variants.push({ name: inferred.name, type: "image", attribute: "src" });
      if (element.getAttribute("alt")) variants.push({ name: "Image Alt", type: "attribute", attribute: "alt", confidence: 0.82 });
    } else if (element.matches("video,source")) variants.push({ name: "Media URL", type: "image", attribute: "src", confidence: 0.88 });
    else variants.push({ name: inferred.name, type: inferType(element) });
    for (const variant of variants) {
      const metrics = coverageFor(items, locators, variant.type);
      if (metrics.coverage < Math.min(0.34, 2 / Math.max(items.length, 1))) continue;
      output.push({ ...inferred, name: variant.name, confidence: variant.confidence ?? inferred.confidence, selector: locators[0], fallbacks: locators.slice(1), type: variant.type, attribute: variant.attribute, multiple: metrics.uniqueness < 0.7, score: metrics.coverage * 55 + metrics.uniqueness * 12 + Math.min(metrics.variation, 0.5) * 12 + (variant.confidence ?? inferred.confidence) * 21 });
    }
  }));
  return output;
};

const semanticPatterns: Array<{ name: string; type: FieldType; pattern: string; multiple?: boolean; confidence: number }> = [
  { name: "Library ID", type: "text", pattern: "Library\\s+ID\\s*[:#]?\\s*([A-Za-z0-9_-]+)", confidence: 0.99 },
  { name: "Started Running", type: "date", pattern: "Started\\s+running\\s+on\\s+([A-Za-z]+\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})", confidence: 0.98 },
  { name: "Email", type: "email", pattern: "([A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})", multiple: true, confidence: 0.98 },
  { name: "Phone", type: "phone", pattern: "((?:\\+\\d{1,3}[ -]?)?(?:\\(?\\d{2,4}\\)?[ .-]){2,4}\\d{3,4})", multiple: true, confidence: 0.88 },
  { name: "Price", type: "price", pattern: "((?:₹|Rs\\.?|INR|\\$|€|£)\\s*[\\d,.]+)", confidence: 0.95 },
  { name: "Minimum Order", type: "text", pattern: "(?:Minimum\\s+Order(?:\\s+Quantity)?|MOQ)\\s*[:：]?\\s*([^|•\\n]{1,80})", confidence: 0.93 },
  { name: "Rating", type: "number", pattern: "(?:Rating\\s*[:：]?\\s*)?([0-5](?:\\.\\d)?)\\s*(?:/\\s*5|stars?)", confidence: 0.9 },
  { name: "Reviews", type: "number", pattern: "([\\d,]+)\\s+(?:customer\\s+)?reviews?", confidence: 0.9 }
];

const patternFields = (items: Element[]): FieldDefinition[] => semanticPatterns.flatMap((definition) => {
  let matches = 0;
  for (const item of items) try { if (new RegExp(definition.pattern, "i").test(item.textContent ?? "")) matches += 1; } catch { return []; }
  const coverage = matches / Math.max(items.length, 1);
  if (matches < Math.min(2, items.length) || coverage < 0.25) return [];
  return [{ id: `field_semantic_${hashString(definition.name)}`, name: definition.name, selector: ":scope", type: definition.type, pattern: definition.pattern, patternFlags: "i", multiple: definition.multiple ?? false, required: false, explanation: "Recognized semantically across multiple records.", confidence: Math.min(definition.confidence, 0.72 + coverage * 0.28) }];
});

const tableSchema = (items: Element[]): FieldDefinition[] => {
  const first = items[0];
  if (!first) return [];
  const headers = expandedTableHeaders(first.closest("table"));
  return fieldElements(first).map((element, index) => {
    const inferred = meaningfulName(element, index);
    const name = headers[index] || inferred.name;
    return { id: `field_${index}_${name.toLowerCase().replace(/\W+/g, "_")}`, name, selector: structuralPath(element, first), type: inferType(element), multiple: false, required: index === 0, explanation: headers[index] ? "Named from the table header." : inferred.explanation, confidence: headers[index] ? 0.98 : inferred.confidence };
  });
};

export const inferSchema = (allItems: Element[]): FieldDefinition[] => {
  const items = allItems.filter(isVisible).slice(0, MAX_SCHEMA_ITEMS);
  const first = items[0];
  if (!first) return [];
  if (first.matches("tr")) return tableSchema(items);
  const grouped = new Map<string, Prototype[]>();
  for (const prototype of prototypes(items)) {
    const generic = /^Field \d+$/.test(prototype.name);
    const key = `${generic ? prototype.selector.replace(/:nth-of-type\(\d+\)/g, ":nth-of-type(*)") : prototype.name}|${prototype.type}|${prototype.attribute ?? ""}`;
    const group = grouped.get(key) ?? [];
    group.push(prototype);
    grouped.set(key, group);
  }
  const chosen = Array.from(grouped.values()).map((group) => {
    group.sort((a, b) => b.score - a.score);
    const best = group[0];
    const selectors = group.flatMap((entry) => [entry.selector, ...entry.fallbacks]).filter((selector, index, all) => all.indexOf(selector) === index).slice(0, 6);
    return { ...best, selector: selectors[0], fallbacks: selectors.slice(1) };
  }).sort((a, b) => b.score - a.score);
  const usedNames = new Map<string, number>();
  const inferred: FieldDefinition[] = [];
  for (const candidate of chosen) {
    if (inferred.length >= MAX_FIELDS) break;
    const duplicate = usedNames.get(candidate.name) ?? 0;
    usedNames.set(candidate.name, duplicate + 1);
    const name = duplicate ? `${candidate.name} ${duplicate + 1}` : candidate.name;
    inferred.push({ id: `field_${hashString(`${name}|${candidate.type}|${candidate.selector}`)}`, name, selector: candidate.selector, selectors: candidate.fallbacks.length ? candidate.fallbacks : undefined, type: candidate.type, attribute: candidate.attribute, multiple: candidate.multiple, required: inferred.length === 0, explanation: `${candidate.explanation} Verified against ${items.length} sample records.`, confidence: Math.min(0.99, candidate.confidence) });
  }
  const semantic = patternFields(items).filter((field) => !inferred.some((existing) => existing.name === field.name));
  return [...semantic, ...inferred].slice(0, MAX_FIELDS);
};
