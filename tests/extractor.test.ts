import { beforeEach, describe, expect, it } from "vitest";
import { extractRecord, isIncomplete } from "../src/content/extractor";
import type { FieldDefinition } from "../src/shared/types";

const fields: FieldDefinition[] = [
  { id: "name", name: "Name", selector: ".name", type: "text", multiple: false, required: true },
  { id: "price", name: "Price", selector: ".price", type: "price", multiple: false, required: false },
  { id: "url", name: "URL", selector: "a", type: "url", multiple: false, required: false, attribute: "href" }
];

describe("record extraction", () => {
  beforeEach(() => { document.head.innerHTML = `<base href="https://example.test/catalog/">`; });

  it("normalizes Unicode whitespace, price numbers, and relative URLs", () => {
    document.body.innerHTML = `<article><h2 class="name">  Café\u200B   Chair </h2><span class="price">€ 1.234,50</span><a href="item/4">Open</a></article>`;
    const record = extractRecord(document.querySelector("article")!, fields, "batch-1");
    expect(record.values.name).toBe("Café Chair");
    expect(record.values.price).toBe(1234.5);
    expect(record.values.url).toBe("https://example.test/catalog/item/4");
    expect(isIncomplete(record, fields)).toBe(false);
  });

  it("marks required missing fields incomplete", () => {
    document.body.innerHTML = `<article><span class="price">$5</span></article>`;
    expect(isIncomplete(extractRecord(document.querySelector("article")!, fields, "batch-2"), fields)).toBe(true);
  });

  it("produces identical fingerprints for recycled nodes with identical values", () => {
    document.body.innerHTML = `<article data-id="4"><h2 class="name">Same</h2></article>`;
    const item = document.querySelector("article")!;
    expect(extractRecord(item, fields, "a").fingerprint).toBe(extractRecord(item, fields, "b").fingerprint);
  });

  it("never reads private form values and sanitizes raw HTML", () => {
    document.body.innerHTML = `<article><input class="secret" value="card-number"><div class="markup" onclick="steal()"><span>Public</span><input value="password"><b data-auth-token="secret">Label</b></div></article>`;
    const privateFields: FieldDefinition[] = [
      { id: "secret", name: "Secret", selector: ".secret", type: "attribute", attribute: "value", multiple: false, required: false },
      { id: "html", name: "HTML", selector: ".markup", type: "html", multiple: false, required: false }
    ];
    const record = extractRecord(document.querySelector("article")!, privateFields, "safe");
    expect(record.values.secret).toBeNull();
    expect(record.values.html).toContain("Public");
    expect(record.values.html).not.toContain("password");
    expect(record.values.html).not.toContain("data-auth-token");
  });

  it("uses fallback locators and safely extracts semantic patterns", () => {
    document.body.innerHTML = `<article><div class="variant-title">Variant product</div><p>Library ID: 771122 Started running on August 20, 2026</p><p>Call +91 98765 43210 or email sales@example.test</p></article>`;
    const adaptive: FieldDefinition[] = [
      { id: "title", name: "Title", selector: ".missing", selectors: [".variant-title"], type: "text", multiple: false, required: true },
      { id: "library", name: "Library ID", selector: ":scope", pattern: "Library\\s+ID\\s*:\\s*(\\d+)", type: "text", multiple: false, required: false },
      { id: "email", name: "Email", selector: ":scope", pattern: "([A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})", patternFlags: "i", type: "email", multiple: true, required: false }
    ];
    const record = extractRecord(document.querySelector("article")!, adaptive, "adaptive");
    expect(record.values.title).toBe("Variant product");
    expect(record.values.library).toBe("771122");
    expect(record.values.email).toEqual(["sales@example.test"]);
  });
});
