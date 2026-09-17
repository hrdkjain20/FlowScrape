import { defineManifest } from "@crxjs/vite-plugin";

export default defineManifest({
  manifest_version: 3,
  name: "FlowScrape",
  version: "1.2.0",
  description: "Local, continuous structured-data extraction from the page you choose.",
  permissions: ["activeTab", "scripting", "storage", "sidePanel", "downloads"],
  optional_host_permissions: ["https://api.groq.com/*"],
  action: { default_title: "Open FlowScrape" },
  commands: {
    "_execute_action": {
      suggested_key: { default: "Alt+Shift+F" },
      description: "Open FlowScrape for the active webpage"
    }
  },
  background: { service_worker: "src/background/service-worker.ts", type: "module" },
  side_panel: { default_path: "src/sidepanel/index.html" },
  options_page: "src/privacy/index.html",
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; base-uri 'self'"
  }
});
