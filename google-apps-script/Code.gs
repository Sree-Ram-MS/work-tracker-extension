/**
 * Daily Work Tracker — Google Apps Script Web App
 * 
 * Automatically logs tasks from your Chrome Extension into your "Time_Tracking" Google Sheet.
 * Features:
 *   - GOOGLE SHEETS TABLES COMPATIBLE: fully supports typed columns, table dropdown chips, and table summary rows.
 *   - DUPLICATE PREVENTION & SMART UPSERT: skips duplicates, updates existing tasks in place.
 *   - TOTAL HOURS SUMMARY PRESERVATION: inserts new rows ABOVE Total Hours; auto-updates =SUM().
 *   - AUTO-ALIGNMENT: center-aligns # SL, Date, Time, and Status.
 *   - EMPTY ROW REUSE: fills existing blank rows left before Total Hours without creating unwanted gaps.
 *   - STATUS RESOLUTION: matches extension status to the sheet's exact dropdown choice (e.g. "In progress" vs "In Progress").
 *   - AUTO-HEALING: fixes missing dropdowns, misaligned cells, misplaced rows, and re-sequences # SL.
 *
 * Sheet Column Layout:
 *   Col A: # SL        (Serial number: 1, 2, 3...) [Center]
 *   Col B: Date        (YYYY-MM-DD)                [Center]
 *   Col C: Project     (e.g., April, Discussion)   [Dropdown Pill]
 *   Col D: Description (Task details)              [Left]
 *   Col E: Time        (Hours decimal: 2, 1.5)     [Center]
 *   Col F: Status      (Completed, In Progress)    [Dropdown Pill, Center]
 */

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOutput({ ok: false, error: "Empty request payload." });
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonOutput({ ok: false, error: "Invalid JSON payload: " + parseErr.message });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var targetSheetName = (payload.sheetName || "Time_Tracking").trim();
    var sheet = ss.getSheetByName(targetSheetName);

    if (!sheet) {
      sheet = ss.getSheets()[0];
    }

    var spreadsheetTz = "";
    try {
      spreadsheetTz = ss.getSpreadsheetTimeZone();
    } catch (tzErr) {}
    if (!spreadsheetTz) {
      try {
        spreadsheetTz = Session.getScriptTimeZone();
      } catch (sessErr) {}
    }
    if (!spreadsheetTz) spreadsheetTz = "GMT";

    // Ping / Test Connection Action: heals sheet & returns status
    if (payload.action === "ping") {
      var healInfo = healSheetLayout(sheet, spreadsheetTz);
      return jsonOutput({
        ok: true,
        message: "Connected successfully to Google Sheet! Layout, alignments, and dropdowns verified.",
        spreadsheetTitle: ss.getName(),
        sheetName: sheet.getName(),
        lastRow: sheet.getLastRow(),
        healed: healInfo
      });
    }

    // Support single entry or array of entries
    var entries = [];
    if (Array.isArray(payload.entries)) {
      entries = payload.entries;
    } else if (payload.entry && typeof payload.entry === "object") {
      entries = [payload.entry];
    } else if (payload.description || payload.task) {
      entries = [payload];
    }

    // Always heal existing sheet structure first
    var healState = healSheetLayout(sheet, spreadsheetTz);

    if (entries.length === 0) {
      return jsonOutput({ ok: true, message: "Sheet healed successfully.", healState: healState });
    }

    var lastDataRow = healState.lastDataRow;
    var totalRowIndex = healState.totalRowIndex;
    var existingRowMap = healState.existingRowMap;

    // Detect dropdown options from the sheet to match casing perfectly
    var statusOptions = getDropdownOptionsForColumn(sheet, 6, 15);
    var projectOptions = getDropdownOptionsForColumn(sheet, 3, 15);

    // Determine starting Serial Number (# SL)
    var nextSl = lastDataRow >= 2 ? lastDataRow : 1;

    // Detect if empty rows already exist between lastDataRow and totalRowIndex
    var existingEmpty = 0;
    if (totalRowIndex > 0 && totalRowIndex > (lastDataRow + 1)) {
      existingEmpty = totalRowIndex - 1 - lastDataRow;
    }

    var writeStartRow = lastDataRow + 1;
    var rowsToAppend = [];
    var updatedCount = 0;
    var skippedCount = 0;

    for (var i = 0; i < entries.length; i++) {
      var item = entries[i];
      var date = normalizeDateStr(item.date, spreadsheetTz) || Utilities.formatDate(new Date(), spreadsheetTz, "yyyy-MM-dd");
      var rawProject = item.project || item.projectName || "General";
      var project = resolveProjectValue(rawProject, projectOptions);
      var description = String(item.description || item.task || "").trim();
      var time = Number(item.time !== undefined ? item.time : item.hours) || 0;
      var rawStatus = item.statusLabel || item.status || "Completed";
      var status = resolveStatusValue(rawStatus, statusOptions);

      var key = makeRowKey(date, project, description);
      var existing = existingRowMap[key];

      if (existing) {
        var statusMatch = String(existing.status).toLowerCase() === String(status).toLowerCase();
        if (existing.time !== time || !statusMatch) {
          sheet.getRange(existing.row, 5).setValue(time);
          sheet.getRange(existing.row, 6).setValue(status);
          safeSetHorizontalAlignment(sheet.getRange(existing.row, 5), "center");
          safeSetHorizontalAlignment(sheet.getRange(existing.row, 6), "center");
          existing.time = time;
          existing.status = status;
          updatedCount++;
        } else {
          skippedCount++;
        }
      } else {
        var sl = nextSl + rowsToAppend.length;
        rowsToAppend.push([sl, date, project, description, time, status]);
        existingRowMap[key] = {
          row: writeStartRow + rowsToAppend.length - 1,
          time: time,
          status: status
        };
      }
    }

    var rowsToInsert = 0;
    var newTotalRow = totalRowIndex;

    if (rowsToAppend.length > 0) {
      // If we need to insert rows before Total, only insert what exceeds existing empty rows
      if (totalRowIndex > 0 && rowsToAppend.length > existingEmpty) {
        rowsToInsert = rowsToAppend.length - existingEmpty;
        try {
          sheet.insertRowsBefore(totalRowIndex, rowsToInsert);
        } catch (insErr) {}
      } else if (totalRowIndex === 0) {
        var requiredRows = writeStartRow + rowsToAppend.length;
        if (requiredRows > sheet.getMaxRows()) {
          try {
            sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows() + 5);
          } catch (expandErr) {}
        }
      }

      var targetRange = sheet.getRange(writeStartRow, 1, rowsToAppend.length, 6);
      var templateRow = (lastDataRow >= 2) ? lastDataRow : 2;

      // Safe format copying (ignores typed columns)
      var sourceTemplate = sheet.getRange(templateRow, 1, 1, 6);
      safeCopyTo(sourceTemplate, targetRange, SpreadsheetApp.CopyPasteType.PASTE_FORMAT);

      // Safe Project dropdown copy
      try {
        var pCell = sheet.getRange(templateRow, 3);
        if (pCell.getDataValidation()) {
          safeCopyTo(pCell, sheet.getRange(writeStartRow, 3, rowsToAppend.length, 1), SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION);
        }
      } catch (pErr) {}

      // Safe Status dropdown copy
      try {
        var sCell = null;
        for (var rCheck = 2; rCheck <= lastDataRow; rCheck++) {
          if (sheet.getRange(rCheck, 6).getDataValidation()) {
            sCell = sheet.getRange(rCheck, 6);
            break;
          }
        }
        var targetStatusRange = sheet.getRange(writeStartRow, 6, rowsToAppend.length, 1);
        if (sCell) {
          safeCopyTo(sCell, targetStatusRange, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION);
        } else if (statusOptions && statusOptions.length > 0) {
          var customRule = SpreadsheetApp.newDataValidation()
            .requireValueInList(statusOptions)
            .build();
          safeSetDataValidation(targetStatusRange, customRule);
        } else {
          var fallbackRule = SpreadsheetApp.newDataValidation()
            .requireValueInList(["Completed", "In Progress", "To Do"])
            .build();
          safeSetDataValidation(targetStatusRange, fallbackRule);
        }
      } catch (sErr) {}

      // Write task data first so values are never lost
      targetRange.setValues(rowsToAppend);

      // Explicitly enforce center alignments safely
      safeSetHorizontalAlignment(sheet.getRange(writeStartRow, 1, rowsToAppend.length, 1), "center");
      safeSetHorizontalAlignment(sheet.getRange(writeStartRow, 2, rowsToAppend.length, 1), "center");
      safeSetHorizontalAlignment(sheet.getRange(writeStartRow, 5, rowsToAppend.length, 1), "center");
      safeSetHorizontalAlignment(sheet.getRange(writeStartRow, 6, rowsToAppend.length, 1), "center");

      var endDataRow = writeStartRow + rowsToAppend.length - 1;
      newTotalRow = totalRowIndex > 0 ? (totalRowIndex + rowsToInsert) : 0;

      // Clean up extra blank rows if existingEmpty exceeded rowsToAppend
      if (newTotalRow > 0 && newTotalRow > (endDataRow + 1)) {
        try {
          var leftover = newTotalRow - (endDataRow + 1);
          sheet.deleteRows(endDataRow + 1, leftover);
          newTotalRow = endDataRow + 1;
        } catch (delLeftoverErr) {}
      }

      // Update Total Hours formula to include all data rows
      if (newTotalRow > 0) {
        try {
          var totalCell = sheet.getRange(newTotalRow, 5);
          totalCell.setFormula("=SUM(E2:E" + endDataRow + ")");
        } catch (formulaErr) {}
      }
    } else if (totalRowIndex > 0) {
      try {
        var totalCellSame = sheet.getRange(totalRowIndex, 5);
        totalCellSame.setFormula("=SUM(E2:E" + lastDataRow + ")");
      } catch (formulaErr2) {}
    }

    return jsonOutput({
      ok: true,
      appendedCount: rowsToAppend.length,
      updatedCount: updatedCount,
      skippedCount: skippedCount,
      startSl: nextSl,
      insertedAtRow: writeStartRow,
      totalRowIndex: newTotalRow > 0 ? newTotalRow : null,
      sheetName: sheet.getName()
    });

  } catch (err) {
    return jsonOutput({
      ok: false,
      error: err.toString()
    });
  }
}

