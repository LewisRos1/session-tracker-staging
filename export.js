// ============================================================
// EXPORT.JS — Excel export via ExcelJS (loaded globally as ExcelJS)
// One .xlsx per student: a Summary sheet + one sheet per target.
// ============================================================

import { getAllSessionsForStudent, getAllSessionsForGroup, sanitizeKey, getSessionById, getStudentById } from "./firebase-service.js";

// Strip HTML tags from remark text (stored as HTML for visual bold support).
// Line breaks are stored as <br>/<div>/<p> (see app.js's htmlForStorage) —
// convert those to real newlines first so multi-line remarks don't collapse
// onto one line once the tags are stripped.
function stripRemarkHtml(s) {
  return (s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n").replace(/<div>/gi, "")
    .replace(/<\/p>/gi, "\n").replace(/<p>/gi, "")
    .replace(/<[^>]*>/g, "")
    // Decode HTML entities left behind after tag stripping
    .replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Excel doesn't attempt rich (partial-bold) text for Activity Name/Notes the
// way the Word export does (see parseInlineMarkup) — just drop the */_
// markers so they don't show up literally in the cell text.
function stripActivityMarkup(s) {
  return (s || "").replace(/\*(.+?)\*/g, "$1").replace(/_(.+?)_/g, "$1");
}

// Converts a remark's raw HTML into an ExcelJS cell value that preserves
// <strong>/<b> (bold) and <u> (underline) formatting. Block-level tags
// (<br>/<div>/<p>) become newlines so multi-line remarks stay multi-line.
// Returns "" when there is no content, a plain string when no formatting
// is needed, or { richText: [...] } for ExcelJS when formatting is present.
// Also handles sentence-starter prefix (omitted when body is empty) and
// mastery/note suffix.
function buildExcelRemarkCell(html, starter, masteryNote) {
  const normalized = (html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n").replace(/<div[^>]*>/gi, "")
    .replace(/<\/p>/gi, "\n").replace(/<p[^>]*>/gi, "")
    .trim();

  const segments = [];
  const fmtStack = [{ bold: false, underline: false }];
  let i = 0, buf = "";

  const flush = () => {
    if (!buf) return;
    const f = fmtStack[fmtStack.length - 1];
    segments.push({ text: buf, bold: f.bold, underline: f.underline });
    buf = "";
  };

  while (i < normalized.length) {
    if (normalized[i] !== "<") { buf += normalized[i++]; continue; }
    const end = normalized.indexOf(">", i);
    if (end === -1) { buf += normalized[i++]; continue; }
    flush();
    const tag = normalized.slice(i + 1, end);
    const close = tag.startsWith("/");
    const name = (close ? tag.slice(1) : tag.split(/[\s>]/)[0]).toLowerCase();
    if (!close) {
      const cur = fmtStack[fmtStack.length - 1];
      fmtStack.push({
        bold: cur.bold || name === "strong" || name === "b",
        underline: cur.underline || name === "u"
      });
    } else if (fmtStack.length > 1) {
      fmtStack.pop();
    }
    i = end + 1;
  }
  flush();

  const merged = [];
  for (const seg of segments) {
    const text = seg.text
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.bold === seg.bold && last.underline === seg.underline) last.text += text;
    else merged.push({ text, bold: seg.bold, underline: seg.underline });
  }

  const hasContent = merged.some(s => s.text.trim());
  const richText = [];

  if (starter) {
    if (!hasContent) return "";
    richText.push({ text: `${starter}: ` });
  }

  for (const seg of merged) {
    const entry = { text: seg.text };
    if (seg.bold || seg.underline) {
      entry.font = {};
      if (seg.bold) entry.font.bold = true;
      if (seg.underline) entry.font.underline = true;
    }
    richText.push(entry);
  }

  if (masteryNote) {
    if (richText.length > 0) richText[richText.length - 1].text += ` — ${masteryNote}`;
    else richText.push({ text: ` — ${masteryNote}` });
  }

  if (richText.length === 0) return "";
  if (!richText.some(r => r.font)) return richText.map(r => r.text).join("");
  return { richText };
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
function isActivityActive(pa, dateStr) {
  if (!dateStr) return true;
  if (pa.masteredOn     && dateStr >= pa.masteredOn)     return false;
  if (pa.discontinuedOn && dateStr >= pa.discontinuedOn) return false;
  if (pa.activeFrom && dateStr < pa.activeFrom) return false;
  if (pa.activeTo   && dateStr > pa.activeTo)   return false;
  return true;
}

// Gray activity rows — "White, Background 1, Darker 5%" (#F2F2F2)
const STYLE_GRAY_ACT_FILL  = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
const STYLE_GREEN_ACT_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2EFDA" } };
const STYLE_GREEN_HDG_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFA9D18E" } };
// Gray heading rows — "White, Background 1, Darker 15%" (#D9D9D9)
const STYLE_GRAY_HDG_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9D9D9" } };
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
// Converts *bold* / _underline_ markers in an activity name to ExcelJS richText.
// Returns a plain string when no markup is present, { richText: [...] } otherwise.
// An optional plain-text suffix (e.g. " (Mastered ✓)") is appended at the end.
function buildExcelActivityCell(text, suffix) {
  const lines = parseInlineMarkup(text || "");
  const richText = [];
  let hasFormatting = false;
  lines.forEach((lineRuns, lineIdx) => {
    if (lineIdx > 0 && richText.length > 0) richText[richText.length - 1].text += "\n";
    for (const run of lineRuns) {
      if (!run.text) continue;
      const entry = { text: run.text };
      if (run.bold || run.underline) {
        entry.font = {};
        if (run.bold)      entry.font.bold      = true;
        if (run.underline) entry.font.underline  = true;
        hasFormatting = true;
      }
      richText.push(entry);
    }
  });
  if (suffix) {
    if (richText.length > 0) richText[richText.length - 1].text += suffix;
    else richText.push({ text: suffix });
  }
  if (!hasFormatting) return richText.map(r => r.text).join("");
  return { richText };
}

function richTextActivityWithNote(activityName, note) {
  const actCell = buildExcelActivityCell(activityName);
  const noteRun = { text: `\nNote: ${note}`, font: STYLE_NOTE.font };
  if (typeof actCell === "string") return { richText: [{ text: actCell }, noteRun] };
  return { richText: [...actCell.richText, noteRun] };
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
  // Per-target: each target's "first month" is the first month IT has data,
  // not the global first month. Same for "most recent month".
  const allMonths = [...new Set(sortedSessions.map(s => s.month))].sort((a, b) => {
    const [ma, ya] = parseMonth(a); const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });
  if (allMonths.length < 2) return;

  // Group sessions by month once
  const sessionsByMonth = {};
  for (const month of allMonths) sessionsByMonth[month] = sortedSessions.filter(s => s.month === month);

  const monthAvgForTarget = (target, sessions) => {
    const vals = sessions.map(s => {
      const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
      const eff  = snap ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints } : target;
      return calcDailyAverage(s, eff, allTargets);
    }).filter(v => v !== null && !isNaN(v));
    return vals.length > 0 ? avg(vals) : null;
  };

  const bvcRows    = [];
  const bvcTargets = [];

  bvcRows.push([`${entityName}: First Month vs Most Recent Month`, "", ""]);
  bvcRows.push(["Target", "First Month", "Most Recent Month"]);

  for (const target of allTargets) {
    let firstMonth = null, lastMonth = null, scoreF = null, scoreL = null;
    for (const month of allMonths) {
      const v = monthAvgForTarget(target, sessionsByMonth[month]);
      if (v !== null) {
        if (firstMonth === null) { firstMonth = month; scoreF = v; }
        lastMonth = month;
        scoreL    = v;
      }
    }

    const hasComparison = firstMonth !== null && lastMonth !== null && firstMonth !== lastMonth;
    bvcRows.push([
      target.name,
      firstMonth && scoreF !== null ? `${firstMonth}: ${pct(scoreF)}` : "",
      hasComparison && scoreL !== null ? `${lastMonth}: ${pct(scoreL)}` : ""
    ]);
    bvcTargets.push({
      name:  target.name,
      first: hasComparison && scoreF !== null ? Math.round(scoreF) : null,
      last:  hasComparison && scoreL !== null ? Math.round(scoreL) : null
    });
  }

  const bvcWs = wb.addWorksheet("Monthly Comparison");
  bvcRows.forEach(row => bvcWs.addRow(row));

  bvcWs.getColumn(1).width     = 28;
  bvcWs.getColumn(2).width     = 24;
  bvcWs.getColumn(3).width     = 24;
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
        `${entityName}: First Month vs Most Recent Month`,
        chartTargets.map(t => t.name),
        chartTargets.map(t => t.first),
        chartTargets.map(t => t.last),
        "First Month Avg",
        "Most Recent Month Avg"
      );
      const bvcImgId = wb.addImage({ base64: bvcBase64, extension: "png" });
      bvcWs.addImage(bvcImgId, {
        tl:  { col: 0, row: bvcRows.length + 1 },
        ext: { width: 605, height: 370 }
      });
    }
  }
}

