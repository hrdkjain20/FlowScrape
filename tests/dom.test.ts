import { describe, expect, it } from "vitest";
import { safeQueryAll, uniqueSelector } from "../src/content/dom";

describe("modern DOM traversal", () => {
  it("selects through an open shadow root", () => {
    document.body.innerHTML = `<section id="host"></section>`;
    const host = document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<div class="cards"><article class="card"><span class="name">A</span></article></div>`;
    const cards = shadow.querySelector(".cards")!;
    const selector = uniqueSelector(cards);
    expect(selector).toContain(">>>");
    expect(safeQueryAll(document, selector)[0]).toBe(cards);
  });

  it("rejects invalid selectors without throwing", () => {
    expect(safeQueryAll(document, "[[bad")).toEqual([]);
  });
});
