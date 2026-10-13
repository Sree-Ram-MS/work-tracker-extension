import { db, todayStr, hoursToLabel, dayProgress } from "../lib/db.js";
import { computeDayIconState, STATUS_META } from "../lib/status.js";
import { syncEntryToSheet, syncBatchToSheet } from "../lib/sheets.js";

const $ = (sel) => document.querySelector(sel);

const fDate      = $("#fDate");
const fHours     = $("#fHours");
const fProject   = $("#fProject");
const fTask      = $("#fTask");
const pills      = document.querySelectorAll(".pill");
const quickForm  = $("#quickForm");
const todayList  = $("#todayList");
const todayTotal = $("#todayTotal");
const emptyState = $("#emptyState");
const statusGlyph  = $("#statusGlyph");
const statusLabel  = $("#statusLabel");
const progressFill = $("#progressFill");
const progressText = $("#progressText");
const dayLabel   = $("#dayLabel");
const prevDayBtn = $("#prevDay");
const nextDayBtn = $("#nextDay");
const quickSyncToast = $("#quickSyncToast");
const syncToSheetQuick = $("#syncToSheetQuick");
const openSheets = $("#openSheets");

let selectedStatus = "todo";

function showToast(text, isSuccess = true, duration = 3000) {
  if (!quickSyncToast) return;
  quickSyncToast.textContent = text;
  quickSyncToast.className = `sync-toast ${isSuccess ? "success" : "error"}`;
  quickSyncToast.style.display = "block";
  setTimeout(() => {
    quickSyncToast.style.display = "none";
  }, duration);
}

// The date currently shown in the entries list (may differ from the form date).
// Stored as YYYY-MM-DD string.
let viewDate = todayStr();

// ── helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Shift a YYYY-MM-DD string by `days` (positive = forward, negative = back). */
function shiftDate(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  const tz = d.getTimezoneOffset();
  return new Date(d.getTime() - tz * 60000).toISOString().slice(0, 10);
}

function formatDayLabel(dateStr) {
  const today = todayStr();
  if (dateStr === today)               return "Today";
  if (dateStr === shiftDate(today, -1)) return "Yesterday";
  if (dateStr === shiftDate(today,  1)) return "Tomorrow";
  return dateStr;                       // fallback: YYYY-MM-DD
}

function notifyIconRefresh() {
  chrome.runtime.sendMessage({ type: "REFRESH_ICON" }).catch(() => {});
}

// ── projects ─────────────────────────────────────────────────────────────────

async function loadProjects() {
  const projects = await db.getProjects();
  fProject.innerHTML = projects
    .filter((p) => p.active !== false)
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");
}

// ── status pills ─────────────────────────────────────────────────────────────

function setActivePill(status) {
  selectedStatus = status;
  pills.forEach((p) => p.classList.toggle("active", p.dataset.status === status));
}

pills.forEach((p) => p.addEventListener("click", () => setActivePill(p.dataset.status)));

// ── entry list renderer ───────────────────────────────────────────────────────