/**
 * Scans the sheet, relocates misplaced Total rows, removes gap rows,
 * re-sequences # SL, enforces center alignments, and safely verifies dropdowns.
 */
function healSheetLayout(sheet, spreadsheetTz) {
  var totalRows = sheet.getLastRow();
  if (totalRows === 0) {
    sheet.appendRow(["# SL", "Date", "Project", "Description", "Time", "Status"]);
    totalRows = 1;
  }

  var existingRowMap = {};
  var lastDataRow = 1;
  var totalRowIndex = 0;
  var totalRowFormula = "";

  if (totalRows > 1) {
    var existingData = sheet.getRange(1, 1, totalRows, 6).getValues();
    var existingFormulas = sheet.getRange(1, 1, totalRows, 6).getFormulas();

    for (var r = 1; r < totalRows; r++) {
      var rowNum = r + 1;
      var rowVals = existingData[r];
      var rowForms = existingFormulas[r];

      if (isTotalRow(rowVals, rowForms)) {
        totalRowIndex = rowNum;
        totalRowFormula = rowForms[4] || "";
        continue;
      }

      var rDate = normalizeDateStr(rowVals[1], spreadsheetTz);
      var rProj = String(rowVals[2] || "").trim();
      var rDesc = String(rowVals[3] || "").trim();

      if (rDate || rDesc) {
        lastDataRow = rowNum;
      }

      if (rDate && rDesc) {
        var key = makeRowKey(rDate, rProj, rDesc);
        existingRowMap[key] = {
          row: rowNum,
          time: Number(rowVals[4]) || 0,
          status: String(rowVals[5] || "").trim()
        };
      }
    }
  }

  // Move misplaced Total row to bottom if data rows were below it
  if (totalRowIndex > 0 && totalRowIndex < lastDataRow) {
    try {
      sheet.insertRowAfter(lastDataRow);
      var newTotalPos = lastDataRow + 1;
      sheet.getRange(totalRowIndex, 1, 1, 6).copyTo(sheet.getRange(newTotalPos, 1, 1, 6));
      sheet.deleteRow(totalRowIndex);

      for (var k in existingRowMap) {
        if (existingRowMap[k].row > totalRowIndex) {
          existingRowMap[k].row -= 1;
        }
      }

      lastDataRow = lastDataRow - 1;
      totalRowIndex = lastDataRow + 1;
    } catch (relocateErr) {}
  }

  // Remove empty gaps before Total row if possible
  if (totalRowIndex > 0 && totalRowIndex > (lastDataRow + 1)) {
    try {
      var blankCount = totalRowIndex - (lastDataRow + 1);
      sheet.deleteRows(lastDataRow + 1, blankCount);
      totalRowIndex = lastDataRow + 1;
    } catch (delGapsErr) {}
  }

  // Heal all data rows: contiguous # SL, center alignments, and status dropdowns
  if (lastDataRow >= 2) {
    var numDataRows = lastDataRow - 1;

    // 1. Re-sequence # SL to be contiguous (1, 2, 3...)
    for (var dr = 2; dr <= lastDataRow; dr++) {
      try {
        sheet.getRange(dr, 1).setValue(dr - 1);
      } catch (slErr) {}
    }

    // 2. Explicitly center-align # SL (Col A), Date (Col B), Time (Col E), and Status (Col F) safely
    safeSetHorizontalAlignment(sheet.getRange(2, 1, numDataRows, 1), "center");
    safeSetHorizontalAlignment(sheet.getRange(2, 2, numDataRows, 1), "center");
    safeSetHorizontalAlignment(sheet.getRange(2, 5, numDataRows, 1), "center");
    safeSetHorizontalAlignment(sheet.getRange(2, 6, numDataRows, 1), "center");

    // 3. Find template status dropdown cell and safely ensure all data rows have it
    try {
      var statusTpl = null;
      for (var sr = 2; sr <= lastDataRow; sr++) {
        if (sheet.getRange(sr, 6).getDataValidation()) {
          statusTpl = sheet.getRange(sr, 6);
          break;
        }
      }

      for (var sr2 = 2; sr2 <= lastDataRow; sr2++) {
        var currentCell = sheet.getRange(sr2, 6);
        if (!currentCell.getDataValidation()) {
          if (statusTpl) {
            safeCopyTo(statusTpl, currentCell, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION);
          } else {
            var rule = SpreadsheetApp.newDataValidation()
              .requireValueInList(["Completed", "In Progress", "To Do"])
              .build();
            safeSetDataValidation(currentCell, rule);
          }
        }
      }
    } catch (dropdownErr) {}
  }

  // Keep Total Hours formula updated to cover all data rows
  if (totalRowIndex > 0) {
    try {
      var totalCell = sheet.getRange(totalRowIndex, 5);
      totalCell.setFormula("=SUM(E2:E" + lastDataRow + ")");
    } catch (totalErr) {}
  }

  return {
    lastDataRow: lastDataRow,
    totalRowIndex: totalRowIndex,
    existingRowMap: existingRowMap
  };
}

