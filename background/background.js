import { db, todayStr } from "../lib/db.js";
import { computeDayIconState, iconPaths } from "../lib/status.js";

async function refreshIcon() {
  try {
    const today = todayStr();
    const entries = await db.entriesForDate(today);
    const state = computeDayIconState(entries);
    // Use fully-qualified chrome-extension:// URLs for reliability
    const paths = iconPaths(state, (rel) => chrome.runtime.getURL(rel));
    await chrome.action.setIcon({ path: paths });
    const titles = {
      freeze: "Daily Work Tracker — no entry logged today",
      progress: "Daily Work Tracker — in progress",
      hot: "Daily Work Tracker — completed for today",
      advance: "Daily Work Tracker — to-do items pending"
    };
    await chrome.action.setTitle({ title: titles[state] || "Daily Work Tracker" });
  } catch (err) {
    console.error("Work Tracker: failed to refresh icon", err);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  refreshIcon();
});

chrome.runtime.onStartup.addListener(() => {
  refreshIcon();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.entries) refreshIcon();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "REFRESH_ICON") {
    refreshIcon().then(() => sendResponse({ ok: true }));
    return true;
  }
});

refreshIcon();