async function renderEntries() {
  const today = todayStr();
  const isToday = viewDate === today;

  // Day label + next-day button visibility
  dayLabel.textContent = formatDayLabel(viewDate);
  nextDayBtn.disabled = viewDate >= today; // can't go into the future beyond today

  const [entries, projects] = await Promise.all([
    db.entriesForDate(viewDate),
    db.getProjects()
  ]);
  const projectsById = Object.fromEntries(projects.map((p) => [p.id, p]));

  entries.sort((a, b) => b.createdAt - a.createdAt);

  todayList.innerHTML = entries
    .map((e) => {
      const proj = projectsById[e.projectId];
      const meta = STATUS_META[e.status] || {};
      const canComplete = e.status !== "completed";
      return `<li class="entry-item status-${e.status}" data-id="${e.id}">
        ${canComplete
          ? `<button class="entry-complete" title="Mark as completed" data-id="${e.id}">&#10003;</button>`
          : `<span class="entry-done-tick" title="Completed">&#10003;</span>`
        }
        <div class="entry-main">
          <div class="entry-task">${escapeHtml(e.task)}</div>
          <div class="entry-meta">${proj ? escapeHtml(proj.name) : "—"} · ${hoursToLabel(e.hours)} · ${meta.label || e.status}${e.syncedToSheet ? ' · <span title="Synced to Google Sheet" style="color:#4ade80;">📊 Synced</span>' : ''}</div>
        </div>
        <button class="entry-remove" title="Delete" data-id="${e.id}">&#215;</button>
      </li>`;
    })
    .join("");

  emptyState.style.display = entries.length ? "none" : "block";
  todayTotal.textContent = entries.length
    ? `${hoursToLabel(entries.reduce((s, e) => s + (Number(e.hours) || 0), 0))} logged`
    : "";

  // Progress bar only reflects today
  if (isToday) {
    const { totalHours, pct, target, over } = dayProgress(entries);
    progressFill.style.width = `${pct}%`;
    progressFill.classList.toggle("over", over);
    progressText.textContent = `${round2(totalHours)} / ${target}h${over ? " 🎉" : ""}`;

    const state = computeDayIconState(entries);
    const labelMap = {
      freeze:   "No entry yet today",
      progress: "In progress — something else in mind",
      hot:      "Completed — hot streak today",
      advance:  "To-do items pending"
    };
    // Use chrome.runtime.getURL so the src is always a valid extension URL
    statusGlyph.src = chrome.runtime.getURL(`icons/${state}-32.png`);
    statusLabel.textContent = labelMap[state] || "Daily Work Tracker";
  } else {
    // Not today — dim the progress bar to show it reflects today only
    const { totalHours, pct, target, over } = dayProgress(entries);
    progressFill.style.width = `${pct}%`;
    progressFill.classList.toggle("over", over);
    progressText.textContent = `${round2(totalHours)} / ${target}h (${formatDayLabel(viewDate)})`;
  }

  // ── event listeners ──

  todayList.querySelectorAll(".entry-complete").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await db.updateEntry(btn.dataset.id, { status: "completed" });
      notifyIconRefresh();
      await renderEntries();
    });
  });

  todayList.querySelectorAll(".entry-remove").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      await db.deleteEntry(btn.dataset.id);
      notifyIconRefresh();
      await renderEntries();
    });
  });
}

// ── date navigation ───────────────────────────────────────────────────────────

prevDayBtn.addEventListener("click", () => {
  viewDate = shiftDate(viewDate, -1);
  renderEntries();
});

nextDayBtn.addEventListener("click", () => {
  const today = todayStr();
  if (viewDate < today) {
    viewDate = shiftDate(viewDate, 1);
    renderEntries();
  }
});

// ── form submission ───────────────────────────────────────────────────────────

quickForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const hours = parseFloat(fHours.value);
  if (!fTask.value.trim() || !hours || hours <= 0) return;

  const submitBtn = quickForm.querySelector('button[type="submit"]');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = "Adding…";
  }

  try {
    const entryDate = fDate.value || todayStr();
    const newEntry = await db.addEntry({
      date: entryDate,
      projectId: fProject.value,
      task: fTask.value,
      hours,
      status: selectedStatus
    });
    notifyIconRefresh();

    fTask.value = "";
    fHours.value = "";

    // Switch the view to the date just added so the entry appears immediately
    viewDate = entryDate;
    await renderEntries();

    // Auto-sync to Google Sheet if enabled
    try {
      const settings = await db.getSettings();
      if (settings.googleSheets?.enabled && settings.googleSheets?.webhookUrl && settings.googleSheets?.autoSyncOnAdd !== false) {
        showToast("Syncing to Google Sheet…", true, 1800);
        const projects = await db.getProjects();
        const proj = projects.find((p) => p.id === newEntry.projectId);
        const res = await syncEntryToSheet(newEntry, proj, settings);
        if (res.ok) {
          await db.markEntriesSynced([newEntry.id]);
          await renderEntries();
          const note = res.updatedCount ? "updated" : (res.skippedCount ? "already on Sheet" : "synced");
          showToast(`✓ Logged & ${note}!`, true);
        } else {
          showToast(`Saved locally (Sheet: ${res.error || "failed"})`, false, 3500);
        }
      }
    } catch (syncErr) {
      console.error("Auto-sync error:", syncErr);
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Add entry";
      fTask.focus();
    }
  }
});

// ── footer buttons ────────────────────────────────────────────────────────────

$("#openDashboard")?.addEventListener("click", () => chrome.runtime.openOptionsPage());

syncToSheetQuick?.addEventListener("click", async () => {
  const settings = await db.getSettings();
  if (!settings.googleSheets?.enabled || !settings.googleSheets?.webhookUrl) {
    showToast("Configure Google Sheets in 'Sheet setup' first", false, 3500);
    return;
  }
  const [entries, projects] = await Promise.all([
    db.entriesForDate(viewDate),
    db.getProjects()
  ]);
  if (!entries.length) {
    showToast(`No entries to sync for ${formatDayLabel(viewDate)}.`, false, 2500);
    return;
  }

  const pending = entries.filter((e) => !e.syncedToSheet);
  if (!pending.length) {
    showToast(`All entries for ${formatDayLabel(viewDate)} are already synced! ✓`, true, 3000);
    return;
  }

  syncToSheetQuick.disabled = true;
  syncToSheetQuick.textContent = "Syncing…";
  showToast("Syncing to Google Sheet…", true, 2000);

  const projectsById = Object.fromEntries(projects.map((p) => [p.id, p]));
  const res = await syncBatchToSheet(pending, projectsById, settings);

  syncToSheetQuick.disabled = false;
  syncToSheetQuick.textContent = "📊 Sync to Sheet";

  if (res.ok) {
    await db.markEntriesSynced(pending.map((e) => e.id));
    await renderEntries();
    let msg = `✓ Synced ${res.appendedCount || pending.length} entries to Sheet!`;
    if (res.updatedCount) msg += ` (${res.updatedCount} updated)`;
    if (res.skippedCount) msg += ` (${res.skippedCount} duplicate(s) skipped)`;
    showToast(msg, true);
  } else {
    showToast(`Sync failed: ${res.error || "Unknown error"}`, false, 4000);
  }
});

openSheets?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  chrome.storage.local.set({ __dashboardTab: "sheets" });
});

$("#openProjects")?.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  chrome.storage.local.set({ __dashboardTab: "projects" });
});

$("#exportQuick")?.addEventListener("click", async () => {
  const data = await db.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `work-tracker-export-${todayStr()}.json`,
    saveAs: true
  });
});

// ── init ──────────────────────────────────────────────────────────────────────

async function init() {
  fDate.value = todayStr();
  setActivePill("todo");
  await loadProjects();
  await renderEntries();
}

init();