/**
 * Detects if a row is a "Total Hours" or summary row.
 */
function isTotalRow(rowValues, rowFormulas) {
  if (!rowValues) return false;
  var colA = String(rowValues[0] || "").trim();
  var colB = String(rowValues[1] || "").trim();
  var colC = String(rowValues[2] || "").trim();
  var colD = String(rowValues[3] || "").trim();
  var colEFormula = (rowFormulas && rowFormulas[4]) ? String(rowFormulas[4]).trim().toUpperCase() : "";
  var colF = String(rowValues[5] || "").trim().toLowerCase();

  // If Status is a normal task status, it is a task row, not a total row
  if (colF === "completed" || colF === "in progress" || colF === "to do" ||
      colF === "hot" || colF === "progress" || colF === "advance" || colF === "doing") {
    return false;
  }

  // Check if colB is a valid task date
  var hasValidDate = (rowValues[1] instanceof Date) || /^\d{4}-\d{2}-\d{2}/.test(colB);

  // Check for total keywords: "total", "total hours", "total time", "grand total", "sum", etc.
  var totalPattern = /\b(total(\s*(hours?|time|hrs?|work\s*hours?))?|grand\s*total|sum)\b/i;
  var hasTotalLabel = totalPattern.test(colA) || totalPattern.test(colB) || totalPattern.test(colC) || totalPattern.test(colD);

  if (hasTotalLabel && !hasValidDate) {
    return true;
  }

  if (/^(total|total\s*hours?|total\s*time|grand\s*total|sum):?$/i.test(colD) ||
      /^(total|total\s*hours?|total\s*time|grand\s*total|sum):?$/i.test(colC) ||
      /^(total|total\s*hours?|total\s*time|grand\s*total|sum):?$/i.test(colA)) {
    return true;
  }

  // If Col E has =SUM(...) formula and no valid task date
  if (/^=SUM\s*\(/i.test(colEFormula) && !hasValidDate) {
    return true;
  }

  return false;
}

/**
 * Normalizes date to YYYY-MM-DD string, respecting spreadsheet timezone and localized formats.
 */
function normalizeDateStr(d, tz) {
  if (!d) return "";
  if (d instanceof Date) {
    try {
      var timeZone = tz || (SpreadsheetApp.getActiveSpreadsheet() ? SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() : Session.getScriptTimeZone());
      return Utilities.formatDate(d, timeZone, "yyyy-MM-dd");
    } catch (e) {
      var yr = d.getFullYear();
      var mo = ("0" + (d.getMonth() + 1)).slice(-2);
      var da = ("0" + d.getDate()).slice(-2);
      return yr + "-" + mo + "-" + da;
    }
  }
  var str = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.slice(0, 10);
  }
  var slashMatch = str.match(/^(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})/);
  if (slashMatch) {
    var p1 = parseInt(slashMatch[1], 10);
    var p2 = parseInt(slashMatch[2], 10);
    var p3 = parseInt(slashMatch[3], 10);
    if (p1 > 1000) {
      return p1 + "-" + ("0" + p2).slice(-2) + "-" + ("0" + p3).slice(-2);
    } else if (p3 > 1000) {
      var parsed = new Date(str);
      if (!isNaN(parsed.getTime())) {
        var yr2 = parsed.getFullYear();
        var mo2 = ("0" + (parsed.getMonth() + 1)).slice(-2);
        var da2 = ("0" + parsed.getDate()).slice(-2);
        return yr2 + "-" + mo2 + "-" + da2;
      }
    }
  }
  return "";
}

