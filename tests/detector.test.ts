import { beforeEach, describe, expect, it } from "vitest";
import { detectCollections, structuralSignature, structuralSimilarity } from "../src/content/detector";
import { inferSchema } from "../src/content/schema";

describe("collection detection", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("prioritizes a semantic product collection and infers fields", () => {
    document.body.innerHTML = `<main><section id="products">${Array.from({ length: 8 }, (_, index) => `<article class="product-card"><h2 class="product-name">Product ${index}</h2><a href="/p/${index}">View</a><span class="price">$${index + 10}.50</span></article>`).join("")}</section></main>`;
    const candidates = detectCollections();
    expect(candidates[0].itemCount).toBe(8);
    expect(candidates[0].score).toBeGreaterThan(40);
    expect(candidates[0].fields.some((field) => field.type === "price")).toBe(true);
    expect(candidates[0].explanation).toContain("visible repeated items");
  });

  it("uses table headers as stable column names", () => {
    document.body.innerHTML = `<table><thead><tr><th>Name</th><th>Price</th></tr></thead><tbody><tr><td>A</td><td>$12</td></tr><tr><td>B</td><td>$14</td></tr></tbody></table>`;
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    expect(inferSchema(rows).map((field) => field.name)).toEqual(["Name", "Price"]);
  });

  it("expands rowspan and colspan table headers", () => {
    document.body.innerHTML = `<table><thead><tr><th rowspan="2">Name</th><th colspan="2">Contact</th><th rowspan="2">Joined</th></tr><tr><th>Email</th><th>Phone</th></tr></thead><tbody><tr><td>A</td><td>a@example.test</td><td>+1 555 0100</td><td>2025-01-01</td></tr></tbody></table>`;
    const fields = inferSchema([document.querySelector("tbody tr")!]);
    expect(fields.map((field) => field.name)).toEqual(["Name", "Contact Email", "Contact Phone", "Joined"]);
  });

  it("normalizes volatile classes out of signatures", () => {
    document.body.innerHTML = `<div><article class="card active css-abc123"><span></span></article><article class="card selected css-def456"><span></span></article></div>`;
    const articles = Array.from(document.querySelectorAll("article"));
    expect(structuralSignature(articles[0])).toBe(structuralSignature(articles[1]));
  });

  it("groups heterogeneous cards by approximate structure instead of exact classes", () => {
    document.body.innerHTML = `<main><section id="ads">${Array.from({ length: 6 }, (_, index) => `
      <div class="${index % 2 ? `x_${index} selected` : `css-${index} card`}">
        <div><span>Active</span><div>Library ID: ${9000 + index}</div><span>Started running on August ${index + 1}, 2026</span></div>
        <div class="creative-${index}"><a href="/profile/${index}"><strong>Advertiser ${index}</strong></a><span>Sponsored</span><p>Wholesale distributor offer ${index}</p></div>
        ${index % 2 ? `<video src="/creative/${index}.mp4"></video>` : `<img src="/creative/${index}.jpg" alt="Creative ${index}">`}
      </div>`).join("")}</section></main>`;
    const records = Array.from(document.querySelectorAll("#ads > div"));
    expect(structuralSimilarity(records[0], records[1])).toBeGreaterThan(0.54);
    const candidate = detectCollections().find((entry) => entry.itemCount === 6);
    expect(candidate).toBeDefined();
    expect(candidate?.fields.map((field) => field.name)).toContain("Library ID");
    expect(candidate?.fields.some((field) => field.name === "Link Text" && field.type === "text")).toBe(true);
    expect(candidate?.fields.some((field) => field.type === "image")).toBe(true);
  });

  it("infers a union schema from optional marketplace fields across records", () => {
    document.body.innerHTML = `<section>${Array.from({ length: 5 }, (_, index) => `<article class="listing">
      <a class="product-name" href="/product/item-${index}">Mixer ${index}</a><img src="/mixer-${index}.jpg" alt="Mixer ${index}">
      <span>₹ ${1200 + index * 100}</span>${index === 0 ? "" : `<span class="moq">MOQ: ${index + 1} Piece</span>`}
      <div data-label="Supplier">Supplier ${index}</div><div aria-label="Location">Jaipur, Rajasthan</div>
      ${index > 2 ? `<span>4.${index} stars</span><span>${index * 10} reviews</span>` : ""}
    </article>`).join("")}</section>`;
    const fields = inferSchema(Array.from(document.querySelectorAll("article")));
    expect(fields.some((field) => field.name === "Product Name" && field.type === "text")).toBe(true);
    expect(fields.some((field) => field.name === "Product URL" && field.type === "url")).toBe(true);
    expect(fields.some((field) => field.name === "Price" && field.pattern)).toBe(true);
    expect(fields.some((field) => field.name === "Supplier")).toBe(true);
    expect(fields.some((field) => field.name === "Location")).toBe(true);
    expect(fields.some((field) => field.name === "Minimum Order")).toBe(true);
  });
});