// Two half-year chart sheets: H1 = Jan–Jun, H2 = Jul–Dec.
// One chart per target, one data point per month (monthly average).
function addHalfYearChartsSheets(wb, allTargets, sessions) {
  if (typeof Chart === "undefined") return;

  const H1 = new Set(["January","February","March","April","May","June"]);
  const H2 = new Set(["July","August","September","October","November","December"]);

  const allMonths = [...new Set(sessions.map(s => s.month))].sort((a, b) => {
    const [ma, ya] = parseMonth(a); const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });
  const h1Months = allMonths.filter(m => H1.has(m.split(" ")[0]));
  const h2Months = allMonths.filter(m => H2.has(m.split(" ")[0]));

  function buildSheet(sheetName, halfMonths) {
    if (halfMonths.length === 0) return;
    const ws = wb.addWorksheet(sheetName);
    let chartIdx = 0;

    for (const target of allTargets) {
      const yValues = [], labels = [];

      for (const month of halfMonths) {
        const monthSessions = sessions.filter(s => s.month === month);
        const dailyAvgs = monthSessions.map(s => {
          const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
          const eff  = snap ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints } : target;
          return calcDailyAverage(s, eff, allTargets);
        }).filter(v => v !== null && !isNaN(v));

        if (dailyAvgs.length > 0) {
          yValues.push(Math.round(avg(dailyAvgs)));
          labels.push(month.split(" ")[0].slice(0, 3));
        }
      }

      if (yValues.length < 1) { chartIdx++; continue; }

      const year = halfMonths[0].split(" ")[1];
      const dateRange = `${labels[0]}–${labels[labels.length - 1]} ${year}`;
      const base64 = renderTargetChart(target.name, yValues, dateRange, null, labels);
      const imgId  = wb.addImage({ base64, extension: "png" });

      const chartRow = Math.floor(chartIdx / 2) * 19;
      const chartCol = (chartIdx % 2) * 11;
      ws.addImage(imgId, { tl: { col: chartCol, row: chartRow }, ext: { width: 605, height: 340 } });
      chartIdx++;
    }
  }

  buildSheet("Charts H1 (Jan–Jun)", h1Months);
  buildSheet("Charts H2 (Jul–Dec)", h2Months);
}

