// ============================================================
// EXPORT.JS — Excel export via ExcelJS (loaded globally as ExcelJS)
// One .xlsx per student: a Summary sheet + one sheet per target.
// ============================================================

import { getAllSessionsForStudent, getAllSessionsForGroup, sanitizeKey } from "./firebase-service.js";

// Strip HTML tags from remark text (stored as HTML for visual bold support)
function stripRemarkHtml(s) {
  return (s || "").replace(/<[^>]*>/g, "");
}

function matchesPa(a, pa) {
  if (a.configId && pa.id) return a.configId === pa.id;
  return a.activityName === pa.name;
}

// ─── STYLE CONSTANTS ─────────────────────────────────────────
// Palette: Bright Periwinkle — cheerful, child-friendly, single-hue graduated
//
// Visual hierarchy (saturated → near-white):
//   Monthly  ──► Bright periwinkle  #5B8EC4  ← clear top anchor
//   Session  ──► Medium periwinkle  #A8C8E8  ← section break
//   Col hdr  ──► Light periwinkle   #C8DFF2  ← label row
//   Act hdg  ──► Pale periwinkle    #E4F0F8  ← subtle section
//   Daily avg──► Near-white blue    #F2F7FC  ← unobtrusive summary
//
// All fonts dark navy for maximum readability on every light fill.
//
// Monthly header: light warm gray, pure black text
const STYLE_MONTH = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } },
  font: { bold: true, size: 12, color: { argb: "FF000000" } },
  alignment: { horizontal: "center", vertical: "middle" }
};
// Session header: medium periwinkle, pure black text
const STYLE_SESSION = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFA8C8E8" } },
  font: { bold: true, color: { argb: "FF000000" } },
  alignment: { horizontal: "center", vertical: "middle" }
};
// Column header: light periwinkle, pure black text
const STYLE_COL_HEADER = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFC8DFF2" } },
  font: { bold: true, color: { argb: "FF000000" } },
  alignment: { horizontal: "center", vertical: "middle" }
};
// Activity section heading: pale periwinkle, muted navy text
const STYLE_ACT_HEADING = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE4F0F8" } },
  font: { bold: true, color: { argb: "FF2A4060" } }
};
// Daily Average: near-white blue, soft navy text
const STYLE_DAILY_AVG = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F7FC" } },
  font: { bold: true, italic: true, color: { argb: "FF3A5470" } }
};
// Reference note: soft warm cream, warm amber text
const STYLE_NOTE = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF8ED" } },
  font: { italic: true, color: { argb: "FF7A5030" } }
};
// Activity cell with an attached note: name on its own line, note italicized below it
function richTextActivityWithNote(name, note) {
  return {
    richText: [
      { text: name },
      { text: `\nNote: ${note}`, font: STYLE_NOTE.font }
    ]
  };
}
// Thin border: soft periwinkle-gray for summary sheets
const CELL_BORDER = {
  top:    { style: "thin", color: { argb: "FFB0C8E0" } },
  left:   { style: "thin", color: { argb: "FFB0C8E0" } },
  bottom: { style: "thin", color: { argb: "FFB0C8E0" } },
  right:  { style: "thin", color: { argb: "FFB0C8E0" } },
};
// Target sheet palette: neutral gray matching user's Excel theme (White Darker 25% / 15%)
const STYLE_TARGET_MONTH = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFBFBFBF" } },
  font: { bold: true, size: 12, color: { argb: "FF000000" } },
  alignment: { horizontal: "center", vertical: "middle" }
};
const STYLE_TARGET_COLHDR = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } },
  font: { bold: true, color: { argb: "FF000000" } },
  alignment: { horizontal: "center", vertical: "middle" }
};
const TARGET_CELL_BORDER = {
  top:    { style: "thin", color: { argb: "FFD9D9D9" } },
  left:   { style: "thin", color: { argb: "FFD9D9D9" } },
  bottom: { style: "thin", color: { argb: "FFD9D9D9" } },
  right:  { style: "thin", color: { argb: "FFD9D9D9" } },
};

// ─── PUBLIC ENTRY POINT ──────────────────────────────────────

function getAllTargets(student) {
  return student.targets || [];
}

// ── Shared sheets (entity-agnostic: work identically for a student or a group) ──

function addSummarySheets(wb, allTargets, sessions) {
  // ── Monthly Summary ──────────────────────────────────────────
  const summaryRows = buildSummarySheet(allTargets, sessions);
  const summaryWs   = wb.addWorksheet("Monthly Summary");
  summaryRows.forEach(row => summaryWs.addRow(row));
  summaryWs.getColumn(1).width = 30;
  const summaryMaxCols = summaryRows[0]?.length || 1;
  for (let c = 2; c <= summaryMaxCols; c++) summaryWs.getColumn(c).width = 12;
  summaryWs.getColumn(1).alignment = { vertical: "middle" };
  for (let c = 2; c <= summaryMaxCols; c++) {
    summaryWs.getColumn(c).alignment = { horizontal: "center", vertical: "middle" };
  }
  // Style header row (row 1: Target | Month names)
  for (let c = 1; c <= summaryMaxCols; c++) {
    const cell = summaryWs.getRow(1).getCell(c);
    cell.fill      = STYLE_COL_HEADER.fill;
    cell.font      = STYLE_COL_HEADER.font;
    cell.alignment = STYLE_COL_HEADER.alignment;
  }
  applyBorders(summaryWs, summaryMaxCols);

  // ── Detailed Summary ─────────────────────────────────────────
  const { rows: detRows, monthHeaderRows: detMonthHdrs, colHeaderRows: detColHdrs, amberCells } =
    buildDetailedSummarySheet(allTargets, sessions);
  const detWs = wb.addWorksheet("Detailed Summary");
  detRows.forEach(row => detWs.addRow(row));
  detWs.getColumn(1).width = 30;
  const detMaxCols = Math.max(...detRows.map(r => r.length), 1);
  for (let c = 2; c <= detMaxCols; c++) detWs.getColumn(c).width = 12;
  detWs.getColumn(1).alignment = { vertical: "middle" };
  for (let c = 2; c <= detMaxCols; c++) {
    detWs.getColumn(c).alignment = { horizontal: "center", vertical: "middle" };
  }
  for (const rowIdx of detMonthHdrs) {
    const n = rowIdx + 1;
    for (let c = 1; c <= detMaxCols; c++) {
      const cell = detWs.getRow(n).getCell(c);
      cell.fill = STYLE_MONTH.fill;
      cell.font = STYLE_MONTH.font;
    }
  }
  for (const rowIdx of detColHdrs) {
    const n = rowIdx + 1;
    for (let c = 1; c <= detMaxCols; c++) {
      const cell = detWs.getRow(n).getCell(c);
      cell.fill = STYLE_COL_HEADER.fill;
      cell.font = STYLE_COL_HEADER.font;
      cell.alignment = STYLE_COL_HEADER.alignment;
    }
  }
  for (const { rowIdx, col } of amberCells) {
    const cell = detWs.getRow(rowIdx + 1).getCell(col);
    cell.fill = STYLE_DAILY_AVG.fill;
    cell.font = STYLE_DAILY_AVG.font;
    cell.alignment = { horizontal: "center" };
  }
  mergeAndCenterRows(detWs, detMonthHdrs, detMaxCols);
  applyBorders(detWs, detMaxCols);
}

