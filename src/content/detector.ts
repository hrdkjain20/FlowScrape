import type { CollectionCandidate } from "../shared/types";
import { cssEscape, hashString, normalizeWhitespace } from "../shared/utils";
import { deepElements, isVisible, safeQueryAll, uniqueSelector } from "./dom";
import { inferSchema } from "./schema";

const MAX_PAGE_ELEMENTS = 20_000;
const MAX_CHILD_SAMPLE = 360;
const MAX_CLUSTERS_PER_CONTAINER = 28;
const ignored = /^(nav|footer|header|aside)$/i;
const badContext = /cookie|consent|banner|toolbar|navigation|pagination|menu|social|share|breadcrumb/i;
const volatileClass = /active|selected|hover|focus|disabled|\d{3,}|css-|jsx-|sc-|^_[a-z\d]{5,}|^[a-f\d]{6,}$/i;

type Profile = {
  tag: string;
  role: string;
  directTags: string[];
  histogram: Map<string, number>;
  elementCount: number;
  textLength: number;
  links: number;
  images: number;
  media: number;
  semantic: number;
};

const profileCache = new WeakMap<Element, Profile>();

const profile = (element: Element): Profile => {
  const cached = profileCache.get(element);
  if (cached) return cached;
  const descendants = Array.from(element.querySelectorAll("*")).slice(0, 220);
  const histogram = new Map<string, number>();
  for (const child of descendants) {
    const tag = child.tagName.toLowerCase();
    histogram.set(tag, (histogram.get(tag) ?? 0) + 1);
  }
  const result: Profile = {
    tag: element.tagName.toLowerCase(), role: element.getAttribute("role") ?? "",
    directTags: Array.from(element.children).slice(0, 12).map((child) => child.tagName.toLowerCase()),
    histogram, elementCount: descendants.length, textLength: Math.min(1500, normalizeWhitespace(element.textContent ?? "").length),
    links: descendants.filter((child) => child.matches("a[href]")).length,
    images: descendants.filter((child) => child.matches("img,picture,svg[role=img]")).length,
    media: descendants.filter((child) => child.matches("video,audio,source")).length,
    semantic: descendants.filter((child) => child.matches("h1,h2,h3,h4,h5,h6,time,[itemprop],[data-label],[aria-label]")).length
  };
  profileCache.set(element, result);
  return result;
};

const ratioSimilarity = (left: number, right: number): number => {
  if (left === 0 && right === 0) return 1;
  return Math.min(left, right) / Math.max(left, right, 1);
};

const histogramSimilarity = (left: Map<string, number>, right: Map<string, number>): number => {
  const keys = new Set([...left.keys(), ...right.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    intersection += Math.min(left.get(key) ?? 0, right.get(key) ?? 0);
    union += Math.max(left.get(key) ?? 0, right.get(key) ?? 0);
  }
  return union ? intersection / union : 1;
};

const sequenceSimilarity = (left: string[], right: string[]): number => {
  const length = Math.max(left.length, right.length, 1);
  let matching = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) if (left[index] === right[index]) matching += 1;
  return matching / length;
};

export const structuralSimilarity = (left: Element, right: Element): number => {
  const a = profile(left);
  const b = profile(right);
  if (a.tag !== b.tag && !(left.matches("article,li,[role=listitem]") && right.matches("article,li,[role=listitem]"))) return 0;
  const role = a.role === b.role ? 1 : (!a.role || !b.role ? 0.55 : 0);
  return 0.16 + role * 0.07 + histogramSimilarity(a.histogram, b.histogram) * 0.27 + sequenceSimilarity(a.directTags, b.directTags) * 0.12
    + ratioSimilarity(a.elementCount, b.elementCount) * 0.1 + ratioSimilarity(a.textLength, b.textLength) * 0.1
    + ratioSimilarity(a.links, b.links) * 0.07 + ratioSimilarity(a.images, b.images) * 0.05
    + ratioSimilarity(a.media, b.media) * 0.025 + ratioSimilarity(a.semantic, b.semantic) * 0.025;
};

export const structuralSignature = (element: Element): string => {
  const data = profile(element);
  const classes = Array.from(element.classList).filter((name) => !volatileClass.test(name)).sort().slice(0, 3).join(".");
  return `${data.tag}|${data.role}|${classes}|${data.directTags.join(",")}`;
};

const clusterChildren = (children: Element[]): Element[][] => {
  const clusters: Element[][] = [];
  for (const child of children) {
    let best: Element[] | undefined;
    let bestScore = 0.54;
    for (const cluster of clusters.slice(0, MAX_CLUSTERS_PER_CONTAINER)) {
      const representative = cluster[Math.floor(cluster.length / 2)];
      const similarity = structuralSimilarity(child, representative);
      if (similarity > bestScore) { best = cluster; bestScore = similarity; }
    }
    if (best) best.push(child);
    else if (clusters.length < MAX_CLUSTERS_PER_CONTAINER) clusters.push([child]);
  }
  return clusters.filter((cluster) => cluster.length >= 3);
};

