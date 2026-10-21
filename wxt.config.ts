import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: 'Web Automation Agent',
    description:
      'AI web automation in your own browser: give a goal in chat, the agent observes the page and acts step by step.',
    permissions: ['activeTab', 'tabs', 'scripting', 'storage', 'sidePanel'],
    host_permissions: ['https://api.openai.com/*'],
    action: { default_title: 'Web Automation Agent' },
  },
});