// ── Single-session export: Daily Summary (Target + that day's score only) ──
function addDailySummarySheet(wb, entityName, allTargets, session) {
  const rows = [
    [`${entityName}: Daily Summary — ${fmtDate(session.date)}`, ""],
    ["Target", "Score"]
  ];
  for (const target of allTargets) {
    const snap   = (session.targetsSnapshot || []).find(t => t.name === target.name);
    const eff    = snap ? { ...target, maxPoints: snap.maxPoints } : target;
    const dayAvg = calcDailyAverage(session, eff);
    rows.push([target.name, dayAvg !== null ? pct(dayAvg) : ""]);
  }

  const ws = wb.addWorksheet("Daily Summary");
  rows.forEach(row => ws.addRow(row));
  ws.getColumn(1).width     = 36;
  ws.getColumn(2).width     = 16;
  ws.getColumn(1).alignment = { vertical: "middle" };
  ws.getColumn(2).alignment = { horizontal: "center", vertical: "middle" };

  try { ws.mergeCells("A1:B1"); } catch (_) {}
  const title     = ws.getRow(1).getCell(1);
  title.fill      = STYLE_SESSION.fill;
  title.font      = STYLE_SESSION.font;
  title.alignment = { horizontal: "center", vertical: "middle" };
  fitTitleRow(ws, 1, 52);

  for (let c = 1; c <= 2; c++) {
    const cell     = ws.getRow(2).getCell(c);
    cell.fill      = STYLE_COL_HEADER.fill;
    cell.font      = STYLE_COL_HEADER.font;
    cell.alignment = STYLE_COL_HEADER.alignment;
  }

  applyBorders(ws, 2);
}

function targetHasDataInSession(target, session) {
  const actIds = new Set(
    Object.entries(session.activities || {})
      .filter(([, a]) => a.targetName === target.name)
      .map(([id]) => id)
  );
  return Object.values(session.remarks || {}).some(r => actIds.has(r.activityId));
}

// Union of targets across every group a student belongs to (first occurrence by name wins)
function unionTargetsByName(groups) {
  const allTargets = [];
  const seenNames  = new Set();
  for (const group of groups) {
    for (const t of (group.targets || [])) {
      if (!seenNames.has(t.name)) { seenNames.add(t.name); allTargets.push(t); }
    }
  }
  return allTargets;
}

function addBaselineVsCurrentSheet(wb, entityName, allTargets, sortedSessions) {
  if (sortedSessions.length < 2 ||
      sortedSessions[0].date === sortedSessions[sortedSessions.length - 1].date) return;

  const firstSession = sortedSessions[0];
  const lastSession  = sortedSessions[sortedSessions.length - 1];
  const firstLabel   = fmtDate(firstSession.date);
  const lastLabel    = fmtDate(lastSession.date);

  const bvcRows    = [];
  const bvcTargets = [];

  bvcRows.push([`${entityName}: Baseline vs Current`, "", ""]);
  bvcRows.push(["Target", firstLabel, lastLabel]);

  for (const target of allTargets) {
    const snapF  = (firstSession.targetsSnapshot || []).find(t => t.name === target.name);
    const effF   = snapF ? { ...target, maxPoints: snapF.maxPoints } : target;
    const snapL  = (lastSession.targetsSnapshot  || []).find(t => t.name === target.name);
    const effL   = snapL ? { ...target, maxPoints: snapL.maxPoints } : target;
    const scoreF = calcDailyAverage(firstSession, effF);
    const scoreL = calcDailyAverage(lastSession,  effL);

    bvcRows.push([
      target.name,
      scoreF !== null ? pct(scoreF) : "",
      scoreL !== null ? pct(scoreL) : ""
    ]);
    bvcTargets.push({
      name:  target.name,
      first: scoreF !== null ? Math.round(scoreF) : null,
      last:  scoreL !== null ? Math.round(scoreL) : null
    });
  }

  const bvcWs = wb.addWorksheet("Baseline vs Current");
  bvcRows.forEach(row => bvcWs.addRow(row));

  bvcWs.getColumn(1).width     = 30;
  bvcWs.getColumn(2).width     = 14;
  bvcWs.getColumn(3).width     = 14;
  bvcWs.getColumn(1).alignment = { vertical: "middle" };
  bvcWs.getColumn(2).alignment = { horizontal: "center", vertical: "middle" };
  bvcWs.getColumn(3).alignment = { horizontal: "center", vertical: "middle" };

  try { bvcWs.mergeCells("A1:C1"); } catch (_) {}
  const bvcTitle     = bvcWs.getRow(1).getCell(1);
  bvcTitle.fill      = STYLE_SESSION.fill;
  bvcTitle.font      = STYLE_SESSION.font;
  bvcTitle.alignment = { horizontal: "center", vertical: "middle" };

  for (let c = 1; c <= 3; c++) {
    const cell     = bvcWs.getRow(2).getCell(c);
    cell.fill      = STYLE_COL_HEADER.fill;
    cell.font      = STYLE_COL_HEADER.font;
    cell.alignment = STYLE_COL_HEADER.alignment;
  }

  applyBorders(bvcWs, 3);

  if (typeof Chart !== "undefined") {
    const chartTargets = bvcTargets.filter(t => t.first !== null || t.last !== null);
    if (chartTargets.length > 0) {
      const bvcBase64 = renderBaselineChart(
        `${entityName}: Baseline vs Current`,
        chartTargets.map(t => wrapLabel(t.name)),
        chartTargets.map(t => t.first),
        chartTargets.map(t => t.last),
        firstLabel,
        lastLabel
      );
      const bvcImgId = wb.addImage({ base64: bvcBase64, extension: "png" });
      bvcWs.addImage(bvcImgId, {
        tl:  { col: 0, row: bvcRows.length + 1 },
        ext: { width: 605, height: 340 } // 16cm x 9cm at 96dpi
      });
    }
  }
}

