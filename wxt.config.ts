import { defineConfig } from "wxt";

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ["@wxt-dev/module-svelte"],
  outDir: "output",
  manifest: {
    name: "Web Automation Agent",
    description:
      "AI web automation in your own browser: give a goal in chat, the agent observes the page and acts step by step.",
    permissions: ["activeTab", "tabs", "scripting", "storage", "sidePanel", "webNavigation"],
    host_permissions: ["<all_urls>", "https://api.openai.com/*"],
    action: { default_title: "Web Automation Agent" },
  },
});