function addIndividualTargetSheets(wb, allTargets, sessions, studentName, includeTrials) {
  // Date | Activity | Remark | Score | [Trials] | Avg Score — Trials is an
  // optional extra column, so the avg-score column's letter/index shifts
  // from E/5 to F/6 whenever it's included.
  const numCols   = includeTrials ? 6 : 5;
  const avgCol    = includeTrials ? 6 : 5;
  const avgColLet = includeTrials ? "F" : "E";

  for (const target of allTargets) {
    const { rows, monthHeaderRows, colHeaderRows, activityHeadingRows, noteRows, sessionDateBlocks, spacerRows, grayRows, greenRows } =
      buildTargetSheet(target, sessions, allTargets, includeTrials);
    const ws = wb.addWorksheet(target.name.slice(0, 31));
    rows.forEach(row => ws.addRow(row));

    // Col widths: Date | Activity | Remark | [Trials |] Score | Avg Score
    ws.getColumn(1).width     = 6.33;
    ws.getColumn(2).width     = 50;
    ws.getColumn(3).width     = 62;
    if (includeTrials) {
      ws.getColumn(4).width = 16;   // Trials
      ws.getColumn(5).width = 6.78; // Score
    } else {
      ws.getColumn(4).width = 6.78; // Score
    }
    ws.getColumn(avgCol).width = 8.56;
    ws.getColumn(1).alignment = { horizontal: "center", vertical: "top" };
    ws.getColumn(2).alignment = { wrapText: true, vertical: "top" };
    ws.getColumn(3).alignment = { wrapText: true, vertical: "top" };
    if (includeTrials) {
      ws.getColumn(4).alignment = { wrapText: true, horizontal: "center", vertical: "top" };
      ws.getColumn(5).alignment = { horizontal: "center", vertical: "top" };
    } else {
      ws.getColumn(4).alignment = { horizontal: "center", vertical: "top" };
    }
    ws.getColumn(avgCol).alignment = { horizontal: "center", vertical: "top" };

    // Month headers: merge A:[last col], White Darker 25%, bold black
    for (const rowIdx of monthHeaderRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`A${n}:${avgColLet}${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(1);
      cell.fill      = STYLE_TARGET_MONTH.fill;
      cell.font      = STYLE_TARGET_MONTH.font;
      cell.alignment = STYLE_TARGET_MONTH.alignment;
    }

    // Column headers: White Darker 15%, bold black
    for (const rowIdx of colHeaderRows) {
      const n = rowIdx + 1;
      for (let c = 1; c <= numCols; c++) {
        const cell = ws.getRow(n).getCell(c);
        cell.fill      = STYLE_TARGET_COLHDR.fill;
        cell.font      = STYLE_TARGET_COLHDR.font;
        cell.alignment = STYLE_TARGET_COLHDR.alignment;
      }
    }

    // Activity heading rows: merge Activity through Trials (leave the
    // avg-score column free for the per-session avg-score merge below).
    // Used to always stop at D (Score), silently skipping the Trials column
    // whenever it was included — leaving the heading visually short of the
    // Trials column instead of spanning the full row.
    const headingEndCol = includeTrials ? "E" : "D";
    for (const rowIdx of activityHeadingRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`B${n}:${headingEndCol}${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(2);
      cell.fill      = STYLE_ACT_HEADING.fill;
      cell.font      = STYLE_ACT_HEADING.font;
      cell.alignment = { vertical: "top" };
    }

    // Gray activity rows (activityColor:"gray" or isMaintainLive): light gray tint across all cols.
    // Applied after activityHeadingRows so gray maintenance headings override the blue fill.
    for (const rowIdx of grayRows) {
      const n = rowIdx + 1;
      const rowObj = ws.getRow(n);
      const grayFill = activityHeadingRows.has(rowIdx) ? STYLE_GRAY_HDG_FILL : STYLE_GRAY_ACT_FILL;
      for (let c = 1; c <= numCols; c++) rowObj.getCell(c).fill = grayFill;
    }

    // Green activity rows (activityColor:"green"): green tint across all cols.
    for (const rowIdx of greenRows) {
      const n = rowIdx + 1;
      const rowObj = ws.getRow(n);
      const greenFill = activityHeadingRows.has(rowIdx) ? STYLE_GREEN_HDG_FILL : STYLE_GREEN_ACT_FILL;
      for (let c = 1; c <= numCols; c++) rowObj.getCell(c).fill = greenFill;
    }

    // Note rows: same column span as activity headings above.
    for (const rowIdx of noteRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`B${n}:${headingEndCol}${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(2);
      cell.fill      = STYLE_NOTE.fill;
      cell.font      = STYLE_NOTE.font;
      cell.alignment = { wrapText: true, vertical: "top" };
      const text = (cell.value || "").toString();
      const visLines = text.split("\n").reduce((sum, seg) =>
        sum + Math.max(1, Math.ceil((seg.length || 1) / 90)), 0);
      ws.getRow(n).height = Math.max(20, visLines * 20);
    }

    // Row heights: measure both Activity (col B, 50 char wide) and Remark (col C, 72 char wide)
    // counting real newlines plus estimated wrap, take the larger of the two.
    ws.eachRow((row, n) => {
      if (monthHeaderRows.has(n - 1) || colHeaderRows.has(n - 1) || noteRows.has(n - 1)) return;
      const getText = c => { const v = row.getCell(c).value; return typeof v === "string" ? v : (v?.richText?.map(r => r.text).join("") || ""); };
      const countLines = (t, w) => !t ? 0 : t.split("\n").reduce((s, seg) => s + Math.max(1, Math.ceil((seg.length || 1) / w)), 0);
      const needed = Math.max(countLines(getText(2), 48), countLines(getText(3), 72), 1);
      if (needed > 1 && (!row.height || row.height < needed * 15)) row.height = Math.max(20, needed * 15);
    });

    // Session date blocks: col A = date (top+center), last col = avg score (middle+center)
    for (const { startRow, endRow, dateLabel, avgScore } of sessionDateBlocks) {
      const startN = startRow + 1;
      const endN   = endRow + 1;
      if (startN < endN) {
        try { ws.mergeCells(`A${startN}:A${endN}`); } catch (_) {}
        try { ws.mergeCells(`${avgColLet}${startN}:${avgColLet}${endN}`); } catch (_) {}
      }
      const dateCell = ws.getRow(startN).getCell(1);
      dateCell.value     = dateLabel;
      dateCell.alignment = { horizontal: "center", vertical: "top" };

      const avgCell = ws.getRow(startN).getCell(avgCol);
      avgCell.value     = avgScore;
      avgCell.font      = { color: { argb: "FF000000" } };
      avgCell.alignment = { horizontal: "center", vertical: "top" };
    }

    // Footer: company left | target name centre | page number right
    ws.headerFooter.oddFooter = `&LZORA Behavioural Intervention&C${target.name}  —  ${studentName}&R&P`;

    // Borders: White Darker 15% (#D9D9D9) — skip blank spacer rows
    ws.eachRow((row, rowNumber) => {
      if (spacerRows.has(rowNumber - 1)) return;
      for (let c = 1; c <= numCols; c++) row.getCell(c).border = TARGET_CELL_BORDER;
    });
  }
}

async function buildStudentWorkbook(student, sessions, includeTrials) {
  const allTargets = getAllTargets(student).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));

  // Drop ghost sessions: only keep sessions where something real was recorded.
  // "Real" means: at least one remark exists, OR the session accessed a Fixed Remark target
  // (those never produce remark docs but still represent genuine clinical content).
  const hasFixedTargetActivity = s => Object.values(s.activities || {}).some(
    a => a.targetName && allTargets.some(
      t => t.name === a.targetName &&
        (t.predefinedActivities || []).some(pa => pa.fixedRemark !== undefined || pa.isMaintain)
    )
  );
  sessions = sessions.filter(s => Object.keys(s.remarks || {}).length > 0 || hasFixedTargetActivity(s));
  const wb = new ExcelJS.Workbook();
  const sortedSessions = sessions.slice().sort((a, b) => a.date.localeCompare(b.date));

  addSummarySheets(wb, allTargets, sessions);
  addBaselineVsCurrentSheet(wb, student.name, allTargets, sortedSessions);
  addHalfYearChartsSheets(wb, allTargets, sortedSessions);
  addIndividualTargetSheets(wb, allTargets, sessions, student.name, includeTrials);

  return wb.xlsx.writeBuffer();
}

// Builds a workbook for ONE student's slice of their group sessions, formatted
// identically to an individual student export (no Student column — every
// session here has already been filtered down to just this student's remarks).
async function buildGroupMemberWorkbook(studentName, allTargets, sessions, includeTrials) {
  const hasFixedTargetActivity = s => Object.values(s.activities || {}).some(
    a => a.targetName && allTargets.some(
      t => t.name === a.targetName &&
        (t.predefinedActivities || []).some(pa => pa.fixedRemark !== undefined || pa.isMaintain)
    )
  );
  const filtered = sessions
    .map(s => ({
      ...s,
      remarks: Object.fromEntries(
        Object.entries(s.remarks || {}).filter(([, r]) => r.studentName === studentName)
      )
    }))
    .filter(s => Object.keys(s.remarks).length > 0 || hasFixedTargetActivity(s));

  const sortedTargets  = allTargets.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const wb              = new ExcelJS.Workbook();
  const sortedSessions  = filtered.slice().sort((a, b) => a.date.localeCompare(b.date));

  addSummarySheets(wb, sortedTargets, filtered);
  addBaselineVsCurrentSheet(wb, studentName, sortedTargets, sortedSessions);
  addHalfYearChartsSheets(wb, sortedTargets, sortedSessions);
  addIndividualTargetSheets(wb, sortedTargets, filtered, studentName, includeTrials);

  return wb.xlsx.writeBuffer();
}

// "Exported On {D Mon YYYY}, {HH.MM}" — date in the same "D Mon YYYY" style as
// fmtDate below, time as 24h HH.MM. Shared by both the Excel and Word
// filename formats; always reflects the moment of export, never any
// session date.
function exportedOnSuffix(now) {
  const yyyy = now.getFullYear();
  const mm   = String(now.getMonth() + 1).padStart(2, "0");
  const dd   = String(now.getDate()).padStart(2, "0");
  const hh   = String(now.getHours()).padStart(2, "0");
  const min  = String(now.getMinutes()).padStart(2, "0");
  return `Exported On ${fmtDate(`${yyyy}-${mm}-${dd}`)}, ${hh}.${min}`;
}

// Filename format: "{Name} - Yearly Summary (Exported On {D Mon YYYY}, {HH.MM})"
function formatExportFilename(name, now) {
  return `${name} - Yearly Summary (${exportedOnSuffix(now)}).xlsx`;
}

export async function exportStudentData(student, includeTrials = false) {
  if (!student) return;

  const sessions = await getAllSessionsForStudent(student.id);
  if (sessions.length === 0) {
    alert("No session data found for " + student.name);
    return;
  }

  const now    = new Date();
  const buffer = await buildStudentWorkbook(student, sessions, includeTrials);
  const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = formatExportFilename(student.name, now);
  a.click();
  URL.revokeObjectURL(url);
}

// Exports one student's data across every group session they attended (possibly
// across multiple groups). Formatted exactly like an individual session export.
export async function exportGroupMemberData(studentName, groups, includeTrials = false) {
  if (!studentName || !groups?.length) return;

  let sessions = [];
  for (const group of groups) {
    sessions.push(...await getAllSessionsForGroup(group.id));
  }
  if (sessions.length === 0) {
    alert("No session data found for " + studentName);
    return;
  }

  // If this exact name has zero remarks anywhere in these sessions, the
  // export would otherwise silently come back empty (every sheet renders,
  // just with no scores) — surface what name(s) the recorded data is
  // actually tagged with instead, which is the real symptom when a group
  // slot was relinked to a different/renamed student after sessions were
  // already recorded under the old name.
  const matchCount = sessions.reduce(
    (n, s) => n + Object.values(s.remarks || {}).filter(r => r.studentName === studentName).length, 0
  );
  if (matchCount === 0) {
    const otherNames = [...new Set(
      sessions.flatMap(s => Object.values(s.remarks || {}).map(r => r.studentName).filter(Boolean))
    )];
    alert(
      `No recorded data is tagged to "${studentName}" in this group's sessions.\n\n` +
      (otherNames.length
        ? `The data found is tagged to: ${otherNames.join(", ")}.\nThis can happen if the group's student link was changed after sessions were already recorded under the old name.`
        : `No student names were found on any remark in this group's sessions at all.`)
    );
    return;
  }

  const allTargets = unionTargetsByName(groups);

  const now    = new Date();
  const buffer = await buildGroupMemberWorkbook(studentName, allTargets, sessions, includeTrials);
  const blob   = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = formatExportFilename(studentName, now);
  a.click();
  URL.revokeObjectURL(url);
}

// ── Word export (single session, "Daily Session Note") ───────
// Same content as the Excel single-session export above, but: no Date or
// Avg Score columns (Student/Session/Date moved into the page header
// instead, so repeating them in the table is redundant), and each target's
// title is just its name (no "— Score: X%", since that's only really
// useful when comparing across many sessions, not a single day's note).
// docx is loaded globally via a <script> tag in index.html, same pattern
// as ExcelJS/JSZip/Chart elsewhere in this file.

// Builds the Remark column's content as an array of "lines" (each an array
// of {text, bold} runs) for richCell. For sentence-starter activities, the
// starter + colon is bold and the selected option isn't; a free-text Notes
// field (masteryNote) lands two lines below the starter line, not inline
// after an em dash, so it reads as its own paragraph rather than a caption.
function buildRemarkLines(starter, text, masteryNote) {
  const lines = [];
  if (starter || text) {
    // Only the first line gets the bold starter prefix — further lines of a
    // multi-line remark continue as plain text, same paragraph.
    (text || "").split("\n").forEach((ln, i) => {
      if (i === 0) {
        const runs = [];
        if (starter) runs.push({ text: `${starter}:`, bold: true });
        if (ln) runs.push({ text: starter ? ` ${ln}` : ln });
        lines.push(runs);
      } else {
        lines.push([{ text: ln }]);
      }
    });
  }
  if (masteryNote) {
    if (lines.length > 0) lines.push([{ text: "" }]);
    masteryNote.split("\n").forEach(ln => lines.push([{ text: ln }]));
  }
  if (lines.length === 0) lines.push([{ text: "" }]);
  return lines;
}

// Splits a string into richCell's "array of lines, each an array of
// {text, bold, underline} runs" shape — first on real line breaks (Activity
// Name is a multi-line textarea, e.g. a reference block with one bullet per
// line), then on *bold*/_underline_ markers within each line. Activity
// Name is the only export field that can carry these markers (see app.js's
// sketch editor on the Edit Target Activity Name/Notes fields) — remarks
// never type them.
function parseInlineMarkup(text) {
  return (text || "").split("\n").map(line => parseInlineMarkupLine(line));
}
function parseInlineMarkupLine(line) {
  const runs = [];
  // Combined-marker alternatives (*_x_* / _*x*_) must come before the
  // single-marker ones — a boss who selects already-bolded text and also
  // presses underline (or vice versa) ends up with nested markers, and the
  // single-marker alternatives alone would swallow the inner pair as part of
  // their own captured text (literal "_" showing up inside a bold run)
  // instead of recognizing it as bold+underline together.
  const re = /\*_(.+?)_\*|_\*(.+?)\*_|\*(.+?)\*|_(.+?)_/g;
  let lastIndex = 0, m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > lastIndex) runs.push({ text: line.slice(lastIndex, m.index) });
    if (m[1] !== undefined) runs.push({ text: m[1], bold: true, underline: true });
    else if (m[2] !== undefined) runs.push({ text: m[2], bold: true, underline: true });
    else if (m[3] !== undefined) runs.push({ text: m[3], bold: true });
    else runs.push({ text: m[4], underline: true });
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length) runs.push({ text: line.slice(lastIndex) });
  if (runs.length === 0) runs.push({ text: line });
  return runs;
}

