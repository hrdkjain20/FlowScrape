// @vitest-environment node
import { describe, expect, it } from "vitest";
import manifest from "../manifest.config";
import { isRestrictedUrl, isSensitiveSite } from "../src/shared/types";

describe("security boundaries", () => {
  it("keeps required permissions minimal and host access optional", () => {
    const config = manifest as unknown as { permissions: string[]; optional_host_permissions: string[] };
    expect(config.permissions).toEqual(["activeTab", "scripting", "storage", "sidePanel", "downloads"]);
    expect(config.permissions).not.toContain("<all_urls>");
    expect(config.optional_host_permissions).toEqual(["https://api.groq.com/*"]);
  });

  it("refuses protected URLs and warns for sensitive hostnames", () => {
    expect(isRestrictedUrl("chrome://settings")).toBe(true);
    expect(isRestrictedUrl("https://chrome.google.com/webstore/detail/x")).toBe(true);
    expect(isRestrictedUrl("https://example.test/products")).toBe(false);
    expect(isSensitiveSite("secure.banking.example")).toBe(true);
  });
});
