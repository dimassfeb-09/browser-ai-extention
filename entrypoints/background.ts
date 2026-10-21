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

  browser.action?.onClicked.addListener((tab) => {
    if (!sidePanel || tab.id == null) return;
    const tabId = tab.id;
    // CRITICAL: sidePanel.open() may only be called in response to a
    // user gesture, and Chrome drops the gesture context at the first
    // await. So setOptions and open are issued BACK TO BACK in the
    // same synchronous turn of this click handler — Chrome processes
    // extension API calls in issue order, so the tab is enabled
    // before the open is handled. (Awaiting setOptions first made
    // open() reject with a gesture error and the panel unopenable.)
    const enable = sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    const open = sidePanel.open({ tabId });
    void Promise.allSettled([enable, open]).then(([, openResult]) => {
      if (openResult.status === 'fulfilled') return;
      // Rescue ladder: never leave the user with an unopenable panel.
      // Fall back to the classic window-wide behavior — the panel
      // becomes available everywhere and the NEXT icon click opens
      // it the way Chrome natively handles it.
      console.warn('per-tab sidePanel.open failed, falling back to window-wide panel', openResult.reason);
      void sidePanel.setOptions({ enabled: true }).catch(() => undefined);
      void sidePanel
        .setPanelBehavior({ openPanelOnActionClick: true })
        .catch(() => undefined);
    });
  });
});