function wordTargetRows(target, session, allTargets) {
  const rows = [];
  const activities = getAllActivitiesForTarget(session, target);

  if (activities.length === 0) {
    rows.push({ merge: true, text: "(no data recorded)" });
    return rows;
  }

  for (const act of activities) {
    if (act.isHeading) {
      rows.push({ merge: true, text: act.activityName, style: "heading" });
      continue;
    }

    if (act.isGreenHeading) {
      rows.push({ merge: true, text: act.activityName, style: "heading", isGreenHeading: true });
      continue;
    }

    // Free-standing "+ Add Note" rows are reference text for the facilitator,
    // not session data — Excel keeps them, but the boss asked Word to leave
    // them out entirely.
    if (act.isNote) continue;

    if (act.isExportNote) {
      rows.push({ merge: true, isExportNote: true, text: act.activityName || "" });
      continue;
    }

    if (act.isMasteredSeparator || act.isMastered || act.isStoppedSeparator || act.isStopped) continue;

    if (act.isMaintainSeparator) continue;

    if (act.isMaintainHeading) {
      rows.push({ merge: true, text: act.activityName, style: "heading", isGrayHeading: true });
      continue;
    }

    if (act.isMaintain) {
      rows.push({ cells: [act.activityName, act.maintainRemark || "", ""], actLines: parseInlineMarkup(act.activityName), remarkLines: parseInlineMarkup(act.maintainRemark || ""), isGray: act.isGray, isGreen: act.isGreen });
      continue;
    }

    // An activity's own attached note (from "+ Add Activity & Note") is also
    // facilitator-reference text, not session data — Word treats this exactly
    // like a plain "+ Add Activity" and drops the note, same reasoning as above.
    const activityLabel = act.activityName;

    // noRemark parent: numbered title, empty remark and score
    if (act.noRemark) {
      rows.push({ cells: [activityLabel, "", ""], actLines: parseInlineMarkup(activityLabel), isGray: act.isGray, isGreen: act.isGreen });
      continue;
    }

    // Sub-activity: indented lettered label, own remark
    if (act.isSubActivity) {
      const subDisplayName = `    ${act.subLabel}) ${act.activityName}`;
      const _nameLines = parseInlineMarkup(act.activityName);
      const _prefix = { text: `    ${act.subLabel}) ` };
      const subActLines = _nameLines.length > 0 ? [[_prefix, ..._nameLines[0]], ..._nameLines.slice(1)] : [[_prefix]];
      if (act.empty) {
        rows.push({ cells: [subDisplayName, "", ""], actLines: subActLines, isGray: act.isGray, isGreen: act.isGreen });
        continue;
      }
      const subRemarks = getRemarksForActivity(session, act.id).filter(hasRemarkContent);
      if (subRemarks.length === 0) {
        rows.push({ cells: [subDisplayName, "", ""], actLines: subActLines, isGray: act.isGray, isGreen: act.isGreen });
        continue;
      }
      const subPa = (target.predefinedActivities || []).find(p => p.name === act.activityName);
      const subStarter = (subPa?.inlineOptions || subPa?.remarkPresetId || subPa?.remarkHasNote) ? (subPa?.sentenceStarter || null) : null;
      let subFirst = true;
      for (const rem of subRemarks) {
        const validTrials = allScores(rem);
        const remarkAvg   = calcRemarkAvg(validTrials, target.maxPoints);
        const text        = stripRemarkHtml(rem.text);
        const subNote     = stripRemarkHtml(rem.masteryNote || "");
        rows.push({
          cells: [subFirst ? subDisplayName : "", "", remarkAvg !== null ? pct(remarkAvg) : ""],
          actLines: subFirst ? subActLines : null,
          remarkLines: buildRemarkLines(subStarter, text, subNote),
          isGray: act.isGray, isGreen: act.isGreen
        });
        subFirst = false;
      }
      continue;
    }

    if (act.empty) {
      rows.push({ cells: [activityLabel, "", ""], actLines: parseInlineMarkup(activityLabel), isGray: act.isGray, isGreen: act.isGreen });
      continue;
    }

    const remarks = getRemarksForActivity(session, act.id).filter(hasRemarkContent);
    const _starterPa = (target.predefinedActivities || []).find(p => !p.isHeading && !p.isNote && p.name === act.activityName);
    const starter = (_starterPa?.inlineOptions || _starterPa?.remarkPresetId || _starterPa?.remarkHasNote) ? (_starterPa?.sentenceStarter || null) : null;

    if (remarks.length === 0) {
      rows.push({ cells: [activityLabel, "", ""], actLines: parseInlineMarkup(activityLabel), isGray: act.isGray, isGreen: act.isGreen });
      continue;
    }

    const mappedScore = act.isMapped ? resolveExportMappedScore(act, session, allTargets) : null;

    let first = true;
    for (const rem of remarks) {
      const validTrials = allScores(rem);
      const remarkAvg   = act.isMapped ? mappedScore : calcRemarkAvg(validTrials, target.maxPoints);
      const masteryNote = stripRemarkHtml(rem.masteryNote || "");
      const text        = stripRemarkHtml(rem.text);
      rows.push({
        cells: [first ? activityLabel : "", "", remarkAvg !== null ? pct(remarkAvg) : ""],
        actLines: first ? parseInlineMarkup(activityLabel) : null,
        remarkLines: buildRemarkLines(starter, text, masteryNote),
        isGray: act.isGray,
        isGreen: act.isGreen
      });
      first = false;
    }
  }

  if (target.hasComment) {
    const commentText = (session.fedcComments || {})[sanitizeKey(target.name)] || "";
    if (commentText) rows.push({ cells: ["Comment", commentText, ""] });
  }

  return rows;
}

// Column widths in twips (1 inch = 1440 twips): Activity 2.37", Highlights of
// Observation 3.38", Score 0.52".
const WORD_COL_ACTIVITY = 3413;
const WORD_COL_REMARK   = 4867;
const WORD_COL_SCORE    = 749;
const WORD_COL_TOTAL    = WORD_COL_ACTIVITY + WORD_COL_REMARK + WORD_COL_SCORE;

