import type { FieldDefinition, FieldValue, ScrapedRecord } from "../shared/types";
import { hashString, makeId, normalizeWhitespace } from "../shared/utils";
import { safeQueryAll } from "./dom";

const parseNumber = (raw: string): number | null => {
  const normalized = raw.replace(/[^\d,.-]/g, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  const decimal = lastComma > lastDot ? "," : ".";
  const canonical = decimal === "," ? normalized.replace(/\./g, "").replace(",", ".") : normalized.replace(/,/g, "");
  const value = Number.parseFloat(canonical);
  return Number.isFinite(value) ? value : null;
};

const rawValue = (element: Element, field: FieldDefinition): string => {
  if (element.matches("input,textarea,select,option,[contenteditable=true],[hidden],[aria-hidden=true]")) return "";
  if (field.type === "attribute" && /^(value|formaction)$/i.test(field.attribute ?? "")) return "";
  if (field.type === "attribute" && /token|secret|password|auth|cookie|nonce|payment|card/i.test(field.attribute ?? "")) return "";
  if (field.type === "html") {
    const clone = element.cloneNode(true) as Element;
    for (const unsafe of Array.from(clone.querySelectorAll("script,style,template,input,textarea,select,option,[hidden],[aria-hidden=true],[contenteditable=true]"))) unsafe.remove();
    for (const node of [clone, ...Array.from(clone.querySelectorAll("*"))]) {
      for (const attribute of Array.from(node.attributes)) if (/^on/i.test(attribute.name) || /token|secret|password|auth|cookie|nonce|payment|card/i.test(attribute.name)) node.removeAttribute(attribute.name);
    }
    return clone.innerHTML;
  }
  if (field.type === "url") return (element as HTMLAnchorElement).href || element.getAttribute(field.attribute ?? "href") || "";
  if (field.type === "image") return (element as HTMLImageElement).currentSrc || (element as HTMLImageElement).src || element.getAttribute(field.attribute ?? "src") || "";
  if (field.type === "attribute") return element.getAttribute(field.attribute ?? "") ?? "";
  return element.textContent ?? "";
};

const patternValues = (raw: string, field: FieldDefinition): string[] => {
  if (!field.pattern) return [raw];
  try {
    const flags = `${field.patternFlags ?? "i"}${field.multiple && !(field.patternFlags ?? "").includes("g") ? "g" : ""}`;
    const expression = new RegExp(field.pattern, Array.from(new Set(flags)).join(""));
    if (!field.multiple) {
      const match = expression.exec(raw);
      return [match?.[1] ?? match?.[0] ?? ""];
    }
    return Array.from(raw.matchAll(expression), (match) => match[1] ?? match[0]);
  } catch {
    return [raw];
  }
};

const locateElements = (item: Element, field: FieldDefinition): Element[] => {
  const selectors = [field.selector, ...(field.selectors ?? [])].filter((selector, index, all) => selector && all.indexOf(selector) === index);
  for (const selector of selectors) {
    const matches = selector === ":scope" ? [item] : safeQueryAll(item, selector);
    if (matches.length) return matches;
  }
  return [];
};

const normalizeValue = (raw: string, field: FieldDefinition): FieldValue => {
  const text = normalizeWhitespace(raw);
  if (!text) return null;
  if (field.type === "number" || field.type === "price") return parseNumber(text);
  if (field.type === "url" || field.type === "image") {
    try { return new URL(text, document.baseURI).href; } catch { return text; }
  }
  if (field.type === "date") {
    const date = new Date(text);
    return Number.isNaN(date.valueOf()) ? text : date.toISOString();
  }
  return text;
};

export const extractRecord = (item: Element, fields: FieldDefinition[], batchId: string): ScrapedRecord => {
  const values: ScrapedRecord["values"] = {};
  const originalValues: NonNullable<ScrapedRecord["originalValues"]> = {};
  for (const field of fields) {
    const elements = locateElements(item, field);
    const raw = elements.flatMap((element) => patternValues(rawValue(element, field), field));
    originalValues[field.id] = field.multiple ? raw : raw[0] ?? null;
    values[field.id] = field.multiple
      ? raw.map((value) => normalizeValue(value, field)).filter((value): value is string => typeof value === "string")
      : normalizeValue(raw[0] ?? "", field);
  }
  const stableAttributes = ["data-id", "data-key", "itemid", "id"].map((name) => item.getAttribute(name)).filter(Boolean);
  const fingerprint = hashString(JSON.stringify(values) + stableAttributes.join("|"));
  return {
    id: makeId("record"), values, originalValues, sourceUrl: location.href,
    capturedAt: new Date().toISOString(), batchId, fingerprint
  };
};

export const isIncomplete = (record: ScrapedRecord, fields: FieldDefinition[]): boolean =>
  fields.some((field) => field.required && (record.values[field.id] === null || record.values[field.id] === ""));
