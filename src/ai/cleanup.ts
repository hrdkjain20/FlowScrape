import type { AiCleanupPlan, AiPlanField, FieldDefinition, FieldType, FieldValue, ScrapedRecord } from "../shared/types";
import { hashString, normalizeWhitespace } from "../shared/utils";

export interface AiSourceProfile {
  id: string;
  name: string;
  type: FieldType;
  coverage: number;
  uniqueRatio: number;
  averageLength: number;
  samples: string[];
}

const MAX_FIELDS = 30;
const MAX_SAMPLE_LENGTH = 160;
const MAX_PROFILE_RECORDS = 2_000;
const safeOutputTypes = new Set<FieldType>(["text", "number", "price", "date", "url", "image", "email", "phone"]);
const operations = new Set(["copy", "first_nonempty", "concat", "regex"]);
const dangerousName = /^(?:__proto__|prototype|constructor)$/i;

const serialized = (value: FieldValue): string => value === null ? "" : Array.isArray(value) ? value.join(" | ") : String(value);

export const buildAiProfile = (fields: FieldDefinition[], records: ScrapedRecord[]): AiSourceProfile[] => {
  const sampledRecords = records.length <= MAX_PROFILE_RECORDS ? records : Array.from({ length: MAX_PROFILE_RECORDS }, (_, index) => records[Math.floor(index * (records.length - 1) / (MAX_PROFILE_RECORDS - 1))]);
  return fields
  .filter((field) => !field.hidden).slice(0, MAX_FIELDS).map((field) => {
    const values = sampledRecords.map((record) => serialized(record.values[field.id])).filter(Boolean);
    const distinct = Array.from(new Set(values));
    return {
      id: field.id,
      name: field.name.slice(0, 80),
      type: field.type,
      coverage: sampledRecords.length ? values.length / sampledRecords.length : 0,
      uniqueRatio: values.length ? distinct.length / values.length : 0,
      averageLength: values.length ? values.reduce((sum, value) => sum + value.length, 0) / values.length : 0,
      samples: distinct.slice(0, 3).map((value) => value.slice(0, MAX_SAMPLE_LENGTH))
    };
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const stringArray = (value: unknown, maximum: number): string[] | null => Array.isArray(value) && value.length <= maximum && value.every((entry) => typeof entry === "string") ? value : null;

export const safeAiPattern = (pattern: string): boolean => {
  if (!pattern || pattern.length > 160) return false;
  // Model patterns intentionally use a small subset: one capture group, no
  // alternation/lookaround/backreferences, no repeated groups, and no dot-star.
  // This rejects common catastrophic-backtracking families before RegExp runs.
  if (/\\[1-9]|\(\?|\||\.\*|\.\+|\)[+*{]/.test(pattern)) return false;
  let captures = 0;
  let quantifiers = 0;
  let stars = 0;
  let escaped = false;
  let inClass = false;
  for (const character of pattern) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "[") { inClass = true; continue; }
    if (character === "]") { inClass = false; continue; }
    if (character === "(" && !inClass) captures += 1;
    if (!inClass && (character === "+" || character === "*" || character === "?" || character === "{")) quantifiers += 1;
    if (!inClass && character === "*") stars += 1;
    if (!inClass && character === "?") return false;
  }
  if (captures !== 1 || quantifiers > 8 || stars > 1) return false;
  for (const match of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
    const minimum = Number(match[1]);
    const maximum = match[2] === undefined || match[2] === "" ? minimum : Number(match[2]);
    if (minimum < 1 || minimum > 200 || maximum > 200 || maximum < minimum) return false;
  }
  try { void new RegExp(pattern, "giu"); return true; } catch { return false; }
};

const sampledTokens = (profiles: AiSourceProfile[]): Set<string> => {
  const structural = new Set(profiles.flatMap((profile) => profile.name.toLocaleLowerCase().match(/[\p{L}\p{N}@._+-]{8,}/gu) ?? []));
  return new Set(profiles.flatMap((profile) => profile.samples.flatMap((sample) => sample.toLocaleLowerCase().match(/[\p{L}\p{N}@._+-]{8,}/gu) ?? []))
    .filter((token) => !structural.has(token)));
};

export const cacheSafeCleanupPlan = (plan: AiCleanupPlan, profiles: AiSourceProfile[]): AiCleanupPlan | null => {
  const sampleTokens = sampledTokens(profiles);
  const patternText = plan.fields.map((field) => field.pattern.toLocaleLowerCase().replace(/\\/g, "")).join(" ");
  if (Array.from(sampleTokens).some((token) => patternText.includes(token))) return null;
  const renamed = new Map<string, string>();
  const fields = plan.fields.map((field, index) => {
    const unsafeName = Array.from(sampleTokens).some((token) => field.name.toLocaleLowerCase().includes(token));
    const name = unsafeName ? `Field ${index + 1}` : field.name;
    renamed.set(field.name.toLocaleLowerCase(), name);
    return { ...field, name, reason: "Selected by a cached, validated AI cleanup plan." };
  });
  return {
    ...plan,
    recordType: "Cached records",
    fields,
    deduplicateBy: plan.deduplicateBy.map((name) => renamed.get(name.toLocaleLowerCase()) ?? name),
    summary: "Reused a validated cleanup plan for this page template."
  };
};

export const validateCleanupPlan = (value: unknown, profiles: AiSourceProfile[]): AiCleanupPlan => {
  if (!isRecord(value) || typeof value.recordType !== "string" || typeof value.summary !== "string" || !Array.isArray(value.fields)) throw new Error("AI returned an invalid cleanup plan.");
  if (!value.fields.length || value.fields.length > 30) throw new Error("AI returned an unsupported number of output fields.");
  const sourceIds = new Set(profiles.map((profile) => profile.id));
  const names = new Set<string>();
  const fields: AiPlanField[] = value.fields.map((raw) => {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.type !== "string" || typeof raw.operation !== "string" || typeof raw.pattern !== "string" || typeof raw.multiple !== "boolean" || typeof raw.reason !== "string" || typeof raw.confidence !== "number") throw new Error("AI returned a malformed field definition.");
    const name = normalizeWhitespace(raw.name).slice(0, 80);
    const sources = stringArray(raw.sources, 8);
    if (!name || dangerousName.test(name) || names.has(name.toLocaleLowerCase())) throw new Error("AI returned duplicate or unsafe output field names.");
    if (!sources?.length || sources.some((source) => !sourceIds.has(source))) throw new Error("AI referenced a field that was not supplied.");
    if (!safeOutputTypes.has(raw.type as FieldType) || !operations.has(raw.operation)) throw new Error("AI returned an unsupported cleanup operation.");
    if (raw.operation === "regex" && !safeAiPattern(raw.pattern)) throw new Error("AI returned an unsafe or invalid extraction pattern.");
    if (raw.operation !== "regex" && raw.pattern) throw new Error("AI returned an unexpected extraction pattern.");
    if (raw.confidence < 0 || raw.confidence > 1 || !Number.isFinite(raw.confidence)) throw new Error("AI returned an invalid confidence value.");
    names.add(name.toLocaleLowerCase());
    return { name, type: raw.type as FieldType, sources, operation: raw.operation as AiPlanField["operation"], pattern: raw.pattern, multiple: raw.multiple, reason: raw.reason.slice(0, 240), confidence: raw.confidence };
  });
  const droppedSources = stringArray(value.droppedSources, 40);
  const deduplicateBy = stringArray(value.deduplicateBy, 20);
  if (!droppedSources || droppedSources.some((source) => !sourceIds.has(source))) throw new Error("AI returned invalid dropped fields.");
  if (!deduplicateBy || deduplicateBy.some((name) => !names.has(normalizeWhitespace(name).toLocaleLowerCase()))) throw new Error("AI returned invalid deduplication fields.");
  return { recordType: normalizeWhitespace(value.recordType).slice(0, 80) || "records", fields, droppedSources: Array.from(new Set(droppedSources)), deduplicateBy, summary: normalizeWhitespace(value.summary).slice(0, 500) };
};

const parseNumber = (value: string): number | null => {
  const normalized = value.replace(/[^\d,.-]/g, "");
  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  const decimal = lastComma > lastDot ? "," : ".";
  const canonical = decimal === "," ? normalized.replace(/\./g, "").replace(",", ".") : normalized.replace(/,/g, "");
  const parsed = Number.parseFloat(canonical);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeCleanValue = (value: string | string[] | number | null, type: FieldType): FieldValue => {
  if (value === null || Array.isArray(value) || typeof value === "number") return value;
  const clean = normalizeWhitespace(value);
  if (!clean) return null;
  if (type === "number" || type === "price") return parseNumber(clean);
  if (type === "date") {
    const parsed = new Date(clean);
    return Number.isNaN(parsed.valueOf()) ? clean : parsed.toISOString();
  }
  return clean;
};

const applyField = (definition: AiPlanField, record: ScrapedRecord): FieldValue => {
  const sources = definition.sources.map((source) => serialized(record.values[source])).filter(Boolean);
  if (!sources.length) return null;
  if (definition.operation === "copy" || definition.operation === "first_nonempty") return normalizeCleanValue(sources[0], definition.type);
  const combined = sources.join(definition.operation === "concat" ? " | " : " \n ").slice(0, 2_000);
  if (definition.operation === "concat") return normalizeCleanValue(combined, definition.type);
  const expression = new RegExp(definition.pattern, `iu${definition.multiple ? "g" : ""}`);
  if (!definition.multiple) {
    const match = expression.exec(combined);
    return normalizeCleanValue(match?.[1] ?? match?.[0] ?? "", definition.type);
  }
  const matches = Array.from(combined.matchAll(expression), (match) => normalizeWhitespace(match[1] ?? match[0])).filter(Boolean);
  return Array.from(new Set(matches));
};

export const applyCleanupPlan = (plan: AiCleanupPlan, records: ScrapedRecord[]): { fields: FieldDefinition[]; records: ScrapedRecord[] } => {
  const fields: FieldDefinition[] = plan.fields.map((field, index) => ({
    id: `ai_${hashString(`${field.name}|${index}`)}`, name: field.name, selector: ":scope", type: field.type,
    multiple: field.multiple, required: false, explanation: field.reason, confidence: field.confidence
  }));
  const fieldIdByName = new Map(fields.map((field) => [field.name.toLocaleLowerCase(), field.id]));
  const dedupeIds = plan.deduplicateBy.map((name) => fieldIdByName.get(name.toLocaleLowerCase())).filter((id): id is string => Boolean(id));
  const seen = new Set<string>();
  const output: ScrapedRecord[] = [];
  for (const source of records) {
    const values: ScrapedRecord["values"] = {};
    plan.fields.forEach((definition, index) => { values[fields[index].id] = applyField(definition, source); });
    if (Object.values(values).every((value) => value === null || value === "" || (Array.isArray(value) && !value.length))) continue;
    const fingerprintSource = (dedupeIds.length ? dedupeIds : fields.map((field) => field.id)).map((id) => values[id]);
    const fingerprint = hashString(JSON.stringify(fingerprintSource));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    output.push({ ...source, values, originalValues: undefined, fingerprint });
  }
  return { fields, records: output };
};

export const evaluateCleanDataset = (fields: FieldDefinition[], records: ScrapedRecord[]): string[] => {
  if (!records.length) return ["The plan removed every record."];
  const issues: string[] = [];
  const valuesByField = new Map(fields.map((field) => [field.id, records.map((record) => serialized(record.values[field.id]))]));
  for (const field of fields) {
    const values = valuesByField.get(field.id) ?? [];
    const nonempty = values.filter(Boolean);
    if (nonempty.length / records.length < 0.05) issues.push(`${field.name} is empty in more than 95% of records.`);
    if (nonempty.length && nonempty.reduce((sum, value) => sum + value.length, 0) / nonempty.length > 1400) issues.push(`${field.name} is unusually verbose and may contain a whole record.`);
  }
  for (let left = 0; left < fields.length; left += 1) for (let right = left + 1; right < fields.length; right += 1) {
    const a = valuesByField.get(fields[left].id) ?? [];
    const b = valuesByField.get(fields[right].id) ?? [];
    let compared = 0; let duplicates = 0;
    for (let index = 0; index < records.length; index += 1) if (a[index] && b[index]) { compared += 1; if (a[index] === b[index]) duplicates += 1; }
    if (compared >= 2 && duplicates / compared > 0.9) issues.push(`${fields[left].name} and ${fields[right].name} contain duplicate values.`);
  }
  return issues.slice(0, 8);
};

export const aiPlanCacheKey = async (hostname: string, model: string, instruction: string, profiles: AiSourceProfile[]): Promise<string> => {
  const payload = new TextEncoder().encode(JSON.stringify({ hostname, model, instruction: normalizeWhitespace(instruction), profiles }));
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