/**
 * Unique hash key for upsert matching: date + project + description
 */
function makeRowKey(dateStr, projStr, descStr) {
  var d = String(dateStr || "").trim().toLowerCase();
  var p = String(projStr || "").trim().toLowerCase().replace(/\s+/g, " ");
  var desc = String(descStr || "").trim().toLowerCase().replace(/\s+/g, " ");
  return d + "___" + p + "___" + desc;
}

/**
 * Resolves status string to match the exact casing/wording of the sheet's table dropdown chips.
 */
function resolveStatusValue(rawStatus, sheetOptions) {
  var s = String(rawStatus || "").trim();
  var sLower = s.toLowerCase();

  if (sheetOptions && sheetOptions.length > 0) {
    for (var i = 0; i < sheetOptions.length; i++) {
      if (sheetOptions[i] === s) return sheetOptions[i];
    }
    for (var j = 0; j < sheetOptions.length; j++) {
      if (sheetOptions[j].toLowerCase() === sLower) return sheetOptions[j];
    }
    var cleanInput = sLower.replace(/[\s\-_]/g, "");
    for (var k = 0; k < sheetOptions.length; k++) {
      var opt = sheetOptions[k];
      var optLower = opt.toLowerCase().replace(/[\s\-_]/g, "");
      if (cleanInput === "inprogress" || cleanInput === "progress" || cleanInput === "doing") {
        if (optLower === "inprogress" || optLower === "progress" || optLower === "doing") return opt;
      }
      if (cleanInput === "completed" || cleanInput === "complete" || cleanInput === "done" || cleanInput === "hot") {
        if (optLower === "completed" || optLower === "complete" || optLower === "done") return opt;
      }
      if (cleanInput === "todo" || cleanInput === "to do" || cleanInput === "pending" || cleanInput === "advance") {
        if (optLower === "todo" || optLower === "pending" || optLower === "advance") return opt;
      }
    }
  }

  if (sLower === "completed" || sLower === "hot" || sLower === "done") return "Completed";
  if (sLower === "inprogress" || sLower === "in progress" || sLower === "progress" || sLower === "doing") return "In Progress";
  if (sLower === "todo" || sLower === "to do" || sLower === "advance" || sLower === "pending") return "To Do";

  return s || "Completed";
}

