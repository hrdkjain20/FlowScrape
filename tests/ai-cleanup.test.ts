import { describe, expect, it } from "vitest";
import { aiPlanCacheKey, applyCleanupPlan, buildAiProfile, cacheSafeCleanupPlan, evaluateCleanDataset, safeAiPattern, validateCleanupPlan } from "../src/ai/cleanup";
import type { AiCleanupPlan, FieldDefinition, ScrapedRecord } from "../src/shared/types";

const fields: FieldDefinition[] = [
  { id: "advertiser", name: "Advertiser Name", selector: ".name", type: "text", multiple: false, required: false },
  { id: "description", name: "Description 2", selector: ".description", type: "text", multiple: false, required: false },
  { id: "noisy", name: "Library ID", selector: ".card", type: "text", multiple: false, required: false }
];

const record = (id: string, library: string, advertiser = "Nice Ply"): ScrapedRecord => ({
  id, values: { advertiser, description: "Become our distributor. Call +91 99999 11111", noisy: `Active | Library ID: ${library} | Sponsored | Become our distributor. Call +91 99999 11111` },
  sourceUrl: "https://facebook.test/ads", capturedAt: "2026-08-26T00:00:00.000Z", batchId: "batch", fingerprint: id
});

const dynamicPlan: AiCleanupPlan = {
  recordType: "Advertisements",
  fields: [
    { name: "Advertiser", type: "text", sources: ["advertiser"], operation: "copy", pattern: "", multiple: false, reason: "Entity name", confidence: 0.98 },
    { name: "Library ID", type: "text", sources: ["noisy"], operation: "regex", pattern: "Library\\s+ID:\\s*(\\d+)", multiple: false, reason: "Stable identifier", confidence: 0.99 },
    { name: "Ad Text", type: "text", sources: ["description"], operation: "copy", pattern: "", multiple: false, reason: "Useful content", confidence: 0.95 }
  ],
  droppedSources: ["noisy"], deduplicateBy: ["Library ID"], summary: "Removed duplicate card text."
};

describe("AI cleanup planning", () => {
  it("profiles only bounded samples instead of transmitting complete datasets", () => {
    const profiles = buildAiProfile(fields, [record("1", "100"), record("2", "200")]);
    expect(profiles).toHaveLength(3);
    expect(profiles.every((profile) => profile.samples.length <= 3 && profile.samples.every((sample) => sample.length <= 160))).toBe(true);
    expect(profiles.find((profile) => profile.id === "noisy")?.coverage).toBe(1);
  });

  it("validates a dynamic plan, extracts compound values, deduplicates, and leaves originals untouched", () => {
    const originals = [record("1", "100"), record("2", "100"), record("3", "200", "Other")];
    const snapshot = structuredClone(originals);
    const plan = validateCleanupPlan(dynamicPlan, buildAiProfile(fields, originals));
    const cleaned = applyCleanupPlan(plan, originals);
    expect(cleaned.records).toHaveLength(2);
    const libraryField = cleaned.fields.find((field) => field.name === "Library ID")!;
    expect(cleaned.records.map((entry) => entry.values[libraryField.id])).toEqual(["100", "200"]);
    expect(originals).toEqual(snapshot);
  });

  it("rejects hallucinated sources, dangerous names, and unsafe regex", () => {
    const profiles = buildAiProfile(fields, [record("1", "100")]);
    expect(() => validateCleanupPlan({ ...dynamicPlan, fields: [{ ...dynamicPlan.fields[0], sources: ["invented"] }] }, profiles)).toThrow(/not supplied/);
    expect(() => validateCleanupPlan({ ...dynamicPlan, fields: [{ ...dynamicPlan.fields[0], name: "constructor" }] }, profiles)).toThrow(/unsafe/);
    expect(safeAiPattern("(a+)+$")).toBe(false);
    expect(safeAiPattern("(a|aa)+$")).toBe(false);
    expect(safeAiPattern("(?:a{1,3})+$")).toBe(false);
    expect(safeAiPattern("(a?a?a?a?a?a?a?a?a?a?)")).toBe(false);
    expect(safeAiPattern("(a*a*a*)")).toBe(false);
    expect(safeAiPattern("(a{0,10})")).toBe(false);
    expect(safeAiPattern("Library\\s+ID:\\s*(\\d+)")).toBe(true);
    expect(() => validateCleanupPlan({ ...dynamicPlan, fields: [{ ...dynamicPlan.fields[1], pattern: "(a+)+$" }] }, profiles)).toThrow(/unsafe/);
  });

  it("detects duplicate output columns for a bounded correction pass", () => {
    const duplicatePlan: AiCleanupPlan = { ...dynamicPlan, fields: [dynamicPlan.fields[0], { ...dynamicPlan.fields[0], name: "Advertiser Copy" }], deduplicateBy: [] };
    const cleaned = applyCleanupPlan(duplicatePlan, [record("1", "100"), record("2", "200", "Other")]);
    expect(evaluateCleanDataset(cleaned.fields, cleaned.records).join(" ")).toMatch(/duplicate values/);
  });

  it("isolates cached plans by site, model, instruction, and sampled schema", async () => {
    const profiles = buildAiProfile(fields, [record("1", "100")]);
    const base = await aiPlanCacheKey("a.test", "model-a", "contacts", profiles);
    expect(await aiPlanCacheKey("b.test", "model-a", "contacts", profiles)).not.toBe(base);
    expect(await aiPlanCacheKey("a.test", "model-b", "contacts", profiles)).not.toBe(base);
    expect(await aiPlanCacheKey("a.test", "model-a", "products", profiles)).not.toBe(base);
  });

  it("removes model prose from cached plans and refuses patterns that echo sample data", () => {
    const profiles = buildAiProfile(fields, [record("1", "123456789")]);
    const safe = cacheSafeCleanupPlan({ ...dynamicPlan, recordType: "Nice Ply ads", summary: "Nice Ply is useful", fields: dynamicPlan.fields.map((field) => ({ ...field, reason: "Copied Nice Ply" })) }, profiles);
    expect(safe?.recordType).toBe("Cached records");
    expect(safe?.summary).not.toContain("Nice Ply");
    expect(safe?.fields.every((field) => !field.reason.includes("Nice Ply"))).toBe(true);
    const leaking = { ...dynamicPlan, fields: dynamicPlan.fields.map((field, index) => index === 1 ? { ...field, pattern: "Library ID:\\s*(123456789)" } : field) };
    expect(cacheSafeCleanupPlan(leaking, profiles)).toBeNull();
  });
});