// Cached so the stamp image is only fetched once even if multiple exports
// happen in the same session.
let stampImageBufferPromise = null;
function getStampImageBuffer() {
  if (!stampImageBufferPromise) {
    stampImageBufferPromise = fetch("Daisy Word Doc Stamp.png")
      .then(r => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
  }
  return stampImageBufferPromise;
}

function buildSessionDocxBody(entityName, sessionLabel, allTargets, session, stampImageBuffer) {
  const {
    Paragraph, TextRun, Table, TableRow, TableCell, ImageRun,
    AlignmentType, WidthType, BorderStyle, ShadingType, TableLayoutType,
    Header, Footer, PageNumber, TabStopType
  } = docx;

  // Office theme colours: header = Darker 25%, heading = Dark Blue Text 2 Lighter 90%.
  const HEADER_FILL = "BFBFBF";
  const HEADER_TEXT_COLOR = "000000";
  const TARGET_FILL = "DEEAF1";
  const TARGET_TEXT_COLOR = "1F3864";
  const NOTE_FILL   = "FFF8ED";
  const NOTE_TEXT_COLOR = "7A5030";
  const FACILITATION_BORDER = "B0C8E0";

  const cellBorders = {
    top:    { style: BorderStyle.SINGLE, size: 2, color: "D9D9D9" },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: "D9D9D9" },
    left:   { style: BorderStyle.SINGLE, size: 2, color: "D9D9D9" },
    right:  { style: BorderStyle.SINGLE, size: 2, color: "D9D9D9" }
  };

  function textLines(text, opts) {
    const lines = (text || "").split("\n");
    const runs = [];
    lines.forEach((line, i) => {
      if (i > 0) runs.push(new TextRun({ text: "", break: 1 }));
      runs.push(new TextRun({ text: line, ...opts }));
    });
    return runs;
  }

  function cell(text, { bold = false, italics = false, fill = null, color = null, colSpan = 1, align = AlignmentType.JUSTIFIED, width = null } = {}) {
    return new TableCell({
      columnSpan: colSpan,
      width: width != null ? { size: width, type: WidthType.DXA } : undefined,
      shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
      borders: cellBorders,
      margins: { top: 80, bottom: 80, left: 100, right: 100 },
      children: [new Paragraph({ alignment: align, children: textLines(text, { bold, italics, color: color || undefined }) })]
    });
  }

  // Like textLines, but each "line" is an array of {text, bold, underline}
  // runs instead of one uniform string — needed for the Remark column, whose
  // sentence-starter prefix is bold while the rest of the line isn't.
  function richTextLines(lines) {
    const runs = [];
    lines.forEach((lineRuns, i) => {
      if (i > 0) runs.push(new TextRun({ text: "", break: 1 }));
      lineRuns.forEach(r => runs.push(new TextRun({
        text: r.text, bold: !!r.bold, underline: r.underline ? {} : undefined
      })));
    });
    return runs;
  }

  function richCell(lines, { fill = null, colSpan = 1, align = AlignmentType.JUSTIFIED, width = null } = {}) {
    return new TableCell({
      columnSpan: colSpan,
      width: width != null ? { size: width, type: WidthType.DXA } : undefined,
      shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
      borders: cellBorders,
      margins: { top: 80, bottom: 80, left: 100, right: 100 },
      children: [new Paragraph({ alignment: align, children: richTextLines(lines) })]
    });
  }

  const body = [];
  const anyTarget = allTargets.length > 0;

  for (const target of allTargets) {
    body.push(new Paragraph({
      spacing: { before: 240, after: 80 },
      children: [new TextRun({ text: target.name, bold: true })]
    }));

    const tableRows = [
      new TableRow({
        children: [
          cell("Activity",                  { bold: true, fill: HEADER_FILL, color: HEADER_TEXT_COLOR, align: AlignmentType.CENTER, width: WORD_COL_ACTIVITY }),
          cell("Highlights of Observation",  { bold: true, fill: HEADER_FILL, color: HEADER_TEXT_COLOR, align: AlignmentType.CENTER, width: WORD_COL_REMARK }),
          cell("Score",                      { bold: true, fill: HEADER_FILL, color: HEADER_TEXT_COLOR, align: AlignmentType.CENTER, width: WORD_COL_SCORE })
        ]
      })
    ];

    for (const r of wordTargetRows(target, session, allTargets)) {
      if (r.merge) {
        if (r.isExportNote) {
          const noteLines = (r.text || "").split("\n").map(line => {
            const isBullet = /^\s*•\s?/.test(line);
            const cleanLine = isBullet ? "• " + line.replace(/^\s*•\s?/, "") : line;
            return parseInlineMarkupLine(cleanLine);
          });
          if (noteLines.length === 0) noteLines.push([{ text: "" }]);
          const allNoteLines = [[{ text: "Note:", bold: true }], ...noteLines];
          tableRows.push(new TableRow({
            children: [richCell(allNoteLines, { fill: "FEF3C7", colSpan: 3, width: WORD_COL_TOTAL, align: AlignmentType.LEFT })]
          }));
        } else {
        const mergeFill = r.isGrayHeading ? "D9D9D9"
          : r.isGreenHeading ? "A9D18E"
          : (r.style === "heading" ? TARGET_FILL : (r.style === "note" ? NOTE_FILL : null));
        const mergeColor = r.isGrayHeading ? "000000"
          : r.isGreenHeading ? "111827"
          : (r.style === "heading" ? TARGET_TEXT_COLOR : (r.style === "note" ? NOTE_TEXT_COLOR : null));
        tableRows.push(new TableRow({
          children: [cell(r.text, {
            colSpan: 3,
            width: WORD_COL_TOTAL,
            bold: r.style === "heading",
            italics: r.style === "note",
            fill: mergeFill,
            color: mergeColor
          })]
        }));
        }
      } else {
        const actFill = r.isGray ? "F2F2F2" : r.isGreen ? "E2EFDA" : null;
        const grayFill = actFill;
        tableRows.push(new TableRow({
          children: [
            r.actLines
              ? richCell(r.actLines, { align: AlignmentType.LEFT, width: WORD_COL_ACTIVITY, fill: grayFill })
              : cell(r.cells[0], { align: AlignmentType.LEFT, width: WORD_COL_ACTIVITY, fill: grayFill }),
            r.remarkLines
              ? richCell(r.remarkLines, { align: AlignmentType.LEFT, width: WORD_COL_REMARK, fill: grayFill })
              : cell(r.cells[1], { align: AlignmentType.LEFT, width: WORD_COL_REMARK, fill: grayFill }),
            cell(r.cells[2], { align: AlignmentType.CENTER, width: WORD_COL_SCORE, fill: grayFill })
          ]
        }));
      }
    }

    body.push(new Table({
      width: { size: WORD_COL_TOTAL, type: WidthType.DXA },
      columnWidths: [WORD_COL_ACTIVITY, WORD_COL_REMARK, WORD_COL_SCORE],
      layout: TableLayoutType.FIXED,
      rows: tableRows
    }));
    body.push(new Paragraph({ children: [] }));
  }

  if (!anyTarget) {
    body.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text: "No data recorded for this session." })] }));
  }

  // ── Facilitation note + company stamp (every exported note ends with this) ──
  // Single plain-bordered white box (no shading) holding both programs, so it
  // reads as a quiet footnote rather than competing with the target tables.
  function facilitationBox(items) {
    const facilitationBorders = {
      top:    { style: BorderStyle.SINGLE, size: 4, color: FACILITATION_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: FACILITATION_BORDER },
      left:   { style: BorderStyle.SINGLE, size: 4, color: FACILITATION_BORDER },
      right:  { style: BorderStyle.SINGLE, size: 4, color: FACILITATION_BORDER }
    };
    const children = [];
    items.forEach(({ heading, text }, i) => {
      if (i > 0) children.push(new Paragraph({ spacing: { before: 200 }, children: [] }));
      children.push(new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: heading, bold: true })] }));
      children.push(new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [new TextRun({ text })] }));
    });
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [new TableRow({
        children: [new TableCell({
          borders: facilitationBorders,
          margins: { top: 160, bottom: 160, left: 200, right: 200 },
          children
        })]
      })]
    });
  }

  body.push(
    new Paragraph({ spacing: { before: 400, after: 120 }, children: [new TextRun({ text: "The session is facilitated according to:", bold: true })] }),
    facilitationBox([
      {
        heading: "ABA evidence-based treatment program",
        text: "VB MAPP is a functional language program. It teaches children vocalisation, imitation of sounds, labels, and requests (ranging from the lowest to the highest order of language and functional communication skills). Thus, the goal is to equip the child to be both a listener and a speaker, thereby developing academic skills and social interaction."
      },
      {
        heading: "DIRFloortime evidence-based practice",
        text: "It honours a child's sensory processing system during a session to promote self-regulation and information processing and to build a relationship with the facilitator."
      }
    ])
  );

  if (stampImageBuffer) {
    body.push(
      new Paragraph({ spacing: { before: 280 }, children: [] }),
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new ImageRun({ type: "png", data: stampImageBuffer, transformation: { width: 312, height: 197 } })]
      })
    );
  }

  const header = new Header({
    children: [new Paragraph({
      tabStops: [
        { type: TabStopType.CENTER, position: 4680 },
        { type: TabStopType.RIGHT,  position: 9360 }
      ],
      children: [
        new TextRun({ text: entityName }),
        new TextRun({ text: "\t" }),
        new TextRun({ text: sessionLabel }),
        new TextRun({ text: "\t" }),
        new TextRun({ text: fmtDate(session.date) })
      ]
    })]
  });

  const footer = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ children: [PageNumber.CURRENT] })]
    })]
  });

  return { header, footer, body };
}

async function buildSingleSessionWordBlob(entityName, sessionLabel, allTargets, session) {
  const { Document, Packer, LineRuleType } = docx;
  const stampImageBuffer = await getStampImageBuffer();
  const { header, footer, body } = buildSessionDocxBody(entityName, sessionLabel, allTargets, session, stampImageBuffer);
  const doc = new Document({
    // 1.5 line spacing document-wide (360 = 1.5 * the single-spacing unit of
    // 240) — every Paragraph inherits this unless it sets its own "spacing",
    // so table cells, headings, and body text all get it without having to
    // touch each individual Paragraph call site. size: 22 (half-points) is
    // 11pt — explicit so every run is the same size regardless of Word's
    // own Normal-style default, instead of leaving it unset and relying on
    // whatever default docx/Word would otherwise fall back to.
    styles: {
      default: {
        document: {
          run: { size: 22, font: "Times New Roman" },
          paragraph: { spacing: { line: 360, lineRule: LineRuleType.AUTO } }
        }
      }
    },
    sections: [{ headers: { default: header }, footers: { default: footer }, children: body }]
  });
  return Packer.toBlob(doc);
}

