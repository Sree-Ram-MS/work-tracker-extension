// Shared data layer used by popup, dashboard and background.
// Everything lives in chrome.storage.local under three keys: projects, entries, settings.

const KEYS = { PROJECTS: "projects", ENTRIES: "entries", SETTINGS: "settings" };

const DEFAULT_SETTINGS = {
  googleSheets: {
    enabled: false,
    webhookUrl: "",
    sheetName: "Time_Tracking",
    autoSyncOnAdd: true
  }
};

const DEFAULT_PROJECTS = [
  { id: "proj-general", name: "General", color: "#6c63ff", active: true }
];

function uid(prefix = "id") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function getRaw(key, fallback) {
  const res = await chrome.storage.local.get(key);
  if (res[key] === undefined) return fallback;
  return res[key];
}

async function setRaw(key, value) {
  await chrome.storage.local.set({ [key]: value });
  return value;
}

export const db = {
  uid,

  async getProjects() {
    return getRaw(KEYS.PROJECTS, DEFAULT_PROJECTS);
  },
  async saveProjects(projects) {
    return setRaw(KEYS.PROJECTS, projects);
  },
  async addProject(name, color) {
    const projects = await this.getProjects();
    const p = { id: uid("proj"), name: name.trim(), color: color || randomColor(), active: true };
    projects.push(p);
    await this.saveProjects(projects);
    return p;
  },
  async updateProject(id, patch) {
    const projects = await this.getProjects();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    projects[idx] = { ...projects[idx], ...patch };
    await this.saveProjects(projects);
    return projects[idx];
  },
  async deleteProject(id) {
    const projects = await this.getProjects();
    await this.saveProjects(projects.filter((p) => p.id !== id));
  },

  async getEntries() {
    return getRaw(KEYS.ENTRIES, []);
  },
  async saveEntries(entries) {
    return setRaw(KEYS.ENTRIES, entries);
  },
  async addEntry(entry) {
    const entries = await this.getEntries();
    const e = {
      id: uid("entry"),
      date: entry.date,
      projectId: entry.projectId,
      task: entry.task.trim(),
      hours: Number(entry.hours) || 0,
      status: entry.status || "todo", // todo | inprogress | completed
      notes: entry.notes || "",
      syncedToSheet: !!entry.syncedToSheet,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    entries.push(e);
    await this.saveEntries(entries);
    return e;
  },
  async markEntriesSynced(ids) {
    const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
    const entries = await this.getEntries();
    let changed = false;
    for (const e of entries) {
      if (idSet.has(e.id) && !e.syncedToSheet) {
        e.syncedToSheet = true;
        e.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) {
      await this.saveEntries(entries);
    }
    return entries;
  },
  async updateEntry(id, patch) {
    const entries = await this.getEntries();
    const idx = entries.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    entries[idx] = { ...entries[idx], ...patch, updatedAt: Date.now() };
    await this.saveEntries(entries);
    return entries[idx];
  },
  async deleteEntry(id) {
    const entries = await this.getEntries();
    await this.saveEntries(entries.filter((e) => e.id !== id));
  },
  async entriesForDate(dateStr) {
    const entries = await this.getEntries();
    return entries.filter((e) => e.date === dateStr);
  },

  async getSettings() {
    const s = await getRaw(KEYS.SETTINGS, DEFAULT_SETTINGS);
    return {
      ...DEFAULT_SETTINGS,
      ...s,
      googleSheets: { ...DEFAULT_SETTINGS.googleSheets, ...(s.googleSheets || {}) }
    };
  },
  async saveSettings(settings) {
    return setRaw(KEYS.SETTINGS, settings);
  },

  async exportAll() {
    const [projects, entries, settings] = await Promise.all([
      this.getProjects(),
      this.getEntries(),
      this.getSettings()
    ]);
    return {
      exportedAt: new Date().toISOString(),
      version: 1,
      projects,
      entries,
      settings
    };
  },

  async importAll(data, mode = "merge") {
    if (!data || typeof data !== "object") throw new Error("Invalid file");
    const incomingProjects = Array.isArray(data.projects) ? data.projects : [];
    const incomingEntries = Array.isArray(data.entries) ? data.entries : [];

    if (mode === "replace") {
      await this.saveProjects(incomingProjects.length ? incomingProjects : DEFAULT_PROJECTS);
      await this.saveEntries(incomingEntries);
    } else {
      const projects = await this.getProjects();
      const entries = await this.getEntries();
      const pIds = new Set(projects.map((p) => p.id));
      const eIds = new Set(entries.map((e) => e.id));
      incomingProjects.forEach((p) => {
        if (!pIds.has(p.id)) projects.push(p);
      });
      incomingEntries.forEach((e) => {
        if (!eIds.has(e.id)) entries.push(e);
      });
      await this.saveProjects(projects);
      await this.saveEntries(entries);
    }
    if (data.settings && typeof data.settings === "object") {
      const current = await this.getSettings();
      await this.saveSettings({
        ...current,
        ...data.settings,
        googleSheets: { ...current.googleSheets, ...(data.settings.googleSheets || {}) }
      });
    }
  }
};

function randomColor() {
  const palette = ["#6c63ff", "#ff6b6b", "#f0a028", "#22b8a3", "#3b82f6", "#e879f9", "#10b981", "#f43f5e"];
  return palette[Math.floor(Math.random() * palette.length)];
}

export function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tz * 60000);
  return local.toISOString().slice(0, 10);
}

// hours is a decimal, e.g. 2.5 === 2h 30m. This renders it as a friendly label.
export function hoursToLabel(hours) {
  const totalMinutes = Math.round((Number(hours) || 0) * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export const DAILY_TARGET_HOURS = 8;

export function dayProgress(entriesForDay) {
  const totalHours = (entriesForDay || []).reduce((s, e) => s + (Number(e.hours) || 0), 0);
  const pct = Math.min(100, Math.round((totalHours / DAILY_TARGET_HOURS) * 100));
  return { totalHours, pct, target: DAILY_TARGET_HOURS, over: totalHours > DAILY_TARGET_HOURS };
}
