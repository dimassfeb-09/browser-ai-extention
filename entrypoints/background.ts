import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel (chat UI).
  browser.sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => undefined);
});
