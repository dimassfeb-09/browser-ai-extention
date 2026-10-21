import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';

export default defineBackground(() => {
  const sidePanel = browser.sidePanel;

  // Per-tab side panel. Chrome's side panel is window-scoped by
  // default (open it on one tab and it shows on every tab of the
  // window), but setOptions accepts a tabId: per-tab options override
  // the default. So the default is DISABLED, and clicking the toolbar
  // icon enables + opens the panel for THAT tab only. Switching to
  // another tab hides the panel; switching back brings it (and the
  // tab's chat) back. The agent's actions were already pinned per run;
  // this pins the UI per tab too.
  void sidePanel
    ?.setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => undefined);
  void sidePanel?.setOptions({ enabled: false }).catch(() => undefined);

  browser.action?.onClicked.addListener(async (tab) => {
    if (!sidePanel || tab.id == null) return;
    try {
      await sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
      await sidePanel.open({ tabId: tab.id });
    } catch {
      // Environments without per-tab options: fall back to the classic
      // window-wide panel rather than no panel at all.
      try {
        await sidePanel.setOptions({ enabled: true });
        await sidePanel.open({ windowId: tab.windowId });
      } catch {
        // No side panel support — nothing sensible left to do.
      }
    }
  });
});