/**
 * Resolves project name against existing dropdown options in the sheet if any.
 */
function resolveProjectValue(rawProject, sheetOptions) {
  var p = String(rawProject || "").trim();
  if (!p) return "General";
  var pLower = p.toLowerCase();
  if (sheetOptions && sheetOptions.length > 0) {
    for (var i = 0; i < sheetOptions.length; i++) {
      if (sheetOptions[i] === p) return sheetOptions[i];
    }
    for (var j = 0; j < sheetOptions.length; j++) {
      if (sheetOptions[j].toLowerCase() === pLower) return sheetOptions[j];
    }
  }
  return p;
}

/**
 * Reads dropdown criteria options from a column in the sheet.
 */
function getDropdownOptionsForColumn(sheet, colIndex, maxRowsToCheck) {
  var options = [];
  var lastRow = Math.min(sheet.getLastRow() || 2, maxRowsToCheck || 10);
  for (var r = 2; r <= lastRow; r++) {
    try {
      var cell = sheet.getRange(r, colIndex);
      var rule = cell.getDataValidation();
      if (rule) {
        var args = rule.getCriteriaValues();
        if (args && args.length > 0) {
          if (Array.isArray(args[0])) {
            for (var i = 0; i < args[0].length; i++) {
              var val = String(args[0][i] || "").trim();
              if (val && options.indexOf(val) === -1) {
                options.push(val);
              }
            }
          } else if (args[0] && typeof args[0].getValues === "function") {
            var rangeVals = args[0].getValues();
            for (var ro = 0; ro < rangeVals.length; ro++) {
              for (var co = 0; co < rangeVals[ro].length; co++) {
                var rv = String(rangeVals[ro][co] || "").trim();
                if (rv && options.indexOf(rv) === -1) {
                  options.push(rv);
                }
              }
            }
          }
        }
        if (options.length > 0) return options;
      }
    } catch (e) {}
  }
  return options;
}

