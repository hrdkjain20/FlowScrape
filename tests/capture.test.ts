import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaptureController } from "../src/content/capture";
import type { CollectionCandidate, FieldDefinition, ScrapedRecord } from "../src/shared/types";

const fields: FieldDefinition[] = [{ id: "name", name: "Name", selector: ".name", type: "text", multiple: false, required: true }];
const candidate: CollectionCandidate = { id: "c", name: "Rows", containerSelector: "#list", itemSelector: ":scope > .row", itemCount: 3, score: 80, explanation: "fixture", fields };

describe("incremental capture", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `<section id="list"><article class="row" data-key="0"><span class="name">A</span></article><article class="row" data-key="1"><span class="name">B</span></article><article class="row" data-key="2"><span class="name">C</span></article></section>`;
  });
  afterEach(() => vi.useRealTimers());

  it("deduplicates unchanged values but captures recycled-node values and cleans up", async () => {
    const captured: ScrapedRecord[] = [];
    const controller = new CaptureController(100, (batch) => captured.push(...batch.records));
    controller.start(candidate, fields);
    await vi.advanceTimersByTimeAsync(200);
    expect(captured.map((record) => record.values.name)).toEqual(["A", "B", "C"]);

    document.querySelectorAll<HTMLElement>(".row").forEach((row, index) => {
      row.dataset.key = String(index + 3);
      row.querySelector(".name")!.textContent = ["D", "E", "F"][index];
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(new Set(captured.map((record) => record.values.name))).toEqual(new Set(["A", "B", "C", "D", "E", "F"]));

    controller.stop();
    document.querySelector("#list")!.insertAdjacentHTML("beforeend", `<article class="row"><span class="name">G</span></article>`);
    await vi.advanceTimersByTimeAsync(400);
    expect(captured.some((record) => record.values.name === "G")).toBe(false);
  });
});
