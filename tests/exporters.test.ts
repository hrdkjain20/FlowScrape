import { describe, expect, it } from "vitest";
import { toCsv, toJson, toJsonLines } from "../src/export/exporters";
import type { FieldDefinition, ScrapedRecord } from "../src/shared/types";

const fields: FieldDefinition[] = [
  { id: "name", name: "Name", selector: ".name", type: "text", multiple: false, required: true },
  { id: "note", name: "Note", selector: ".note", type: "text", multiple: false, required: false }
];
const record = (id: number): ScrapedRecord => ({ id: String(id), values: { name: id ? `Item ${id}` : "=HYPERLINK(\"bad\")", note: "comma, quote \" and\nline" }, sourceUrl: "https://example.test", capturedAt: "2025-01-01T00:00:00.000Z", batchId: "b", fingerprint: `f${id}` });

describe("exporters", () => {
  it("escapes CSV and neutralizes spreadsheet formulas", () => {
    const csv = toCsv([record(0)], fields);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('"comma, quote "" and\nline"');
  });

  it("keeps stable field order and optional metadata", () => {
    const json = JSON.parse(toJson([record(1)], fields, true));
    expect(Object.keys(json[0])).toEqual(["Name", "Note", "_metadata"]);
    expect(toJsonLines([record(1), record(2)], fields).split("\n")).toHaveLength(2);
  });

  it("exports 10,000 records quickly and completely", () => {
    const records = Array.from({ length: 10_000 }, (_, index) => record(index + 1));
    const start = performance.now();
    const lines = toJsonLines(records, fields).split("\n");
    expect(lines).toHaveLength(10_000);
    expect(performance.now() - start).toBeLessThan(1_500);
  });
});