function addChartsSheet(wb, allTargets, sortedSessions) {
  if (typeof Chart === "undefined") return;

  const chartsWs = wb.addWorksheet("Charts");
  let chartIdx = 0;

  for (const target of allTargets) {
    const yValues = [];
    const datesWithData = [];
    for (const session of sortedSessions) {
      const snap  = (session.targetsSnapshot || []).find(t => t.name === target.name);
      const eff   = snap ? { ...target, maxPoints: snap.maxPoints } : target;
      const score = calcDailyAverage(session, eff);
      if (score !== null) { yValues.push(Math.round(score)); datesWithData.push(session.date); }
    }
    if (yValues.length < 2) { chartIdx++; continue; }

    const dateRange = formatDateRange(datesWithData);
    const base64 = renderTargetChart(target.name, yValues, dateRange, datesWithData);
    const imgId  = wb.addImage({ base64, extension: "png" });

    const chartRow = Math.floor(chartIdx / 2) * 19;
    const chartCol = (chartIdx % 2) * 11;

    chartsWs.addImage(imgId, {
      tl:  { col: chartCol, row: chartRow },
      ext: { width: 605, height: 340 } // 16cm x 9cm at 96dpi
    });
    chartIdx++;
  }
}

function addIndividualTargetSheets(wb, allTargets, sessions, studentName) {
  for (const target of allTargets) {
    const { rows, monthHeaderRows, colHeaderRows, activityHeadingRows, noteRows, sessionDateBlocks, spacerRows } =
      buildTargetSheet(target, sessions);
    const ws = wb.addWorksheet(target.name.slice(0, 31));
    rows.forEach(row => ws.addRow(row));

    // Col widths: Date | Activity | Remark | Score | Avg Score
    ws.getColumn(1).width     = 6.33;
    ws.getColumn(2).width     = 40.89;
    ws.getColumn(3).width     = 62;
    ws.getColumn(4).width     = 6.78;
    ws.getColumn(5).width     = 8.56;
    ws.getColumn(1).alignment = { horizontal: "center", vertical: "top" };
    ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
    ws.getColumn(3).alignment = { wrapText: true, vertical: "top" };
    ws.getColumn(4).alignment = { horizontal: "center", vertical: "top" };
    ws.getColumn(5).alignment = { horizontal: "center", vertical: "top" };

    // Month headers: merge A:E, White Darker 25%, bold black
    for (const rowIdx of monthHeaderRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`A${n}:E${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(1);
      cell.fill      = STYLE_TARGET_MONTH.fill;
      cell.font      = STYLE_TARGET_MONTH.font;
      cell.alignment = STYLE_TARGET_MONTH.alignment;
    }

    // Column headers: White Darker 15%, bold black
    for (const rowIdx of colHeaderRows) {
      const n = rowIdx + 1;
      for (let c = 1; c <= 5; c++) {
        const cell = ws.getRow(n).getCell(c);
        cell.fill      = STYLE_TARGET_COLHDR.fill;
        cell.font      = STYLE_TARGET_COLHDR.font;
        cell.alignment = STYLE_TARGET_COLHDR.alignment;
      }
    }

    // Activity heading rows: merge B:D (leave E free for the avg-score column merge)
    for (const rowIdx of activityHeadingRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`B${n}:D${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(2);
      cell.fill      = STYLE_ACT_HEADING.fill;
      cell.font      = STYLE_ACT_HEADING.font;
      cell.alignment = { vertical: "top" };
    }

    // Note rows: merge B:D (leave E free for the avg-score column merge)
    for (const rowIdx of noteRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`B${n}:D${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(2);
      cell.fill      = STYLE_NOTE.fill;
      cell.font      = STYLE_NOTE.font;
      cell.alignment = { wrapText: true, vertical: "top" };
      const text = (cell.value || "").toString();
      const visLines = text.split("\n").reduce((sum, seg) =>
        sum + Math.max(1, Math.ceil((seg.length || 1) / 90)), 0);
      ws.getRow(n).height = Math.max(18, visLines * 15);
    }

    // Session date blocks: col A = date (top+center), col E = avg score (middle+center)
    for (const { startRow, endRow, dateLabel, avgScore } of sessionDateBlocks) {
      const startN = startRow + 1;
      const endN   = endRow + 1;
      if (startN < endN) {
        try { ws.mergeCells(`A${startN}:A${endN}`); } catch (_) {}
        try { ws.mergeCells(`E${startN}:E${endN}`); } catch (_) {}
      }
      const dateCell = ws.getRow(startN).getCell(1);
      dateCell.value     = dateLabel;
      dateCell.alignment = { horizontal: "center", vertical: "top" };

      const avgCell = ws.getRow(startN).getCell(5);
      avgCell.value     = avgScore;
      avgCell.font      = { color: { argb: "FF000000" } };
      avgCell.alignment = { horizontal: "center", vertical: "top" };
    }

    // Footer: company left | target name centre | page number right
    ws.headerFooter.oddFooter = `&LZORA Behavioural Intervention&C${target.name}  —  ${studentName}&R&P`;

    // Borders: White Darker 15% (#D9D9D9) — skip blank spacer rows
    ws.eachRow((row, rowNumber) => {
      if (spacerRows.has(rowNumber - 1)) return;
      for (let c = 1; c <= 5; c++) row.getCell(c).border = TARGET_CELL_BORDER;
    });
  }
}

async function buildStudentWorkbook(student, sessions) {
  // Drop ghost sessions: activities are auto-created on target selection even without data entry.
  // A session only counts as real once at least one remark (which carries trial scores) exists.
  sessions = sessions.filter(s => Object.keys(s.remarks || {}).length > 0);

  const allTargets = getAllTargets(student).slice().sort((a, b) => a.name.localeCompare(b.name));
  const wb = new ExcelJS.Workbook();
  const sortedSessions = sessions.slice().sort((a, b) => a.date.localeCompare(b.date));

  addSummarySheets(wb, allTargets, sessions);
  addBaselineVsCurrentSheet(wb, student.name, allTargets, sortedSessions);
  addChartsSheet(wb, allTargets, sortedSessions);
  addIndividualTargetSheets(wb, allTargets, sessions, student.name);

  return wb.xlsx.writeBuffer();
}

// Builds a workbook for ONE student's slice of their group sessions, formatted
// identically to an individual student export (no Student column — every
// session here has already been filtered down to just this student's remarks).
async function buildGroupMemberWorkbook(studentName, allTargets, sessions) {
  const filtered = sessions
    .map(s => ({
      ...s,
      remarks: Object.fromEntries(
        Object.entries(s.remarks || {}).filter(([, r]) => r.studentName === studentName)
      )
    }))
    .filter(s => Object.keys(s.remarks).length > 0);

  const sortedTargets  = allTargets.slice().sort((a, b) => a.name.localeCompare(b.name));
  const wb              = new ExcelJS.Workbook();
  const sortedSessions  = filtered.slice().sort((a, b) => a.date.localeCompare(b.date));

  addSummarySheets(wb, sortedTargets, filtered);
  addBaselineVsCurrentSheet(wb, studentName, sortedTargets, sortedSessions);
  addChartsSheet(wb, sortedTargets, sortedSessions);
  addIndividualTargetSheets(wb, sortedTargets, filtered, studentName);

  return wb.xlsx.writeBuffer();
}

// Filename format: "{Name} - {Individual/Group Session} - {dd.mm.yyyy} - {hh-mm}.xlsx"
// Date/time always reflect the moment of export, not any session date.
function formatExportFilename(name, sessionType, now) {
  const dd   = String(now.getDate()).padStart(2, "0");
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hh   = String(now.getHours()).padStart(2, "0");
  const min  = String(now.getMinutes()).padStart(2, "0");
  return `${name} - ${sessionType} - ${dd}.${mm}.${yyyy} - ${hh}-${min}.xlsx`;
}

export async function exportStudentData(student) {
  if (!student) return;

  const sessions = await getAllSessionsForStudent(student.id);
  if (sessions.length === 0) {
    alert("No session data found for " + student.name);
    return;
  }

  const now    = new Date();
  const buffer = await buildStudentWorkbook(student, sessions);
  const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = formatExportFilename(student.name, "Individual Session", now);
  a.click();
  URL.revokeObjectURL(url);
}

// Exports one student's data across every group session they attended (possibly
// across multiple groups). Formatted exactly like an individual session export.
export async function exportGroupMemberData(studentName, groups) {
  if (!studentName || !groups?.length) return;

  let sessions = [];
  for (const group of groups) {
    sessions.push(...await getAllSessionsForGroup(group.id));
  }
  if (sessions.length === 0) {
    alert("No session data found for " + studentName);
    return;
  }

  const allTargets = unionTargetsByName(groups);

  const now    = new Date();
  const buffer = await buildGroupMemberWorkbook(studentName, allTargets, sessions);
  const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = formatExportFilename(studentName, "Group Session", now);
  a.click();
  URL.revokeObjectURL(url);
}

// ── Single-session export (one specific day) ─────────────────
// Much lighter than the full export: just two sheets — one combined sheet with
// every target's data for that day, and a Daily Summary table — no monthly or
// detailed summary, no per-target sheets, no baseline-vs-current, no charts.

function buildCombinedSessionRows(allTargets, session, entityName) {
  const rows                = [];
  const targetHeaderRows    = new Set();
  const colHeaderRows       = new Set();
  const activityHeadingRows = new Set();
  const noteRows            = new Set();
  const sessionDateBlocks   = [];
  const spacerRows          = new Set();

  const titleRow = rows.length;
  rows.push([`${entityName} — Session Note — ${fmtDate(session.date)}`, "", "", "", ""]);
  spacerRows.add(rows.length);
  rows.push(["", "", "", "", ""]);

  for (const target of allTargets) {
    if (!targetHasDataInSession(target, session)) continue;

    const snap   = (session.targetsSnapshot || []).find(t => t.name === target.name);
    const eff    = snap ? { ...target, maxPoints: snap.maxPoints } : target;
    const dayAvg = calcDailyAverage(session, eff);

    if (targetHeaderRows.size > 0) { spacerRows.add(rows.length); rows.push(["", "", "", "", ""]); }

    targetHeaderRows.add(rows.length);
    rows.push([`${target.name}  —  Score: ${dayAvg !== null ? pct(dayAvg) : "N/A"}`, "", "", "", ""]);

    colHeaderRows.add(rows.length);
    rows.push(["Date", "Activity", "Remark", "Score", "Avg Score"]);

    appendSessionRows(rows, sessionDateBlocks, activityHeadingRows, noteRows, session, eff);
  }

  return { rows, titleRow, targetHeaderRows, colHeaderRows, activityHeadingRows, noteRows, sessionDateBlocks, spacerRows };
}

// One sheet combining every target's data for the single exported day
// (mirrors addIndividualTargetSheets' styling, but per-target header blocks
// instead of per-target sheets).
function addCombinedSessionSheet(wb, allTargets, session, entityName) {
  const { rows, titleRow, targetHeaderRows, colHeaderRows, activityHeadingRows, noteRows, sessionDateBlocks, spacerRows } =
    buildCombinedSessionRows(allTargets, session, entityName);

  const ws = wb.addWorksheet("Session Note");
  rows.forEach(row => ws.addRow(row));

  ws.getColumn(1).width     = 6.33;
  ws.getColumn(2).width     = 40.89;
  ws.getColumn(3).width     = 62;
  ws.getColumn(4).width     = 6.78;
  ws.getColumn(5).width     = 8.56;
  ws.getColumn(1).alignment = { horizontal: "center", vertical: "top" };
  ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  ws.getColumn(3).alignment = { wrapText: true, vertical: "top" };
  ws.getColumn(4).alignment = { horizontal: "center", vertical: "top" };
  ws.getColumn(5).alignment = { horizontal: "center", vertical: "top" };

  {
    const n = titleRow + 1;
    try { ws.mergeCells(`A${n}:E${n}`); } catch (_) {}
    const cell = ws.getRow(n).getCell(1);
    cell.fill      = STYLE_TARGET_MONTH.fill;
    cell.font      = STYLE_TARGET_MONTH.font;
    cell.alignment = { horizontal: "center", vertical: "middle" };
    fitTitleRow(ws, n, 110);
  }

  for (const rowIdx of targetHeaderRows) {
    const n = rowIdx + 1;
    try { ws.mergeCells(`A${n}:E${n}`); } catch (_) {}
    const cell = ws.getRow(n).getCell(1);
    cell.fill      = STYLE_TARGET_MONTH.fill;
    cell.font      = STYLE_TARGET_MONTH.font;
    cell.alignment = STYLE_TARGET_MONTH.alignment;
  }

  for (const rowIdx of colHeaderRows) {
    const n = rowIdx + 1;
    for (let c = 1; c <= 5; c++) {
      const cell = ws.getRow(n).getCell(c);
      cell.fill      = STYLE_TARGET_COLHDR.fill;
      cell.font      = STYLE_TARGET_COLHDR.font;
      cell.alignment = STYLE_TARGET_COLHDR.alignment;
    }
  }

  for (const rowIdx of activityHeadingRows) {
    const n = rowIdx + 1;
    try { ws.mergeCells(`B${n}:D${n}`); } catch (_) {}
    const cell = ws.getRow(n).getCell(2);
    cell.fill      = STYLE_ACT_HEADING.fill;
    cell.font      = STYLE_ACT_HEADING.font;
    cell.alignment = { vertical: "top" };
  }

  for (const rowIdx of noteRows) {
    const n = rowIdx + 1;
    try { ws.mergeCells(`B${n}:D${n}`); } catch (_) {}
    const cell = ws.getRow(n).getCell(2);
    cell.fill      = STYLE_NOTE.fill;
    cell.font      = STYLE_NOTE.font;
    cell.alignment = { wrapText: true, vertical: "top" };
    const text = (cell.value || "").toString();
    const visLines = text.split("\n").reduce((sum, seg) =>
      sum + Math.max(1, Math.ceil((seg.length || 1) / 90)), 0);
    ws.getRow(n).height = Math.max(18, visLines * 15);
  }

  for (const { startRow, endRow, dateLabel, avgScore } of sessionDateBlocks) {
    const startN = startRow + 1;
    const endN   = endRow + 1;
    if (startN < endN) {
      try { ws.mergeCells(`A${startN}:A${endN}`); } catch (_) {}
      try { ws.mergeCells(`E${startN}:E${endN}`); } catch (_) {}
    }
    const dateCell = ws.getRow(startN).getCell(1);
    dateCell.value     = dateLabel;
    dateCell.alignment = { horizontal: "center", vertical: "top" };

    const avgCell = ws.getRow(startN).getCell(5);
    avgCell.value     = avgScore;
    avgCell.font      = { color: { argb: "FF000000" } };
    avgCell.alignment = { horizontal: "center", vertical: "top" };
  }

  ws.headerFooter.oddFooter = `&LZORA Behavioural Intervention&C${entityName}&R&P`;

  ws.eachRow((row, rowNumber) => {
    if (spacerRows.has(rowNumber - 1)) return;
    for (let c = 1; c <= 5; c++) row.getCell(c).border = TARGET_CELL_BORDER;
  });
}

async function buildSingleSessionWorkbook(entityName, allTargets, session) {
  const sortedTargets = allTargets.slice().sort((a, b) => a.name.localeCompare(b.name));
  const wb = new ExcelJS.Workbook();

  addCombinedSessionSheet(wb, sortedTargets, session, entityName);
  addDailySummarySheet(wb, entityName, sortedTargets, session);

  return wb.xlsx.writeBuffer();
}

export async function exportStudentSingleSession(student, session) {
  if (!student || !session) return;

  const allTargets = getAllTargets(student);
  const buffer = await buildSingleSessionWorkbook(student.name, allTargets, session);
  const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = formatExportFilename(student.name, "Individual Session", new Date());
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportGroupMemberSingleSession(studentName, groups, session) {
  if (!studentName || !groups?.length || !session) return;

  const filteredRemarks = Object.fromEntries(
    Object.entries(session.remarks || {}).filter(([, r]) => r.studentName === studentName)
  );
  if (Object.keys(filteredRemarks).length === 0) {
    alert(`No session data found for ${studentName} on ${fmtDate(session.date)}.`);
    return;
  }

  const allTargets    = unionTargetsByName(groups);
  const entityName     = `${studentName} (Group)`;
  const filteredSession = { ...session, remarks: filteredRemarks };
  const buffer = await buildSingleSessionWorkbook(entityName, allTargets, filteredSession);
  const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = formatExportFilename(studentName, "Group Session", new Date());
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportAllStudents(students) {
  if (!students || students.length === 0) return;

  const zip = new JSZip();
  const now = new Date();
  let exported = 0;

  for (const student of students) {
    const sessions = await getAllSessionsForStudent(student.id);
    if (sessions.length === 0) continue;
    const buffer = await buildStudentWorkbook(student, sessions);
    zip.file(formatExportFilename(student.name, "Individual Session", now), buffer);
    exported++;
  }

  if (exported === 0) {
    alert("No session data found for any student.");
    return;
  }

  const monNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dd   = String(now.getDate()).padStart(2, "0");
  const mon  = monNames[now.getMonth()];
  const yyyy = now.getFullYear();
  const zipBlob = await zip.generateAsync({ type: "blob" });
  const url     = URL.createObjectURL(zipBlob);
  const a       = document.createElement("a");
  a.href        = url;
  a.download    = `All_Students_${dd}-${mon}-${yyyy}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── STYLE HELPER ────────────────────────────────────────────

function applyRowStyles(ws, rowIndices, style, numCols = 4) {
  for (const rowIdx of rowIndices) {
    const row = ws.getRow(rowIdx + 1);
    for (let c = 1; c <= numCols; c++) {
      const cell = row.getCell(c);
      if (style.fill)      cell.fill      = style.fill;
      if (style.font)      cell.font      = style.font;
      if (style.alignment) cell.alignment = style.alignment;
    }
  }
}

// Wraps a merged title cell and grows its row height so long titles (e.g. a
// long student name) never get clipped instead of just sizing for the common case.
function fitTitleRow(ws, rowNumber, totalColWidth) {
  const cell = ws.getRow(rowNumber).getCell(1);
  cell.alignment = { ...cell.alignment, wrapText: true };
  const text = (cell.value || "").toString();
  const visLines = Math.max(1, Math.ceil(text.length / totalColWidth));
  ws.getRow(rowNumber).height = Math.max(20, visLines * 18);
}

// Apply thin borders to every cell in the used range for print readability
function applyBorders(ws, numCols) {
  ws.eachRow(row => {
    for (let c = 1; c <= numCols; c++) {
      row.getCell(c).border = CELL_BORDER;
    }
  });
}

// Give session header rows a slightly taller height so they stand out
function applySessionRowHeights(ws, sessionHeaderRowIndices) {
  for (const rowIdx of sessionHeaderRowIndices) {
    ws.getRow(rowIdx + 1).height = 22;
  }
}

// Merge a set of rows across numCols columns and force centered alignment
function mergeAndCenterRows(ws, rowIndices, numCols) {
  const colLetter = String.fromCharCode(64 + numCols); // e.g. 4 → 'D'
  for (const rowIdx of rowIndices) {
    const n = rowIdx + 1;
    try { ws.mergeCells(`A${n}:${colLetter}${n}`); } catch (_) {}
    const cell = ws.getRow(n).getCell(1);
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: false };
  }
}

// ─── SUMMARY SHEET ───────────────────────────────────────────

function buildSummarySheet(allTargets, sessions) {
  const monthSet = new Set(sessions.map(s => s.month));
  const months   = [...monthSet].sort((a, b) => {
    const [ma, ya] = parseMonth(a);
    const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });

  const rows = [];
  rows.push(["Target", ...months]);

  for (const target of allTargets) {
    const row = [target.name];
    for (const month of months) {
      const monthSessions = sessions.filter(s => s.month === month);
      const dailyAvgs = monthSessions
        .map(s => {
          const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
          const eff  = snap ? { ...target, maxPoints: snap.maxPoints } : target;
          return calcDailyAverage(s, eff);
        })
        .filter(v => v !== null);
      row.push(dailyAvgs.length > 0 ? pct(avg(dailyAvgs)) : "");
    }
    rows.push(row);
  }

  return rows;
}

// ─── DETAILED SUMMARY SHEET ──────────────────────────────────
// Rows = targets, columns = individual session dates (grouped by month).
// Last column of each month block = Monthly Avg.

function buildDetailedSummarySheet(allTargets, sessions) {
  const months = [...new Set(sessions.map(s => s.month))].sort((a, b) => {
    const [ma, ya] = parseMonth(a);
    const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });

  const rows = [];
  const monthHeaderRows = new Set();
  const colHeaderRows   = new Set();
  const amberCells      = []; // {rowIdx, col} — Monthly Avg header + data cells

  let firstMonth = true;
  for (const month of months) {
    const monthSessions = sessions
      .filter(s => s.month === month)
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!firstMonth) rows.push([]);
    firstMonth = false;

    monthHeaderRows.add(rows.length);
    rows.push([month]);

    const avgColIdx = 1 + monthSessions.length + 1; // 1-indexed column for Monthly Avg

    colHeaderRows.add(rows.length);
    rows.push(["Target", ...monthSessions.map(s => fmtDate(s.date)), "Monthly Avg"]);

    for (const target of allTargets) {
      const sessionAvgs = monthSessions.map(session => {
        const snap = (session.targetsSnapshot || []).find(t => t.name === target.name);
        const eff  = snap ? { ...target, maxPoints: snap.maxPoints } : target;
        return calcDailyAverage(session, eff);
      });
      const validAvgs  = sessionAvgs.filter(v => v !== null);
      const monthlyAvg = validAvgs.length > 0 ? avg(validAvgs) : null;

      amberCells.push({ rowIdx: rows.length, col: avgColIdx });
      rows.push([
        target.name,
        ...sessionAvgs.map(v => v !== null ? pct(v) : ""),
        monthlyAvg !== null ? pct(monthlyAvg) : ""
      ]);
    }
  }

  return { rows, monthHeaderRows, colHeaderRows, amberCells };
}

function parseMonth(monthStr) {
  const names = ["January","February","March","April","May","June",
                 "July","August","September","October","November","December"];
  const [name, year] = monthStr.split(" ");
  return [names.indexOf(name) + 1, parseInt(year, 10)];
}

// ─── TARGET DETAIL SHEET ─────────────────────────────────────

function buildTargetSheet(target, sessions) {
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  const rows              = [];
  const monthHeaderRows   = new Set();
  const colHeaderRows     = new Set();
  const activityHeadingRows = new Set();
  const noteRows          = new Set();
  const sessionDateBlocks = []; // { startRow, endRow, dateLabel, avgScore }
  const spacerRows        = new Set(); // blank rows that should have no borders
  let firstMonth = true;

  for (const [month, monthSessions] of byMonth) {
    const dailyAvgsForMonth = monthSessions
      .map(s => {
        const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
        const eff  = snap
          ? { ...target, maxPoints: snap.maxPoints, predefinedActivities: snap.predefinedActivities || target.predefinedActivities || [] }
          : target;
        return calcDailyAverage(s, eff);
      })
      .filter(v => v !== null);
    const monthlyAvg = dailyAvgsForMonth.length > 0 ? avg(dailyAvgsForMonth) : null;

    if (!firstMonth) { spacerRows.add(rows.length); rows.push(["", "", "", "", ""]); }
    firstMonth = false;

    monthHeaderRows.add(rows.length);
    rows.push([`${target.name}  —  ${month}  —  Monthly Average: ${monthlyAvg !== null ? pct(monthlyAvg) : "N/A"}`, "", "", "", ""]);
    spacerRows.add(rows.length);
    rows.push(["", "", "", "", ""]); // blank spacer

    colHeaderRows.add(rows.length);
    rows.push(["Date", "Activity", "Remark", "Score", "Avg Score"]);

    for (const session of monthSessions) {
      // Skip if this target has no remarks in this session (activity was auto-created but never used)
      const targetActIds = new Set(
        Object.entries(session.activities || {})
          .filter(([, a]) => a.targetName === target.name)
          .map(([id]) => id)
      );
      const hasTargetRemarks = Object.values(session.remarks || {})
        .some(r => targetActIds.has(r.activityId));
      if (!hasTargetRemarks) continue;

      const snap = (session.targetsSnapshot || []).find(t => t.name === target.name);
      const effectiveTarget = snap ? { ...target, maxPoints: snap.maxPoints } : target;
      appendSessionRows(rows, sessionDateBlocks, activityHeadingRows, noteRows, session, effectiveTarget);
    }
  }

  return { rows, monthHeaderRows, colHeaderRows, activityHeadingRows, noteRows, sessionDateBlocks, spacerRows };
}

// ─── SESSION ROWS ────────────────────────────────────────────

function appendSessionRows(rows, sessionDateBlocks, activityHeadingRows, noteRows, session, target) {
  const [, m, d] = session.date.split("-").map(Number);
  const shortMonths = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dateLabel = `${d} ${shortMonths[m - 1]}`;

  const startRow = rows.length;

  const activities = getAllActivitiesForTarget(session, target);

  if (activities.length === 0) {
    rows.push(["", "(no data recorded)", "", "", ""]);
  } else {
    for (const act of activities) {
      if (act.isHeading) {
        activityHeadingRows.add(rows.length);
        rows.push(["", act.activityName, "", "", ""]);
        continue;
      }

      if (act.isNote) {
        noteRows.add(rows.length);
        const noteText = (act.activityName || "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/div>/gi, "\n").replace(/<div>/gi, "")
          .replace(/<\/p>/gi, "\n").replace(/<p>/gi, "")
          .replace(/<[^>]*>/g, "")
          .replace(/\*\*/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        rows.push(["", `Note: ${noteText}`, "", "", ""]);
        continue;
      }

      const paEntry = (target.predefinedActivities || []).find(
        p => !p.isHeading && !p.isNote && matchesPa(act, p)
      );
      const actNoteText = paEntry?.actNote;
      const activityCell = (actNoteText && actNoteText.trim())
        ? richTextActivityWithNote(act.activityName, actNoteText.trim())
        : act.activityName;

      if (act.empty) {
        rows.push(["", activityCell, "", "", ""]);
        continue;
      }

      const remarks = getRemarksForActivity(session, act.id);
      const starter = paEntry?.sentenceStarter || null;

      if (remarks.length === 0) {
        rows.push(["", activityCell, "", "", ""]);
        continue;
      }

      let firstRemark = true;
      for (const rem of remarks) {
        const validTrials = (rem.trials || []).filter(t => t !== -1);
        const remarkAvg   = calcRemarkAvg(validTrials, target.maxPoints);
        const masteryNote = stripRemarkHtml(rem.masteryNote || "");
        const baseText    = starter ? `${starter} ${stripRemarkHtml(rem.text)}`.trim() : stripRemarkHtml(rem.text);
        const remarkText  = masteryNote ? `${baseText} — ${masteryNote}` : baseText;
        rows.push([
          "",
          firstRemark ? activityCell : "",
          remarkText,
          remarkAvg !== null ? pct(remarkAvg) : "",
          ""
        ]);
        firstRemark = false;
      }
    }

    if (target.hasComment) {
      const commentText = (session.fedcComments || {})[sanitizeKey(target.name)] || "";
      if (commentText) rows.push(["", "Comment", commentText, "", ""]);
    }
  }

  const daily = calcDailyAverage(session, target);
  sessionDateBlocks.push({
    startRow,
    endRow: rows.length - 1,
    dateLabel,
    avgScore: daily !== null ? pct(daily) : ""
  });
  // Sessions flow directly — no blank separator
}

// ─── DATA HELPERS ────────────────────────────────────────────

/**
 * Returns predefined activities in their original order (headings included),
 * with { empty: true } for predefined items with no session data, plus any
 * custom (non-predefined) activities appended at the end.
 */
function getAllActivitiesForTarget(session, target) {
  const sessionActs = Object.entries(session.activities || {})
    .filter(([, a]) => a.targetName === target.name)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .map(([id, a]) => ({ id, ...a }));

  const result = [];
  const usedIds = new Set();

  for (const pa of (target.predefinedActivities || [])) {
    if (!pa.name && !pa.isNote && !pa.isHeading) continue;
    if (pa.isNote) {
      result.push({ isNote: true, activityName: pa.text || "" });
      continue;
    }
    if (!pa.name) continue;
    if (pa.isHeading) {
      result.push({ isHeading: true, activityName: pa.name });
      continue;
    }
    const sessionAct = sessionActs.find(a => a.isPredefined && matchesPa(a, pa));
    if (sessionAct) {
      usedIds.add(sessionAct.id);
      result.push(sessionAct);
    } else {
      result.push({ id: null, activityName: pa.name, isPredefined: true, empty: true });
    }
  }

  for (const act of sessionActs) {
    if (usedIds.has(act.id)) continue;
    // Orphaned predefined activity (renamed/converted/deleted from the target's
    // current setup since this session was recorded) with no actual remark data —
    // a ghost left behind by editing the target, not real session content. Skip it.
    // (Orphans that DO have remarks are kept — that's genuine historical data.)
    if (act.isPredefined && getRemarksForActivity(session, act.id).length === 0) continue;
    result.push(act);
  }

  return result;
}

function getRemarksForActivity(session, actId) {
  if (!actId) return [];
  return Object.entries(session.remarks || {})
    .filter(([, r]) => r.activityId === actId)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .map(([id, r]) => ({ id, ...r }));
}

// ─── CALCULATIONS ────────────────────────────────────────────

function calcRemarkAvg(trials, maxPoints) {
  if (!trials || trials.length === 0) return null;
  const valid = trials.filter(t => t !== -1);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / (valid.length * maxPoints) * 100;
}

function calcDailyAverage(session, target) {
  const avgs = [];
  for (const act of getAllActivitiesForTarget(session, target)) {
    if (act.isHeading || act.isNote || act.empty) continue;
    for (const rem of getRemarksForActivity(session, act.id)) {
      const validTrials = (rem.trials || []).filter(t => t !== -1);
      const a = calcRemarkAvg(validTrials, target.maxPoints);
      if (a !== null) avgs.push(a);
    }
  }
  return avgs.length > 0 ? avg(avgs) : null;
}

function avg(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }

// ─── FORMAT HELPERS ──────────────────────────────────────────

function pct(v) { return Math.round(v) + "%"; }

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}

// ─── CHART HELPERS ───────────────────────────────────────────

function linearRegressionValues(yValues) {
  const n = yValues.length;
  if (n < 2) return yValues.slice();
  const xMean = (n + 1) / 2;
  const yMean = yValues.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  yValues.forEach((y, i) => {
    const x = i + 1;
    num += (x - xMean) * (y - yMean);
    den += (x - xMean) ** 2;
  });
  const slope = den !== 0 ? num / den : 0;
  const intercept = yMean - slope * xMean;
  return yValues.map((_, i) => {
    const val = slope * (i + 1) + intercept;
    return Math.max(0, Math.min(100, val));
  });
}

function formatDateRange(dates) {
  if (dates.length === 0) return "";
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [fy, fm] = dates[0].split("-").map(Number);
  const [ly, lm] = dates[dates.length - 1].split("-").map(Number);
  if (fy === ly && fm === lm) return `${mo[fm - 1]} ${fy}`;
  if (fy === ly)               return `${mo[fm - 1]} – ${mo[lm - 1]} ${fy}`;
  return                              `${mo[fm - 1]} ${fy} – ${mo[lm - 1]} ${ly}`;
}

function renderTargetChart(targetName, yValues, dateRange, dates) {
  const SCALE   = 3;
  const canvas  = document.createElement("canvas");
  canvas.width  = 605;
  canvas.height = 340;
  const ctx    = canvas.getContext("2d");
  const shortMonths = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const labels = dates.map(d => {
    const [, m, day] = d.split("-").map(Number);
    return `${day} ${shortMonths[m - 1]}`;
  });
  const trend  = linearRegressionValues(yValues);

  // Direction indicator from trendline slope
  const slopePerSession = trend.length >= 2
    ? (trend[trend.length - 1] - trend[0]) / (trend.length - 1)
    : 0;
  const totalDelta = Math.round(Math.abs(trend[trend.length - 1] - trend[0]));
  let dirText, dirColor;
  if (Math.abs(slopePerSession) <= 1.5) {
    dirText  = "→  Stable";
    dirColor = "#888888";
  } else if (slopePerSession > 0) {
    dirText  = `↑  Trending Up  (+${totalDelta}pp)`;
    dirColor = "#2A7A3B";
  } else {
    dirText  = `↓  Trending Down  (−${totalDelta}pp)`;
    dirColor = "#C0392B";
  }

  const titleText = dateRange ? `${targetName}  (${dateRange})` : targetName;

  const chart = new Chart(ctx, {
    type: "line",
    plugins: [
      {
        id: "whiteBg",
        beforeDraw(c) {
          c.ctx.save();
          c.ctx.fillStyle = "#ffffff";
          c.ctx.fillRect(0, 0, c.width, c.height);
          c.ctx.restore();
        }
      },
      {
        id: "chartBorder",
        afterDraw(c) {
          c.ctx.save();
          c.ctx.strokeStyle = "#000000";
          c.ctx.lineWidth   = 1;
          c.ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
          c.ctx.restore();
        }
      },
      {
        id: "pointLabels",
        afterDatasetsDraw(c) {
          const { ctx: cx, data } = c;
          const meta = c.getDatasetMeta(0);
          meta.data.forEach((point, i) => {
            const value = data.datasets[0].data[i];
            if (value === null || value === undefined) return;
            cx.save();
            cx.fillStyle    = "#000000";
            cx.font         = "bold 11px sans-serif";
            cx.textAlign    = "center";
            cx.textBaseline = "top";
            cx.fillText(value + "%", point.x, point.y + 8);
            cx.restore();
          });
        }
      }
    ],
    data: {
      labels,
      datasets: [
        {
          data:                 yValues,
          borderColor:          "#3B6CB5",
          backgroundColor:      "rgba(59,108,181,0.08)",
          pointBackgroundColor: "#3B6CB5",
          pointRadius:          5,
          tension:              0,
          fill:                 false,
          clip:                 false
        },
        {
          data:        trend,
          borderColor: "rgba(59,108,181,0.45)",
          borderDash:  [6, 4],
          pointRadius: 0,
          tension:     0,
          fill:        false
        }
      ]
    },
    options: {
      animation:        false,
      responsive:       false,
      devicePixelRatio: SCALE,
      layout: { padding: { top: 10, left: 4, right: 22, bottom: 20 } },
      plugins: {
        title: {
          display: true,
          text:    titleText,
          font:    { size: 15, weight: "bold" },
          color:   "#000000"
        },
        subtitle: {
          display: true,
          text:    dirText,
          color:   dirColor,
          font:    { size: 12, style: "italic" },
          padding: { bottom: 6 }
        },
        legend: { display: false }
      },
      scales: {
        x: {
          title: { display: true, text: "Date", color: "#000000", font: { size: 13, weight: "bold" } },
          ticks: { color: "#000000", font: { size: 13 } },
          grid:  { color: "rgba(0,0,0,0.07)" }
        },
        y: {
          min:   0,
          max:   100,
          title: { display: false },
          ticks: { display: false },
          grid:  { color: "rgba(0,0,0,0.16)" }
        }
      }
    }
  });

  const base64 = canvas.toDataURL("image/png").split(",")[1];
  chart.destroy();
  return base64;
}

// ─── BASELINE VS CURRENT CHART HELPERS ──────────────────────

function wrapLabel(text, maxChars = 14) {
  if (text.length <= maxChars) return text;
  const words = text.split(" ");
  const lines = [];
  let current = "";
  for (const word of words) {
    if (current && (current + " " + word).length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function renderBaselineChart(title, labels, baselineData, currentData, baselineLabel, currentLabel) {
  const SCALE   = 3;
  const canvas  = document.createElement("canvas");
  canvas.width  = 605;
  canvas.height = 340;
  const ctx     = canvas.getContext("2d");

  const allValues  = [...baselineData, ...currentData].filter(v => v !== null && v !== undefined);
  const hasHundred = allValues.some(v => v >= 100);

  const chart = new Chart(ctx, {
    type: "bar",
    plugins: [
      {
        id: "whiteBg",
        beforeDraw(c) {
          c.ctx.save();
          c.ctx.fillStyle = "#ffffff";
          c.ctx.fillRect(0, 0, c.width, c.height);
          c.ctx.restore();
        }
      },
      {
        id: "chartBorder",
        afterDraw(c) {
          c.ctx.save();
          c.ctx.strokeStyle = "#000000";
          c.ctx.lineWidth   = 1;
          c.ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
          c.ctx.restore();
        }
      },
      {
        id: "barLabels",
        afterDatasetsDraw(c) {
          const { ctx: cx, data } = c;
          data.datasets.forEach((dataset, i) => {
            const meta = c.getDatasetMeta(i);
            meta.data.forEach((bar, j) => {
              const value = dataset.data[j];
              if (value === null || value === undefined) return;
              cx.save();
              cx.fillStyle    = "#333333";
              cx.font         = "bold 11px sans-serif";
              cx.textAlign    = "center";
              cx.textBaseline = "bottom";
              cx.fillText(value + "%", bar.x, bar.y - 2);
              cx.restore();
            });
          });
        }
      }
    ],
    data: {
      labels,
      datasets: [
        {
          label:            baselineLabel,
          data:             baselineData,
          backgroundColor:  "#C8C8C8",
          borderColor:      "#AAAAAA",
          borderWidth:      1,
          barPercentage:    1.0,
          categoryPercentage: 0.72
        },
        {
          label:            currentLabel,
          data:             currentData,
          backgroundColor:  "#80BCEC",
          borderColor:      "#52A0D8",
          borderWidth:      1,
          barPercentage:    1.0,
          categoryPercentage: 0.72
        }
      ]
    },
    options: {
      animation:       false,
      responsive:      false,
      devicePixelRatio: SCALE,
      layout: { padding: { top: 10, left: 4, right: 22, bottom: 6 } },
      plugins: {
        title: {
          display:  true,
          text:     title,
          font:     { size: 16, weight: "bold" },
          color:    "#000000",
          padding:  { top: 4, bottom: hasHundred ? 32 : 8 }
        },
        legend: {
          display:  true,
          position: "bottom",
          labels:   { color: "#000000", font: { size: 13 }, boxWidth: 12, boxHeight: 12 }
        }
      },
      scales: {
        x: {
          ticks: { color: "#000000", maxRotation: 0, font: { size: 13 } },
          grid:  { display: false }
        },
        y: {
          min:   0,
          max:   100,
          title: { display: false },
          ticks: { display: false },
          grid:  { color: "rgba(0,0,0,0.16)" }
        }
      }
    }
  });

  const base64 = canvas.toDataURL("image/png").split(",")[1];
  chart.destroy();
  return base64;
}
