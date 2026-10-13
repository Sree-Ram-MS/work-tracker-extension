// Helper module for interacting with the Google Apps Script Web App.
//
// Because Google Apps Script Web Apps do not handle CORS preflight OPTIONS,
// requests are sent with Content-Type: "text/plain;charset=utf-8", which
// avoids the preflight OPTIONS request while still sending valid JSON in
// e.postData.contents to the Apps Script doPost() handler.

export function formatStatusForSheet(rawStatus) {
  const s = String(rawStatus || "").toLowerCase().trim();
  if (s === "completed" || s === "hot") return "Completed";
  if (s === "inprogress" || s === "in progress" || s === "progress") return "In Progress";
  if (s === "todo" || s === "to do" || s === "advance") return "To Do";
  return rawStatus || "Completed";
}

/**
 * Normalizes and cleans the Apps Script Webhook URL.
 * Converts test /dev URLs to published /exec URLs automatically.
 * Removes /u/0/, /u/1/ multi-account prefixes that cause Google login redirects.
 */
export function cleanWebhookUrl(url) {
  if (!url) return "";
  let clean = String(url).trim();
  // Strip /u/0/, /u/1/, etc. multi-account prefixes
  clean = clean.replace(/script\.google\.com\/u\/\d+\//i, "script.google.com/");
  // Automatically replace /dev with /exec if the user copied the test deployment URL
  clean = clean.replace(/\/dev(\?.*)?$/i, "/exec$1");
  return clean;
}

/**
 * Safely parses the text response from Google Apps Script.
 * Catches HTML pages returned when authorization or permissions are missing.
 */
async function parseGasResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    const isHtml = text.includes("<!DOCTYPE") || text.includes("<html") || text.includes("accounts.google.com");
    if (isHtml) {
      const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
      const headingMatch = text.match(/<h[12][^>]*>([^<]+)<\/h[12]>/i);
      const pageTitle = titleMatch ? titleMatch[1].trim() : "Google Login / Error";
      const heading = headingMatch ? ` (${headingMatch[1].trim()})` : "";
      
      let hint = "Please verify your Web App deployment settings.";
      const lower = (pageTitle + " " + text).toLowerCase();
      if (lower.includes("sign in") || lower.includes("accounts.google.com") || lower.includes("servicelogin")) {
        hint = "Google blocked the request with a Sign-In screen. Ensure 'Who has access' is 'Anyone' and URL has no /u/0/ or /u/1/. If using a Google Workspace account, external access may be restricted by your admin.";
      } else if (lower.includes("not found") || lower.includes("404")) {
        hint = "Deployment URL not found (404). Please create a New Deployment in Apps Script and copy the new URL.";
      } else if (lower.includes("error") || lower.includes("authorization")) {
        hint = "Authorization or script execution error. Open the Web App URL directly in a browser tab to view the exact error.";
      }

      return {
        ok: false,
        error: `Google returned HTML [${pageTitle}${heading}]. ${hint}`
      };
    }
    return {
      ok: false,
      error: `Unexpected response from Google Sheet: ${text.slice(0, 150)}`
    };
  }
}

/**
 * Test connectivity to the Google Apps Script Webhook.
 * @param {string} webhookUrl 
 * @param {string} sheetName 
 * @returns {Promise<{ ok: boolean, message?: string, error?: string, details?: any }>}
 */
export async function testSheetConnection(webhookUrl, sheetName = "Time_Tracking") {
  const cleanUrl = cleanWebhookUrl(webhookUrl);
  if (!cleanUrl) {
    return { ok: false, error: "Please enter a valid Google Apps Script Web App URL." };
  }

  if (!cleanUrl.startsWith("https://script.google.com/macros/s/")) {
    return {
      ok: false,
      error: "URL must be a valid Google Apps Script Web App URL starting with 'https://script.google.com/macros/s/' and ending in '/exec'"
    };
  }

  try {
    const response = await fetch(cleanUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "ping", sheetName: (sheetName || "Time_Tracking").trim() })
    });

    const data = await parseGasResponse(response);
    if (!data.ok) {
      return { ok: false, error: data.error || `HTTP ${response.status}: Failed to connect.` };
    }

    return {
      ok: true,
      message: `Connected! Target tab: "${data.sheetName || sheetName}" (Sheet: "${data.spreadsheetTitle || "Workbook"}")`,
      details: data
    };
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach Apps Script URL (${err.message}). Ensure deployment access is set to 'Anyone'.`
    };
  }
}

/**
 * Send a single entry to the Google Sheet.
 * @param {object} entry - The entry object from db.
 * @param {object|string} project - The project object or project name.
 * @param {object} settings - Settings object containing googleSheets config.
 * @returns {Promise<{ ok: boolean, appendedCount?: number, error?: string }>}
 */
export async function syncEntryToSheet(entry, project, settings) {
  const gsConfig = settings?.googleSheets;
  const cleanUrl = cleanWebhookUrl(gsConfig?.webhookUrl);
  if (!gsConfig?.enabled || !cleanUrl) {
    return { ok: false, error: "Google Sheets sync is disabled or Webhook URL is missing." };
  }

  const projectName = typeof project === "string" ? project : (project?.name || "General");

  const payload = {
    sheetName: gsConfig.sheetName || "Time_Tracking",
    entry: {
      date: entry.date,
      project: projectName,
      description: entry.task,
      time: Number(entry.hours) || 0,
      status: formatStatusForSheet(entry.status)
    }
  };

  try {
    const response = await fetch(cleanUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    return await parseGasResponse(response);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Send multiple entries in bulk to the Google Sheet.
 * @param {Array<object>} entries - Array of entry objects.
 * @param {object} projectsById - Map of projectId -> project object.
 * @param {object} settings - Settings object containing googleSheets config.
 * @returns {Promise<{ ok: boolean, appendedCount?: number, error?: string }>}
 */
export async function syncBatchToSheet(entries, projectsById, settings) {
  const gsConfig = settings?.googleSheets;
  const cleanUrl = cleanWebhookUrl(gsConfig?.webhookUrl);
  if (!gsConfig?.enabled || !cleanUrl) {
    return { ok: false, error: "Google Sheets sync is disabled or Webhook URL is missing." };
  }

  if (!entries || entries.length === 0) {
    return { ok: false, error: "No entries to sync." };
  }

  const formattedEntries = entries.map((e) => {
    const p = projectsById[e.projectId];
    return {
      date: e.date,
      project: p ? p.name : "General",
      description: e.task,
      time: Number(e.hours) || 0,
      status: formatStatusForSheet(e.status)
    };
  });

  const payload = {
    sheetName: gsConfig.sheetName || "Time_Tracking",
    entries: formattedEntries
  };

  try {
    const response = await fetch(cleanUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    });

    return await parseGasResponse(response);
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