// Filename: "[Name] - Individual - Session N - (Exported on D Mon YYYY, Time HHMM).docx"
function formatExportFilenameWord(name, sessionLabel, kind, now) {
  const [y, mo, d] = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const exportDate = `${d} ${months[mo - 1]} ${y}`;
  const hh  = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const sessionPart = sessionLabel ? ` - ${sessionLabel}` : "";
  return `${name} - ${kind}${sessionPart} - (Exported on ${exportDate}, Time ${hh}${min}).docx`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement("a");
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportStudentSingleSessionWord(student, session) {
  if (!student || !session) return;
  if (typeof docx === "undefined") {
    alert("Word export isn't available right now (the docx library didn't load) — check your internet connection and try again.");
    return;
  }

  // Re-fetch both session AND student config from Firestore to guarantee we
  // have the latest data. Without this, the student closure captured at
  // session-picker-open time can hold a stale targets list if targets were
  // added/duplicated after the picker was opened.
  const [freshSession, freshStudent] = await Promise.all([
    getSessionById(session.id),
    getStudentById(student.id)
  ]);
  const sessionToExport  = freshSession  ?? session;
  const studentToExport  = freshStudent  ?? student;

  const allTargets   = getAllTargets(studentToExport).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const sessionLabel = sessionToExport.sessionNumber != null ? `Session ${sessionToExport.sessionNumber}` : "";
  const blob = await buildSingleSessionWordBlob(studentToExport.name, sessionLabel, allTargets, sessionToExport);
  downloadBlob(blob, formatExportFilenameWord(studentToExport.name, sessionLabel, "Individual", new Date()));
}

export async function exportGroupMemberSingleSessionWord(studentName, groups, session) {
  if (!studentName || !groups?.length || !session) return;
  if (typeof docx === "undefined") {
    alert("Word export isn't available right now (the docx library didn't load) — check your internet connection and try again.");
    return;
  }

  // Re-fetch to guarantee latest remarks (same stale-write race as individual export).
  const freshSession = await getSessionById(session.id);
  const sessionToUse = freshSession ?? session;

  const filteredRemarks = Object.fromEntries(
    Object.entries(sessionToUse.remarks || {}).filter(([, r]) => r.studentName === studentName)
  );
  if (Object.keys(filteredRemarks).length === 0) {
    alert(`No session data found for ${studentName} on ${fmtDate(sessionToUse.date)}.`);
    return;
  }

  const studentId      = groups.map(g => g.studentLinks?.[studentName]).find(Boolean);
  const personalNumber = studentId ? sessionToUse.attendeePersonalSessionNumbers?.[studentId] : null;
  const sessionLabel   = personalNumber != null ? `Session ${personalNumber}` : "";

  const allTargets      = unionTargetsByName(groups).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  const filteredSession = { ...sessionToUse, remarks: filteredRemarks };
  const blob = await buildSingleSessionWordBlob(studentName, sessionLabel, allTargets, filteredSession);
  downloadBlob(blob, formatExportFilenameWord(studentName, sessionLabel, "Group", new Date()));
}

// `groups` is optional (defaults to none, so existing callers that only
// pass students still work) — when given, each student's group-session
// data is bundled in too, alongside their individual sessions. Both use the
// same "{Name} - Yearly Summary (...)" filename now, so they're kept in
// separate "Individual Sessions"/"Group Sessions" folders inside the zip to
// avoid one overwriting the other.
export async function exportAllStudents(students, groups = [], includeTrials = false) {
  if (!students || students.length === 0) return;

  const zip = new JSZip();
  const now = new Date();
  let exported = 0;

  for (const student of students) {
    const sessions = await getAllSessionsForStudent(student.id);
    if (sessions.length > 0) {
      const buffer = await buildStudentWorkbook(student, sessions, includeTrials);
      zip.file(`Individual Sessions/${formatExportFilename(student.name, now)}`, buffer);
      exported++;
    }

    // A student can be linked into a group under a free-typed name that
    // doesn't exactly match their registered name — same lookup the
    // single-group "Export" button next to a group attendee already uses
    // (see exportGroupMemberData), just generalized across every group they
    // appear in instead of one.
    const studentGroups = groups.filter(g => Object.values(g.studentLinks || {}).includes(student.id));
    if (studentGroups.length > 0) {
      const groupName = Object.entries(studentGroups[0].studentLinks || {}).find(([, id]) => id === student.id)?.[0];
      let groupSessions = [];
      for (const group of studentGroups) {
        groupSessions.push(...await getAllSessionsForGroup(group.id));
      }
      if (groupName && groupSessions.length > 0) {
        const allTargets = unionTargetsByName(studentGroups);
        const buffer = await buildGroupMemberWorkbook(groupName, allTargets, groupSessions, includeTrials);
        zip.file(`Group Sessions/${formatExportFilename(student.name, now)}`, buffer);
        exported++;
      }
    }
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
          const eff  = snap ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints } : target;
          return calcDailyAverage(s, eff, allTargets);
        })
        .filter(v => v !== null && !isNaN(v));
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
        const eff  = snap ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints } : target;
        return calcDailyAverage(session, eff, allTargets);
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

function buildTargetSheet(target, sessions, allTargets, includeTrials) {
  const blank = () => (includeTrials ? ["", "", "", "", "", ""] : ["", "", "", "", ""]);
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
  const grayRows          = new Set();
  const greenRows         = new Set();
  const sessionDateBlocks = []; // { startRow, endRow, dateLabel, avgScore }
  const spacerRows        = new Set(); // blank rows that should have no borders
  let firstMonth = true;

  for (const [month, monthSessions] of byMonth) {
    const dailyAvgsForMonth = monthSessions
      .map(s => {
        const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
        const eff  = snap
          ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints, predefinedActivities: snap.predefinedActivities || target.predefinedActivities || [] }
          : target;
        return calcDailyAverage(s, eff, allTargets);
      })
      .filter(v => v !== null);
    const monthlyAvg = dailyAvgsForMonth.length > 0 ? avg(dailyAvgsForMonth) : null;

    if (!firstMonth) { spacerRows.add(rows.length); rows.push(blank()); }
    firstMonth = false;

    monthHeaderRows.add(rows.length);
    const monthRow = blank();
    monthRow[0] = `${target.name}  —  ${month}  —  Monthly Average: ${monthlyAvg !== null ? pct(monthlyAvg) : "N/A"}`;
    rows.push(monthRow);
    spacerRows.add(rows.length);
    rows.push(blank()); // blank spacer

    colHeaderRows.add(rows.length);
    rows.push(includeTrials
      ? ["Date", "Activity", "Remark", "Trials", "Score", "Avg Score"]
      : ["Date", "Activity", "Remark", "Score", "Avg Score"]);

    for (const session of monthSessions) {
      const snap = (session.targetsSnapshot || []).find(t => t.name === target.name);
      const effectiveTarget = snap ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints } : target;
      appendSessionRows(rows, sessionDateBlocks, activityHeadingRows, noteRows, grayRows, greenRows, session, effectiveTarget, allTargets, includeTrials);
    }
  }

  return { rows, monthHeaderRows, colHeaderRows, activityHeadingRows, noteRows, grayRows, greenRows, sessionDateBlocks, spacerRows };
}

// ─── SESSION ROWS ────────────────────────────────────────────

// blankRow()/trialsList() exist so every row pushed here has the same
// column count whether or not the Trials column is included — ExcelJS
// merges (month headers, the avg-score column) are addressed by column
// letter/index in addIndividualTargetSheets, so a row with the wrong
// length would silently misalign everything after it.
function trialsList(trials) {
  return (trials || []).map(t => (t === -1 ? "—" : t)).join(", ");
}