const scoreGroup = (items: Element[], container: Element): { score: number; explanation: string } => {
  const visible = items.filter(isVisible);
  const texts = visible.map((item) => normalizeWhitespace(item.textContent ?? ""));
  const averageText = texts.reduce((sum, text) => sum + Math.min(text.length, 700), 0) / Math.max(visible.length, 1);
  const linkRate = visible.filter((item) => item.querySelector("a[href]")).length / Math.max(visible.length, 1);
  const imageRate = visible.filter((item) => item.querySelector("img[src],picture,video")).length / Math.max(visible.length, 1);
  const semanticRate = visible.filter((item) => /(?:library\s+id|price|₹|\$|rating|email|phone|started\s+running|minimum\s+order)/i.test(item.textContent ?? "") || item.querySelector("[itemprop],[data-label],time,h1,h2,h3,h4")).length / Math.max(visible.length, 1);
  const similarities = visible.slice(1, 12).map((item) => structuralSimilarity(visible[0], item));
  const consistency = similarities.reduce((sum, value) => sum + value, 0) / Math.max(similarities.length, 1);
  const semanticContainer = container.matches("table,tbody,ul,ol,dl,[role=list],[role=table]") ? 14 : 0;
  const penalty = badContext.test(`${container.className} ${container.id} ${container.getAttribute("role")}`) || ignored.test(container.tagName) ? 55 : 0;
  const score = Math.max(0, Math.min(100, Math.round(Math.min(28, visible.length * 3.5) + Math.min(17, averageText / 18) + (linkRate + imageRate) * 8 + semanticRate * 13 + consistency * 16 + semanticContainer - penalty)));
  const traits = [`${visible.length} visible repeated items`, semanticContainer ? "semantic list/table markup" : "approximately matching record templates", linkRate > 0.5 ? "consistent links" : "", imageRate > 0.5 ? "consistent media" : "", semanticRate > 0.5 ? "repeated semantic values" : "", consistency > 0.72 ? "high structural similarity" : ""].filter(Boolean);
  return { score, explanation: `${traits.join(", ")}.` };
};

const tableCandidates = (elements: Element[]): Array<{ container: Element; items: Element[]; name: string }> => elements
  .filter((element) => element.matches("table") && isVisible(element)).map((table, index) => ({
    container: table, items: Array.from(table.querySelectorAll(":scope > tbody > tr, :scope > tr")).filter((row) => !row.matches(":scope > thead > tr")), name: `Table ${index + 1}`
  }));

const itemSelectorFor = (items: Element[]): string => {
  const tag = items[0].tagName.toLowerCase();
  const sharedClasses = Array.from(items[0].classList).filter((name) => !volatileClass.test(name) && items.every((item) => item.classList.contains(name))).slice(0, 2);
  if (sharedClasses.length) return `:scope > ${tag}${sharedClasses.map((name) => `.${cssEscape(name)}`).join("")}`;
  for (const attribute of ["role", "itemprop", "data-testid"]) {
    const value = items[0].getAttribute(attribute);
    if (value && value.length < 80 && items.every((item) => item.getAttribute(attribute) === value)) return `:scope > ${tag}[${attribute}="${value.replace(/"/g, '\\"')}"]`;
  }
  return `:scope > ${tag}`;
};

export const detectCollections = (): CollectionCandidate[] => {
  const elements = deepElements().slice(0, MAX_PAGE_ELEMENTS);
  const raw: Array<{ container: Element; items: Element[]; name?: string }> = [...tableCandidates(elements)];
  for (const container of elements) {
    if (container.children.length < 3 || !isVisible(container)) continue;
    const children = Array.from(container.children);
    const sampled = children.length <= MAX_CHILD_SAMPLE ? children : [...children.slice(0, MAX_CHILD_SAMPLE / 2), ...children.slice(-MAX_CHILD_SAMPLE / 2)];
    const visible = sampled.filter(isVisible);
    for (const items of clusterChildren(visible)) raw.push({ container, items });
  }
  const seen = new Set<string>();
  const candidates: CollectionCandidate[] = [];
  for (const group of raw) {
    const containerSelector = uniqueSelector(group.container);
    const itemSelector = itemSelectorFor(group.items);
    const key = `${containerSelector}|${itemSelector}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const scoring = scoreGroup(group.items, group.container);
    if (scoring.score < 27) continue;
    const fields = inferSchema(group.items);
    if (!fields.length) continue;
    const fullItemCount = safeQueryAll(group.container, itemSelector).length;
    candidates.push({ id: `candidate_${hashString(key)}`, name: group.name ?? `${fields[0]?.name ?? group.items[0].tagName.toLowerCase()} records`, itemSelector, containerSelector, itemCount: fullItemCount || group.items.length, score: scoring.score, explanation: scoring.explanation, fields });
  }
  return candidates.sort((a, b) => b.score - a.score || b.fields.length - a.fields.length || b.itemCount - a.itemCount).slice(0, 12);
};

export const candidateFromElement = (selected: Element): CollectionCandidate | null => {
  let item: Element | null = selected;
  while (item?.parentElement) {
    const siblings = Array.from(item.parentElement.children).filter((sibling) => isVisible(sibling) && structuralSimilarity(item!, sibling) >= 0.54);
    if (siblings.length >= 2) {
      const container = item.parentElement;
      const fields = inferSchema(siblings);
      const selector = uniqueSelector(container);
      const itemSelector = itemSelectorFor(siblings);
      const scoring = scoreGroup(siblings, container);
      return { id: `candidate_${hashString(`${selector}|${itemSelector}`)}`, name: `${fields[0]?.name ?? "Selected"} records`, itemSelector, containerSelector: selector, itemCount: siblings.length, score: Math.max(scoring.score, 60), explanation: `Selected item is semantically similar to ${siblings.length} sibling records.`, fields };
    }
    item = item.parentElement;
  }
  return null;
};