/**
 * Safe wrapper for setDataValidation that ignores "typed columns" exceptions.
 */
function safeSetDataValidation(range, rule) {
  try {
    range.setDataValidation(rule);
  } catch (e) {}
}

/**
 * Safe wrapper for copyTo that ignores typed column errors.
 */
function safeCopyTo(sourceRange, targetRange, copyPasteType) {
  try {
    sourceRange.copyTo(targetRange, copyPasteType, false);
  } catch (e) {}
}

/**
 * Safe wrapper for setHorizontalAlignment that ignores locked format errors.
 */
function safeSetHorizontalAlignment(range, alignment) {
  try {
    range.setHorizontalAlignment(alignment);
  } catch (e) {}
}

function doGet(e) {
  return jsonOutput({
    ok: true,
    status: "active",
    message: "Daily Work Tracker Webhook is online. Send POST requests to log entries."
  });
}

function jsonOutput(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Quick Authorization & Test Function:
 * Run this directly from the Apps Script editor (select "testRun" from the function list and click "Run ▶")
 * to authorize permissions and verify that your sheet is ready.
 */
function testRun() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Time_Tracking") || ss.getSheets()[0];
  var tz = "";
  try { tz = ss.getSpreadsheetTimeZone(); } catch (e) {}
  if (!tz) { try { tz = Session.getScriptTimeZone(); } catch (e2) {} }
  if (!tz) tz = "GMT";

  var result = healSheetLayout(sheet, tz);
  Logger.log("✅ Success! Sheet layout healed. Result: " + JSON.stringify(result));
  return result;
}