function appendSessionRows(rows, sessionDateBlocks, activityHeadingRows, noteRows, grayRows, greenRows, session, target, allTargets, includeTrials) {
  const blankRow = () => (includeTrials ? ["", "", "", "", "", ""] : ["", "", "", "", ""]);
  const [, m, d] = session.date.split("-").map(Number);
  const shortMonths = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dateLabel = `${d} ${shortMonths[m - 1]}`;

  const startRow = rows.length;

  const activities = getAllActivitiesForTarget(session, target);

  if (activities.length === 0) {
    const r = blankRow(); r[1] = "(no data recorded)"; rows.push(r);
  } else {
    for (const act of activities) {
      if (act.isHeading) {
        activityHeadingRows.add(rows.length);
        const r = blankRow(); r[1] = buildExcelActivityCell(act.activityName); rows.push(r);
        continue;
      }

      if (act.isNote) {
        noteRows.add(rows.length);
        const noteText = stripActivityMarkup((act.activityName || "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/div>/gi, "\n").replace(/<div>/gi, "")
          .replace(/<\/p>/gi, "\n").replace(/<p>/gi, "")
          .replace(/<[^>]*>/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim());
        const r = blankRow(); r[1] = `Note: ${noteText}`; rows.push(r);
        continue;
      }

      if (act.isExportNote) {
        noteRows.add(rows.length);
        const noteText = stripActivityMarkup((act.activityName || "")
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/div>/gi, "\n").replace(/<div>/gi, "")
          .replace(/<\/p>/gi, "\n").replace(/<p>/gi, "")
          .replace(/<[^>]*>/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim());
        const r = blankRow(); r[1] = `Note: ${noteText}`; rows.push(r);
        continue;
      }

      if (act.isMaintainHeading) {
        activityHeadingRows.add(rows.length);
        grayRows.add(rows.length);
        const r = blankRow(); r[1] = act.activityName; rows.push(r);
        continue;
      }
      if (act.isGreenHeading) {
        activityHeadingRows.add(rows.length);
        greenRows.add(rows.length);
        const r = blankRow(); r[1] = act.activityName; rows.push(r);
        continue;
      }
      if (act.isMaintain) {
        if (act.isGray) grayRows.add(rows.length);
        if (act.isGreen) greenRows.add(rows.length);
        const r = blankRow(); r[1] = buildExcelActivityCell(act.activityName); r[2] = buildExcelActivityCell(act.maintainRemark || ""); rows.push(r);
        continue;
      }
      if (act.isMasteredSeparator) {
        activityHeadingRows.add(rows.length);
        const r = blankRow(); r[1] = "— Mastered —"; rows.push(r);
        continue;
      }
      if (act.isStoppedSeparator) {
        activityHeadingRows.add(rows.length);
        const r = blankRow(); r[1] = "— Stopped tracking —"; rows.push(r);
        continue;
      }
      if (act.isStopped) {
        if (act.empty) {
          const r = blankRow(); r[1] = buildExcelActivityCell(act.activityName, " (Stopped)"); rows.push(r);
          continue;
        }
      }

      // noRemark parent: numbered title, empty remark
      if (act.noRemark) {
        if (act.isGray) grayRows.add(rows.length);
        if (act.isGreen) greenRows.add(rows.length);
        const r = blankRow(); r[1] = buildExcelActivityCell(act.activityName); rows.push(r);
        continue;
      }

      // Sub-activity: indented lettered label
      if (act.isSubActivity) {
        const subLabel = `    ${act.subLabel}) ${act.activityName}`;
        const subCell  = buildExcelActivityCell(subLabel);
        if (act.isGray) grayRows.add(rows.length);
        if (act.isGreen) greenRows.add(rows.length);
        if (act.empty) {
          const r = blankRow(); r[1] = subCell; rows.push(r);
          continue;
        }
        const subRemarks = getRemarksForActivity(session, act.id).filter(hasRemarkContent);
        const subPa = (target.predefinedActivities || []).find(p => p.name === act.activityName);
        const subStarter = (subPa?.inlineOptions || subPa?.remarkPresetId || subPa?.remarkHasNote) ? (subPa?.sentenceStarter || null) : null;
        if (subRemarks.length === 0) {
          const r = blankRow(); r[1] = subCell; rows.push(r);
        } else {
          let subFirst = true;
          for (const rem of subRemarks) {
            if (act.isGray) grayRows.add(rows.length);
            if (act.isGreen) greenRows.add(rows.length);
            const validTrials = allScores(rem);
            const remarkAvg   = calcRemarkAvg(validTrials, target.maxPoints);
            const r = blankRow();
            r[1] = subFirst ? subCell : "";
            r[2] = buildExcelRemarkCell(rem.text, subStarter, stripRemarkHtml(rem.masteryNote || ""));
            if (includeTrials) { r[3] = trialsList(rem.optionScore !== undefined ? [...(rem.trials || []), rem.optionScore] : rem.trials); r[4] = remarkAvg !== null ? pct(remarkAvg) : ""; }
            else { r[3] = remarkAvg !== null ? pct(remarkAvg) : ""; }
            rows.push(r);
            subFirst = false;
          }
        }
        continue;
      }

      const actNoteText = (target.predefinedActivities || []).find(
        p => !p.isHeading && !p.isNote && p.name === act.activityName
      )?.actNote;
      let activityCell;
      if (actNoteText && actNoteText.trim()) {
        const base = richTextActivityWithNote(act.activityName, stripActivityMarkup(actNoteText.trim()));
        activityCell = act.isMastered
          ? { richText: [...base.richText, { text: " (Mastered ✓)", font: { italic: true, color: { argb: "FF6B7280" } } }] }
          : act.isArchived
          ? { richText: [...base.richText, { text: " (Archived)", font: { italic: true, color: { argb: "FF9CA3AF" } } }] }
          : base;
      } else {
        activityCell = act.isMastered ? buildExcelActivityCell(act.activityName, " (Mastered ✓)")
          : act.isArchived ? buildExcelActivityCell(act.activityName, " (Archived)")
          : buildExcelActivityCell(act.activityName);
      }

      if (act.empty) {
        if (act.isGray) grayRows.add(rows.length);
        if (act.isGreen) greenRows.add(rows.length);
        const r = blankRow(); r[1] = activityCell; rows.push(r);
        continue;
      }

      const remarks = getRemarksForActivity(session, act.id).filter(hasRemarkContent);
      const _starterPaX = (target.predefinedActivities || []).find(p => !p.isHeading && !p.isNote && p.name === act.activityName);
      const starter = (_starterPaX?.inlineOptions || _starterPaX?.remarkPresetId || _starterPaX?.remarkHasNote) ? (_starterPaX?.sentenceStarter || null) : null;

      if (remarks.length === 0) {
        if (act.isGray) grayRows.add(rows.length);
        if (act.isGreen) greenRows.add(rows.length);
        const r = blankRow(); r[1] = activityCell; rows.push(r);
        continue;
      }

      const mappedScore = act.isMapped ? resolveExportMappedScore(act, session, allTargets) : null;

      let firstRemark = true;
      for (const rem of remarks) {
        if (act.isGray) grayRows.add(rows.length);
        if (act.isGreen) greenRows.add(rows.length);
        const validTrials = allScores(rem);
        const remarkAvg   = act.isMapped ? mappedScore : calcRemarkAvg(validTrials, target.maxPoints);
        const masteryNote = stripRemarkHtml(rem.masteryNote || "");
        const r = blankRow();
        r[1] = firstRemark ? activityCell : "";
        r[2] = buildExcelRemarkCell(rem.text, starter, masteryNote);
        if (includeTrials) {
          r[3] = trialsList(rem.optionScore !== undefined ? [...(rem.trials || []), rem.optionScore] : rem.trials);
          r[4] = remarkAvg !== null ? pct(remarkAvg) : "";
        } else {
          r[3] = remarkAvg !== null ? pct(remarkAvg) : "";
        }
        rows.push(r);
        firstRemark = false;
      }
    }

    if (target.hasComment) {
      const commentText = (session.fedcComments || {})[sanitizeKey(target.name)] || "";
      if (commentText) { const r = blankRow(); r[1] = "Comment"; r[2] = commentText; rows.push(r); }
    }
  }

  const daily = calcDailyAverage(session, target, allTargets);
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
  const masteredActivities = [];
  const stoppedActivities  = [];
  let exportActNum = 0;
  const subLabelCounters = {};

  for (const pa of (target.predefinedActivities || [])) {
    if (!isActivityActive(pa, session.date)) continue;
    if ((pa.masteredOn || pa.discontinuedOn) && !sessionActs.some(a => a.activityName === pa.name)) continue;
    if (!pa.name && !pa.isNote && !pa.isExportNote && !pa.isHeading && !pa.isMaintainHeading) continue;
    if (pa.isNote) {
      result.push({ isNote: true, activityName: pa.text || "" });
      continue;
    }
    if (pa.isExportNote) {
      result.push({ isExportNote: true, activityName: pa.text || "" });
      continue;
    }
    if (!pa.name) continue;
    if (pa.isHeading && !pa.headingColor && !pa.isMaintainHeading) {
      result.push({ isHeading: true, activityName: pa.name });
      continue;
    }
    // Gray headings — inline in their natural position
    if ((pa.isHeading && pa.headingColor === "gray") || pa.isMaintainHeading) {
      result.push({ isMaintainHeading: true, activityName: pa.name, isGray: true });
      continue;
    }
    // Green headings — inline in their natural position
    if (pa.isHeading && pa.headingColor === "green") {
      result.push({ isGreenHeading: true, activityName: pa.name });
      continue;
    }

    // Sub-activity: lettered (a, b, c…), no exportActNum increment
    if (pa.parentActivity) {
      if (pa.isCompleted || pa.isArchived || pa.isStopped) continue;
      const si = subLabelCounters[pa.parentActivity] || 0;
      subLabelCounters[pa.parentActivity] = si + 1;
      const subLabel = String.fromCharCode(97 + si);
      const sessionAct = sessionActs.find(a => a.activityName === pa.name && a.isPredefined);
      if (sessionAct) {
        usedIds.add(sessionAct.id);
        result.push({ ...sessionAct, activityName: pa.name, isSubActivity: true, subLabel });
      } else {
        result.push({ id: null, activityName: pa.name, isPredefined: true, empty: true, isSubActivity: true, subLabel });
      }
      continue;
    }

    // All remaining paths are real activities — assign sequential number
    exportActNum++;
    const numberedName = `${exportActNum}) ${pa.name}`;

    // Parent activity (noRemark) — numbered title, empty remark
    if (pa.noRemark) {
      const sActNr = sessionActs.find(a => a.activityName === pa.name && a.isPredefined);
      if (sActNr) usedIds.add(sActNr.id);
      result.push({ id: null, activityName: numberedName, isPredefined: true, noRemark: true, empty: true });
      continue;
    }

    // Fixed remark activities — inline in their natural position (NOT reordered to the bottom)
    if (pa.fixedRemark !== undefined) {
      const isGray = pa.activityColor === "gray" || !!pa.isMaintainLive;
      result.push({ isMaintain: true, activityName: numberedName, maintainRemark: pa.fixedRemark || "", ...(isGray ? { isGray: true } : {}) });
      continue;
    }
    if (pa.isMaintain) {
      const isGray = pa.activityColor === "gray" || !!pa.isMaintainLive;
      result.push({ isMaintain: true, activityName: numberedName, maintainRemark: pa.maintainRemark || "", ...(isGray ? { isGray: true } : {}) });
      continue;
    }
    if (pa.isCompleted) {
      const sessionAct = sessionActs.find(a => a.activityName === pa.name && a.isPredefined);
      if (sessionAct) {
        usedIds.add(sessionAct.id);
        masteredActivities.push({ ...sessionAct, activityName: numberedName, isMastered: true });
      } else {
        masteredActivities.push({ id: null, activityName: numberedName, isPredefined: true, empty: true, isMastered: true });
      }
      continue;
    }
    if (pa.isArchived || pa.isStopped) {
      const sessionAct = sessionActs.find(a => a.activityName === pa.name && a.isPredefined);
      if (sessionAct) {
        usedIds.add(sessionAct.id);
        stoppedActivities.push({ ...sessionAct, activityName: numberedName, isStopped: true });
      } else {
        stoppedActivities.push({ id: null, activityName: numberedName, isPredefined: true, empty: true, isStopped: true });
      }
      continue;
    }
    const sessionAct = sessionActs.find(a => a.activityName === pa.name && a.isPredefined);
    const colorProps = (pa.activityColor === "gray" || pa.isMaintainLive) ? { isGray: true }
                     : pa.activityColor === "green" ? { isGreen: true } : {};
    const manualScoreProp = pa.manualScore ? { manualScore: true } : {};
    if (sessionAct) {
      usedIds.add(sessionAct.id);
      result.push(pa.isMapped
        ? { ...sessionAct, activityName: numberedName, isMapped: true, mappedTargetId: pa.mappedTargetId || null, ...colorProps }
        : { ...sessionAct, activityName: numberedName, ...colorProps, ...manualScoreProp });
    } else {
      result.push({
        id: null, activityName: numberedName, isPredefined: true, empty: true,
        isMapped: pa.isMapped || false, mappedTargetId: pa.mappedTargetId || null, ...colorProps, ...manualScoreProp
      });
    }
  }

  for (const act of sessionActs) {
    if (usedIds.has(act.id)) continue;
    if (act.isPredefined) {
      // No remark data — ghost entry, skip.
      if (getRemarksForActivity(session, act.id).length === 0) continue;
      // Activity is still in the predefined config — it was already rendered by the
      // main loop above. Duplicate session-activity records (caused by the auto-fill
      // race) would otherwise leak through here as unnumbered rows.
      const stillInConfig = (target.predefinedActivities || []).some(
        p => p.name === act.activityName && !p.isHeading && !p.isNote && !p.isExportNote
      );
      if (stillInConfig) continue;
    }
    result.push(act);
  }

  if (masteredActivities.length > 0) {
    result.push({ isMasteredSeparator: true, activityName: "— Mastered —" });
    result.push(...masteredActivities);
  }
  if (stoppedActivities.length > 0) {
    result.push({ isStoppedSeparator: true, activityName: "— Stopped tracking —" });
    result.push(...stoppedActivities);
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

// Returns true if a remark has any real content (text or valid trial scores).
// Empty auto-created remarks (nothing selected / typed / checked) should not
// appear as rows in Word or Excel exports.
function hasRemarkContent(rem) {
  const hasText   = stripRemarkHtml(rem.text || "").trim() !== "";
  const hasTrials = allScores(rem).length > 0;
  return hasText || hasTrials;
}

// ─── CALCULATIONS ────────────────────────────────────────────

function parseManualScore(val) {
  if (!val) return null;
  const s = String(val).trim();
  const frac = s.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if (frac) { const d = parseFloat(frac[2]); return d === 0 ? null : parseFloat(frac[1]) / d * 100; }
  const pct = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return parseFloat(pct[1]);
  const num = s.match(/^(\d+(?:\.\d+)?)$/);
  if (num) return parseFloat(num[1]);
  return null;
}

function allScores(rem) {
  const valid = (rem.trials || []).filter(t => t !== -1);
  if (rem.optionScore !== undefined) valid.push(rem.optionScore);
  return valid;
}

function calcRemarkAvg(trials, maxPoints) {
  if (!trials || trials.length === 0) return null;
  const valid = trials.filter(t => t !== -1);
  if (valid.length === 0) return null;
  const mp = maxPoints || 3;
  return valid.reduce((a, b) => a + b, 0) / (valid.length * mp) * 100;
}

// visited guards against a circular mapping chain recursing forever — direct
// self-mapping is already blocked in the Edit Target picker, this is a
// defensive backstop. allTargets is needed to resolve a mapped activity's
// sibling target by id; group-member exports already pre-filter `session`
// down to one student's remarks before this is ever called, so the
// per-attendee semantics fall out for free without any export-side branching.
function calcDailyAverage(session, target, allTargets = [], visited = new Set()) {
  if (visited.has(target.id)) return null;
  visited.add(target.id);

  const avgs = [];
  for (const act of getAllActivitiesForTarget(session, target)) {
    if (act.isHeading || act.isNote || act.isExportNote || act.empty || act.isMasteredSeparator || act.isStoppedSeparator || act.isMaintainSeparator || act.isMaintain || act.isMaintainHeading || act.fixedRemark !== undefined) continue;
    if (act.isMapped) {
      if (getRemarksForActivity(session, act.id).length === 0) continue;
      const a = resolveExportMappedScore(act, session, allTargets, visited);
      if (a !== null) avgs.push(a);
      continue;
    }
    for (const rem of getRemarksForActivity(session, act.id)) {
      if (act.manualScore) {
        const pct = parseManualScore(stripRemarkHtml(rem.text || "").trim());
        if (pct !== null) avgs.push(pct);
        continue;
      }
      const validTrials = allScores(rem);
      const a = calcRemarkAvg(validTrials, target.maxPoints);
      if (a !== null) avgs.push(a);
    }
  }
  return avgs.length > 0 ? avg(avgs) : null;
}

// Resolves a mapped-score activity's value for export — see calcDaysAverage's
// live-entry counterpart (app.js) for the same idea.
function resolveExportMappedScore(act, session, allTargets, visited) {
  const mappedTarget = act.mappedTargetId ? allTargets.find(t => t.id === act.mappedTargetId) : null;
  if (!mappedTarget) return null;
  return calcDailyAverage(session, mappedTarget, allTargets, visited);
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

function renderTargetChart(targetName, yValues, dateRange, dates, customLabels = null) {
  const SCALE   = 3;
  const canvas  = document.createElement("canvas");
  canvas.width  = 605;
  canvas.height = 340;
  const ctx    = canvas.getContext("2d");
  const shortMonths = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const labels = customLabels || (dates || []).map(d => {
    const [, m, day] = d.split("-").map(Number);
    return `${day} ${shortMonths[m - 1]}`;
  });
  const trend  = linearRegressionValues(yValues);

  // Direction: use the linear regression endpoint difference (slope × (n-1)).
  // More robust than quarter-average comparison and not sensitive to single-session outliers.
  const lrDelta  = Math.round(trend[trend.length - 1] - trend[0]);
  let dirText, dirColor;
  if (Math.abs(lrDelta) <= 8) {
    dirText  = "→  Stable";
    dirColor = "#888888";
  } else if (lrDelta > 0) {
    dirText  = "↑  Trending Up";
    dirColor = "#2A7A3B";
  } else {
    dirText  = "↓  Trending Down";
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
      layout: { padding: { top: 10, left: 18, right: 18, bottom: 20 } },
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
  canvas.height = 380;
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
          ticks: { color: "#000000", maxRotation: 30, autoSkip: false, font: { size: 11 } },
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
