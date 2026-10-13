# Daily Work Tracker — Edge / Chrome Extension

A Microsoft Edge / Google Chrome (Manifest V3) extension to log daily
tasks against projects and time, with a project master, JSON/CSV
import & export, a toolbar icon that changes with your day's status, and
direct Google Sheets sync.

## What's inside

```
work-tracker-extension/
├── manifest.json
├── icons/               generated status icons (freeze / progress / hot / advance)
├── popup/                quick-add popup (click the toolbar icon)
├── dashboard/             full page: Entries, Project Master, Google Sheets, Import/Export
├── background/            service worker: icon state tracking
├── lib/                   shared data layer & Google Sheets helpers
└── google-apps-script/    ready-to-deploy Google Apps Script Web App
```

## 1. Install the extension in Edge / Chrome

1. Open `edge://extensions` (or `chrome://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select the `work-tracker-extension` folder (the one containing `manifest.json`)
5. Pin the extension to the toolbar

Click the icon any time to quick-add an entry. Click the **⤢** button in the
popup (or right-click the icon → Options) to open the full dashboard.

## 2. How the icon states work

| Icon | Meaning |
|---|---|
| ❄️ Freeze (blue) | No entry logged yet today |
| 🤔 Progress (amber) | At least one task today is **In Progress** — "something else in mind" |
| 🔥 Hot (red) | Today's tasks are **Completed** |
| 🚀 Advance (purple) | Only **Advance / Phase 2** (future) items logged today |

The icon updates automatically whenever you add, edit, or delete an entry.

## 3. Project Master

Dashboard → **Project Master**: add projects with a color, rename them,
toggle active/inactive (inactive projects stop showing in the quick-add
dropdown but stay attached to past entries), or delete them.

## 4. Import / Export

Dashboard → **Import / Export**:
- **Export as JSON** — full backup (projects + entries + settings).
- **Export entries as CSV** — for Excel/Sheets.
- **Import** a JSON export back in, either **merge** (adds anything new,
  keeps existing) or **replace** (wipes and reloads from the file).

## 5. Data storage

Everything is stored in `chrome.storage.local` on your machine (with
`unlimitedStorage` permission, so it isn't capped at the default 10MB) —
nothing is sent anywhere unless you explicitly export it or use the
Google Sheets sync feature.

## 6. Google Sheets Integration (Time_Tracking)

Directly logs your daily entries into your Google Sheet without needing Google Cloud Console projects, API keys, or OAuth consent screens.

### Sheet Column Layout
The script writes to your active sheet tab (e.g. `Time_Tracking`):
- **Column A:** `# SL` (Serial Number: 1, 2, 3...)
- **Column B:** `Date` (YYYY-MM-DD)
- **Column C:** `Project` (e.g. April, Discussion, ToyzBerg)
- **Column D:** `Description` (Task details)
- **Column E:** `Time` (Hours: 2, 1.5, 0.5)
- **Column F:** `Status` (Completed, In Progress, To Do)

> **Total Hours Row:** You can add a `Total Hours` row at the bottom with a formula like `=SUM(E2:E...)`. The sync will automatically insert new entries **above** it, push the Total row down, and update the `=SUM()` formula automatically!

### Setup in 3 Minutes:
1. Open your Google Sheet in your browser.
2. Go to **Extensions > Apps Script**.
3. Replace any code with `google-apps-script/Code.gs` (you can click **📋 Copy Apps Script Code** directly from the extension's Dashboard → **Google Sheets** tab).
4. Click **Deploy > New deployment**.
5. Select **Web app** from the gear icon.
6. Set:
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
7. Click **Deploy**, authorize permissions, and copy the **Web app URL**.
8. In the extension, open Dashboard → **Google Sheets**, paste the Web app URL, and click **Test Connection**.
9. Turn on **Auto-sync** or click **Sync to Sheet** in the popup anytime!

