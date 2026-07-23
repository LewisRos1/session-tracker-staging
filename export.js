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
// Mastered / Discontinued separator rows
const STYLE_MASTERED_SEP = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF86EFAC" } },
  font: { bold: true, color: { argb: "FF14532D" } }
};
const STYLE_DISCONTINUED_SEP = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCA5A5" } },
  font: { bold: true, color: { argb: "FF7F1D1D" } }
};
const STYLE_EXTRA_SEP = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFE0E7FF" } },
  font: { bold: true, color: { argb: "FF3730A3" } }
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
  summaryWs.getColumn(1).width = 40;
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
  detWs.getColumn(1).width = 40;
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
  // Compares the first month vs the last month within each calendar half-year
  // (H1 = Jan–Jun, H2 = Jul–Dec) that has data. A new section is added per
  // year-half automatically, so 2027 H1/H2 appear without any code changes.
  const H1_NAMES = new Set(["January","February","March","April","May","June"]);

  const allMonths = [...new Set(sortedSessions.map(s => s.month))].sort((a, b) => {
    const [ma, ya] = parseMonth(a); const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });
  if (allMonths.length < 2) return;

  const sessionsByMonth = {};
  for (const month of allMonths) sessionsByMonth[month] = sortedSessions.filter(s => s.month === month);

  const monthAvgForTarget = (target, monthSessions) => {
    const vals = monthSessions.map(s => {
      const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
      const eff  = snap ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints } : target;
      return calcDailyAverage(s, eff, allTargets);
    }).filter(v => v !== null && !isNaN(v));
    return vals.length > 0 ? avg(vals) : null;
  };

  // Group months into half-year buckets (preserving chronological order)
  const halfYearKeys   = [];
  const halfYearMonths = {};
  for (const month of allMonths) {
    const [name, year] = month.split(" ");
    const half = H1_NAMES.has(name) ? "H1" : "H2";
    const key  = `${half} ${year}`;
    if (!halfYearMonths[key]) { halfYearMonths[key] = []; halfYearKeys.push(key); }
    halfYearMonths[key].push(month);
  }

  const ws = wb.addWorksheet("Half-Year Progress");
  let rowOffset   = 0;
  let firstSect   = true;

  for (const key of halfYearKeys) {
    const months     = halfYearMonths[key];
    const firstMonth = months[0];
    const lastMonth  = months[months.length - 1];
    if (firstMonth === lastMonth) continue; // need at least 2 distinct months

    const [half, year] = key.split(" ");
    const range = half === "H1" ? "Jan – Jun" : "Jul – Dec";

    if (!firstSect) { ws.addRow([]); rowOffset++; }
    firstSect = false;

    // Section title (merged across 3 cols)
    const titleRow = ws.addRow([`${entityName} — ${key}  (${range} ${year})`, "", ""]);
    rowOffset++;
    try { ws.mergeCells(titleRow.number, 1, titleRow.number, 3); } catch (_) {}
    titleRow.getCell(1).fill      = STYLE_SESSION.fill;
    titleRow.getCell(1).font      = STYLE_SESSION.font;
    titleRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };

    // Column headers
    const hdrRow = ws.addRow(["Target", "Earliest Month", "Latest Month"]);
    rowOffset++;
    for (let c = 1; c <= 3; c++) {
      hdrRow.getCell(c).fill      = STYLE_COL_HEADER.fill;
      hdrRow.getCell(c).font      = STYLE_COL_HEADER.font;
      hdrRow.getCell(c).alignment = STYLE_COL_HEADER.alignment;
    }

    const chartTargets = [];
    for (const target of allTargets) {
      // Find the first month in this half-year that has data for this target
      let targetFirstMonth = null;
      let scoreF = null;
      for (const m of months) {
        const s = monthAvgForTarget(target, sessionsByMonth[m] || []);
        if (s !== null) { targetFirstMonth = m; scoreF = s; break; }
      }
      const scoreL = monthAvgForTarget(target, sessionsByMonth[lastMonth] || []);
      // Always show abbreviated month in cell so the reader knows which month each % is from
      const abbr = m => { const [n, y] = m.split(" "); return `${n.slice(0, 3)} ${y}`; };
      const firstCell = scoreF !== null ? `${pct(scoreF)} (${abbr(targetFirstMonth)})` : "";
      const lastCell  = scoreL !== null ? `${pct(scoreL)} (${abbr(lastMonth)})`        : "";
      ws.addRow([target.name, firstCell, lastCell]);
      rowOffset++;
      if (scoreF !== null && scoreL !== null && targetFirstMonth !== lastMonth) {
        chartTargets.push({ name: target.name, first: Math.round(scoreF), last: Math.round(scoreL),
          firstLabel: targetFirstMonth, lastLabel: lastMonth });
      }
    }

    if (typeof Chart !== "undefined" && chartTargets.length > 0) {
      ws.addRow([]); rowOffset++;
      const base64 = renderBaselineChart(
        `${entityName} — ${key}`,
        chartTargets.map(t => t.name),
        chartTargets.map(t => t.first),
        chartTargets.map(t => t.last),
        "Earliest Month Avg",
        "Latest Month Avg"
      );
      const imgId = wb.addImage({ base64, extension: "png" });
      ws.addImage(imgId, { tl: { col: 0, row: rowOffset }, ext: { width: 605, height: 370 } });
      const CHART_ROWS = 22;
      for (let i = 0; i < CHART_ROWS; i++) ws.addRow([]);
      rowOffset += CHART_ROWS;
    }
  }

  ws.getColumn(1).width     = 35;
  ws.getColumn(2).width     = 22;
  ws.getColumn(3).width     = 22;
  ws.getColumn(1).alignment = { vertical: "middle" };
  ws.getColumn(2).alignment = { horizontal: "center", vertical: "middle" };
  ws.getColumn(3).alignment = { horizontal: "center", vertical: "middle" };
  applyBorders(ws, 3);
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
    // Embed legend image instead of a text cell so it can be copy-pasted into Word
    const legendBase64 = renderThresholdLegend();
    const legendImgId  = wb.addImage({ base64: legendBase64, extension: "png" });
    ws.addImage(legendImgId, { tl: { col: 0, row: 0 }, ext: { width: 440, height: 130 } });
    for (let i = 0; i < 7; i++) ws.addRow([]); // blank rows to make space for legend image
    const ROW_OFFSET = 7;
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

      const chartRow = ROW_OFFSET + Math.floor(chartIdx / 2) * 19;
      const chartCol = (chartIdx % 2) * 11;
      ws.addImage(imgId, { tl: { col: chartCol, row: chartRow }, ext: { width: 605, height: 340 } });
      chartIdx++;
    }
  }

  buildSheet("Charts H1 (Jan–Jun)", h1Months);
  buildSheet("Charts H2 (Jul–Dec)", h2Months);
}

// "Trendline Summary" sheet: two separate tables (H1 then H2) with legend image at top.
function addTrendSummarySheet(wb, allTargets, sessions) {
  const H1_NAMES = new Set(["January","February","March","April","May","June"]);
  const NUM_COLS = 5; // Target | Trendline Start % | Trendline End % | Change (pp) | Direction

  const allMonths = [...new Set(sessions.map(s => s.month))].sort((a, b) => {
    const [ma, ya] = parseMonth(a); const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });
  if (allMonths.length === 0) return;

  const halfYearKeys   = [];
  const halfYearMonths = {};
  for (const month of allMonths) {
    const [name, year] = month.split(" ");
    const half = H1_NAMES.has(name) ? "H1" : "H2";
    const key  = `${half} ${year}`;
    if (!halfYearMonths[key]) { halfYearMonths[key] = []; halfYearKeys.push(key); }
    halfYearMonths[key].push(month);
  }

  const ws = wb.addWorksheet("Trendline Summary");

  // Legend image at top (same as Charts H1/H2 sheets)
  const legendBase64 = renderThresholdLegend();
  const legendImgId  = wb.addImage({ base64: legendBase64, extension: "png" });
  ws.addImage(legendImgId, { tl: { col: 0, row: 0 }, ext: { width: 440, height: 130 } });
  for (let i = 0; i < 7; i++) ws.addRow([]); // blank rows to make space for legend image

  let firstSection = true;

  for (const key of halfYearKeys) {
    const months = halfYearMonths[key];
    const [half, year] = key.split(" ");
    const range = half === "H1" ? "Jan – Jun" : "Jul – Dec";

    if (!firstSection) ws.addRow([]); // blank gap between H1 and H2 tables
    firstSection = false;

    // Section title (merged across all cols)
    const titleRow = ws.addRow([`${key}  (${range} ${year})`, "", "", "", ""]);
    try { ws.mergeCells(titleRow.number, 1, titleRow.number, NUM_COLS); } catch (_) {}
    titleRow.getCell(1).fill      = STYLE_SESSION.fill;
    titleRow.getCell(1).font      = STYLE_SESSION.font;
    titleRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };

    // Column header row
    const hdr = ws.addRow(["Target", "Trendline Start", "Trendline End", "Net Change (pts)", "Status"]);
    for (let c = 1; c <= NUM_COLS; c++) {
      hdr.getCell(c).fill      = STYLE_COL_HEADER.fill;
      hdr.getCell(c).font      = STYLE_COL_HEADER.font;
      hdr.getCell(c).alignment = STYLE_COL_HEADER.alignment;
    }

    // Compute all rows first, then sort highest delta → lowest
    const trendRows = allTargets.map(target => {
      const yValues = [];
      for (const month of months) {
        const monthSessions = sessions.filter(s => s.month === month);
        const vals = monthSessions.map(s => {
          const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
          const eff  = snap ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints } : target;
          return calcDailyAverage(s, eff, allTargets);
        }).filter(v => v !== null && !isNaN(v));
        if (vals.length > 0) yValues.push(Math.round(avg(vals)));
      }
      if (yValues.length < 2) {
        return { name: target.name, noData: true, single: yValues.length === 1, delta: -Infinity };
      }
      const trend  = linearRegressionValues(yValues);
      const tStart = Math.round(trend[0]);
      const tEnd   = Math.round(trend[trend.length - 1]);
      const delta  = tEnd - tStart;
      const direction = Math.abs(delta) <= 8 ? "Stable" : delta > 0 ? "Trending Up" : "Trending Down";
      return { name: target.name, tStart, tEnd, delta, direction, noData: false };
    });
    trendRows.sort((a, b) => b.delta - a.delta); // highest → lowest; no-data rows (-Infinity) sink to bottom

    for (const row of trendRows) {
      if (row.noData) {
        const dirLabel = row.single ? "Single month" : "No data";
        const r = ws.addRow([row.name, "", "", "", dirLabel]);
        r.getCell(5).font = { italic: true, color: { argb: "FF9CA3AF" } };
        continue;
      }
      const deltaStr = row.delta >= 0 ? `+${row.delta}` : `${row.delta}`;
      const r        = ws.addRow([row.name, `${row.tStart}%`, `${row.tEnd}%`, deltaStr, row.direction]);
      const dirColor = row.direction === "Trending Up" ? "FF16A34A" : row.direction === "Trending Down" ? "FFDC2626" : "FF6B7280";
      r.getCell(5).font = { bold: true, color: { argb: dirColor } };
    }

    // Overview bar chart for this period
    const chartRows = [...trendRows.filter(r => !r.noData)].sort((a, b) => a.delta - b.delta);
    if (chartRows.length > 0) {
      ws.addRow([]); // blank gap before chart
      const ovResult = drawOverviewChart(chartRows, `${range} ${year} Progress`);
      if (ovResult) {
        const ovImgId = wb.addImage({ base64: ovResult.base64, extension: "png" });
        const imgRow0 = ws.lastRow.number - 1; // 0-indexed row for image placement
        ws.addImage(ovImgId, { tl: { col: 0, row: imgRow0 }, ext: { width: 700, height: ovResult.height } });
        const spacingRows = Math.ceil(ovResult.height / 18) + 2;
        for (let i = 0; i < spacingRows; i++) ws.addRow([]);
      }
    }
  }

  ws.getColumn(1).width = 35;
  ws.getColumn(2).width = 19;
  ws.getColumn(3).width = 19;
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 16;
  ws.getColumn(1).alignment = { vertical: "middle" };
  for (let c = 2; c <= NUM_COLS; c++) {
    ws.getColumn(c).alignment = { horizontal: "center", vertical: "middle" };
  }
  applyBorders(ws, NUM_COLS);
}

function drawOverviewChart(chartTrendRows, title) {
  const n = chartTrendRows.length;
  if (n === 0) return null;
  const W = 700, PAD_L = 55, PAD_R = 20, PAD_TOP = 55, PAD_BTM = 215;
  const TOP_H = 200, MID_GAP = 38, BTM_H = 160;
  const CHART_W = W - PAD_L - PAD_R;
  const H = PAD_TOP + TOP_H + MID_GAP + BTM_H + PAD_BTM;
  const slotW = CHART_W / n;
  const BAR_W = Math.max(8, Math.min(28, Math.floor(slotW / 2 - 4)));
  const maxAbs = Math.max(...chartTrendRows.map(r => Math.abs(r.delta)), 10);
  const TOP_BTM_Y = PAD_TOP + TOP_H;
  const BTM_Y0    = PAD_TOP + TOP_H + MID_GAP;
  const BTM_BTM_Y = BTM_Y0 + BTM_H;
  const NET_CTR_Y = BTM_Y0 + BTM_H / 2;
  const C_START = "#7dd3fc", C_END = "#a78bfa", C_UP = "#22c55e", C_DOWN = "#ef4444", C_STABLE = "#9ca3af";

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);

  // Chart title
  if (title) {
    ctx.fillStyle = "#111827"; ctx.font = "bold 19px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(title, W / 2, 30);
  }

  // Rotated y-axis labels
  ctx.save();
  ctx.fillStyle = "#374151"; ctx.font = "bold 17px sans-serif"; ctx.textAlign = "center";
  ctx.translate(38, PAD_TOP + TOP_H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Overall Performance (%)", 0, 0);
  ctx.restore();
  ctx.save();
  ctx.fillStyle = "#374151"; ctx.font = "bold 17px sans-serif"; ctx.textAlign = "center";
  ctx.translate(38, BTM_Y0 + BTM_H / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("Net Change (pts)", 0, 0);
  ctx.restore();

  // Top gridlines
  for (const tick of [0, 20, 40, 60, 80, 100]) {
    const y = TOP_BTM_Y - (tick / 100) * TOP_H;
    ctx.strokeStyle = tick === 0 ? "#9ca3af" : "#e5e7eb"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
  }

  // Separator band
  ctx.fillStyle = "#f3f4f6"; ctx.fillRect(PAD_L, TOP_BTM_Y + 4, CHART_W, MID_GAP - 8);

  // Bottom gridlines
  for (const tick of [-maxAbs, -Math.round(maxAbs / 2), 0, Math.round(maxAbs / 2), maxAbs]) {
    const y = NET_CTR_Y - (tick / maxAbs) * (BTM_H / 2);
    ctx.strokeStyle = tick === 0 ? "#374151" : "#e5e7eb"; ctx.lineWidth = tick === 0 ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(W - PAD_R, y); ctx.stroke();
  }

  for (let i = 0; i < n; i++) {
    const r = chartTrendRows[i];
    const cx = PAD_L + (i + 0.5) * slotW;
    const dc = r.direction === "Trending Up" ? C_UP : r.direction === "Trending Down" ? C_DOWN : C_STABLE;
    const sH = Math.max(2, (r.tStart / 100) * TOP_H);
    const sX = cx - BAR_W - 2;
    ctx.fillStyle = C_START; ctx.fillRect(sX, TOP_BTM_Y - sH, BAR_W, sH);
    ctx.fillStyle = "#111827"; ctx.font = "18px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(String(r.tStart), sX + BAR_W / 2, TOP_BTM_Y - sH - 4);
    const eH = Math.max(2, (r.tEnd / 100) * TOP_H);
    const eX = cx + 2;
    ctx.fillStyle = C_END; ctx.fillRect(eX, TOP_BTM_Y - eH, BAR_W, eH);
    ctx.fillStyle = "#111827"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(String(r.tEnd), eX + BAR_W / 2, TOP_BTM_Y - eH - 4);
    const barH = Math.max(3, (Math.abs(r.delta) / maxAbs) * (BTM_H / 2));
    const barX = cx - BAR_W / 2;
    const dl = (r.delta >= 0 ? "+" : "") + r.delta;
    if (r.delta > 0) {
      ctx.fillStyle = dc; ctx.fillRect(barX, NET_CTR_Y - barH, BAR_W, barH);
      ctx.fillStyle = "#111827"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(dl, cx, NET_CTR_Y - barH - 4);
    } else if (r.delta < 0) {
      ctx.fillStyle = dc; ctx.fillRect(barX, NET_CTR_Y, BAR_W, barH);
      ctx.fillStyle = "#111827"; ctx.font = "bold 18px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(dl, cx, NET_CTR_Y + barH + 20);
    } else {
      ctx.fillStyle = C_STABLE; ctx.fillRect(barX, NET_CTR_Y - 1, BAR_W, 2);
      ctx.fillStyle = "#374151"; ctx.font = "18px sans-serif"; ctx.textAlign = "center";
      ctx.fillText("0", cx, NET_CTR_Y - 5);
    }
    const name = r.name.trim().length > 17 ? r.name.trim().slice(0, 16) + "…" : r.name.trim();
    ctx.save();
    ctx.translate(cx, BTM_BTM_Y + 8);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = "#111827"; ctx.font = "18px sans-serif"; ctx.textAlign = "right";
    ctx.fillText(name, 0, 0);
    ctx.restore();
  }

  // Legend — 2 rows: row1=term colours, row2=trend directions
  const LEG_R1 = [
    { color: C_START, label: "Term Start" },
    { color: C_END,   label: "Term End" }
  ];
  const LEG_R2 = [
    { color: C_DOWN,   label: "Trending Down (<-8 pts)" },
    { color: C_STABLE, label: "Stable (±8 pts)" },
    { color: C_UP,     label: "Trending Up (>+8 pts)" }
  ];
  ctx.font = "17px sans-serif";
  const BOX = 14, GAP = 5, SPC = 16, ROW_H = 26;
  const legY0 = BTM_BTM_Y + 158;
  [LEG_R1, LEG_R2].forEach((row, ri) => {
    const rowW = row.reduce((acc, { label }) => acc + BOX + GAP + Math.ceil(ctx.measureText(label).width) + SPC, 0) - SPC;
    let lx = PAD_L + (CHART_W - rowW) / 2;
    const ly = legY0 + ri * ROW_H;
    row.forEach(({ color, label }) => {
      ctx.fillStyle = color; ctx.fillRect(lx, ly - BOX + 2, BOX, BOX);
      ctx.fillStyle = "#374151"; ctx.textAlign = "left";
      ctx.fillText(label, lx + BOX + GAP, ly);
      lx += BOX + GAP + Math.ceil(ctx.measureText(label).width) + SPC;
    });
  });

  // Border
  ctx.strokeStyle = "#000000"; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  return { base64: canvas.toDataURL("image/png").split(",")[1], height: H };
}

export function renderActivityBreakdownChart(targetName, activityData, periodLabel, chartTitle = null) {
  if (!activityData || activityData.length === 0) return null;
  const SCALE = 2, R = 7, SECTION_H = 28;
  const PAD = { top: 52, right: 148, bottom: 72, left: 250 };
  const W = 760;
  const MONTHS_COL_X = 664, MONTHS_COL_W = 56;
  const LABEL_MAX_W = PAD.left - 16;
  const LINE_H = 13, ROW_PAD_V = 8, MIN_ROW_H = 36;

  // Strip leading letter-prefix and markdown bold/underline markers from chart labels
  const stripPrefix = name => name.replace(/\*/g, "").replace(/_/g, "");

  // Pre-compute wrapped label lines and dynamic row heights using a temp canvas
  const tmpCtx = document.createElement("canvas").getContext("2d");
  tmpCtx.font = "11px sans-serif";
  const wrapText = (text, maxW) => {
    const words = (text || "").split(" ");
    const lines = []; let cur = "";
    for (const w of words) {
      const test = cur ? cur + " " + w : w;
      if (tmpCtx.measureText(test).width > maxW && cur) { lines.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  };
  for (const act of activityData) {
    if (!act.isSectionHeader) {
      act._lines = wrapText(stripPrefix(act.name || ""), LABEL_MAX_W);
      act._rowH = Math.max(MIN_ROW_H, act._lines.length * LINE_H + ROW_PAD_V * 2);
    }
  }

  const totalContentH = activityData.reduce((s, a) => s + (a.isSectionHeader ? SECTION_H : a._rowH), 0);
  const H = PAD.top + totalContentH + PAD.bottom;
  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE; canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, W, H);
  const cW = W - PAD.left - PAD.right;
  const toX = v => PAD.left + (v / 100) * cW;
  const plotBottom = PAD.top + totalContentH;

  ctx.font = "bold 13px sans-serif"; ctx.fillStyle = "#111"; ctx.textAlign = "left";
  ctx.fillText(chartTitle || `${targetName} — Progress (${periodLabel})`, 10, 28);

  // Column headers
  ctx.font = "bold 9.5px sans-serif"; ctx.fillStyle = "#6b7280";
  ctx.textAlign = "right";  ctx.fillText("Activity",  PAD.left - 10, PAD.top - 7);
  ctx.textAlign = "center"; ctx.fillText("Progress",  PAD.left + cW / 2, PAD.top - 7);
  ctx.textAlign = "center"; ctx.fillText("Months",    MONTHS_COL_X + MONTHS_COL_W / 2, PAD.top - 7);
  ctx.strokeStyle = "#9ca3af"; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(0, PAD.top - 1); ctx.lineTo(W, PAD.top - 1); ctx.stroke();

  // Row backgrounds
  let yPos = PAD.top;
  let dataRowIdx = 0;
  for (const act of activityData) {
    if (act.isSectionHeader) {
      ctx.fillStyle = "#e5e7eb"; ctx.fillRect(0, yPos, W, SECTION_H);
      yPos += SECTION_H;
    } else {
      if (dataRowIdx % 2 === 0) { ctx.fillStyle = "#f9fafb"; ctx.fillRect(0, yPos, W, act._rowH); }
      dataRowIdx++; yPos += act._rowH;
    }
  }

  // Gridlines
  ctx.strokeStyle = "#e5e7eb"; ctx.lineWidth = 1;
  for (const v of [0, 25, 50, 75, 100]) {
    const x = toX(v);
    ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, plotBottom); ctx.stroke();
  }
  // Months column separator
  ctx.strokeStyle = "#d1d5db"; ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(MONTHS_COL_X, PAD.top - 1); ctx.lineTo(MONTHS_COL_X, plotBottom); ctx.stroke();

  // Activity rows
  yPos = PAD.top;
  for (const act of activityData) {
    if (act.isSectionHeader) {
      ctx.font = "bold 11px sans-serif"; ctx.fillStyle = "#374151"; ctx.textAlign = "left";
      ctx.fillText(act.label, 10, yPos + SECTION_H / 2 + 4);
      yPos += SECTION_H;
      continue;
    }
    const rowH = act._rowH;
    const cy = yPos + rowH / 2;
    yPos += rowH;

    // Draw wrapped label lines, vertically centred in the row
    ctx.font = "11px sans-serif"; ctx.fillStyle = "#374151"; ctx.textAlign = "right";
    const totalTextH = act._lines.length * LINE_H;
    const textStartY = cy - totalTextH / 2 + LINE_H - 3;
    act._lines.forEach((line, li) => ctx.fillText(line, PAD.left - 10, textStartY + li * LINE_H));

    const eAvg = act.earliestAvg != null ? Math.round(act.earliestAvg) : null;
    const lAvg = act.latestAvg != null ? Math.round(act.latestAvg) : null;
    if (eAvg === null && lAvg === null) continue;

    const eX = eAvg !== null ? toX(eAvg) : null;
    const lX = lAvg !== null ? toX(lAvg) : null;
    ctx.font = "bold 10px sans-serif";

    if (eAvg !== null && lAvg !== null && eAvg === lAvg) {
      ctx.beginPath(); ctx.arc(lX, cy, R, 0, Math.PI * 2);
      ctx.fillStyle = "#3b82f6"; ctx.fill(); ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = "#1d4ed8"; ctx.textAlign = "left";
      ctx.fillText(`${lAvg}%`, lX + R + 3, cy + 4);
    } else {
      if (eX !== null && lX !== null) {
        const diff = lAvg - eAvg;
        ctx.strokeStyle = diff > 8 ? "#22c55e" : diff < -8 ? "#ef4444" : "#d1d5db";
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(eX, cy); ctx.lineTo(lX, cy); ctx.stroke();
      }
      if (eX !== null) {
        ctx.beginPath(); ctx.arc(eX, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = "#9ca3af"; ctx.fill(); ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = "#6b7280";
        if (lAvg === null || eAvg <= lAvg) { ctx.textAlign = "right"; ctx.fillText(`${eAvg}%`, eX - R - 3, cy + 4); }
        else { ctx.textAlign = "left"; ctx.fillText(`${eAvg}%`, eX + R + 3, cy + 4); }
      }
      if (lX !== null) {
        ctx.beginPath(); ctx.arc(lX, cy, R, 0, Math.PI * 2);
        ctx.fillStyle = "#3b82f6"; ctx.fill(); ctx.strokeStyle = "#1d4ed8"; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = "#1d4ed8";
        if (eAvg === null || lAvg >= eAvg) { ctx.textAlign = "left"; ctx.fillText(`${lAvg}%`, lX + R + 3, cy + 4); }
        else { ctx.textAlign = "right"; ctx.fillText(`${lAvg}%`, lX - R - 3, cy + 4); }
      }
    }

    // Month count in Months column
    if (act.monthCount != null) {
      ctx.font = "11px sans-serif"; ctx.fillStyle = "#374151"; ctx.textAlign = "center";
      ctx.fillText(String(act.monthCount), MONTHS_COL_X + MONTHS_COL_W / 2, cy + 4);
    }
  }

  ctx.font = "10px sans-serif"; ctx.textAlign = "left";
  const legY1 = plotBottom + 26, legY2 = plotBottom + 48;
  const drawDot = (x, y, color, stroke) => { ctx.beginPath(); ctx.arc(x, y - 4, 6, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); };
  const drawLegLine = (x, y, color) => { ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 18, y - 4); ctx.stroke(); };
  let lx = Math.round((W - 206) / 2);
  drawDot(lx + 6, legY1, "#9ca3af", "#6b7280"); ctx.fillStyle = "#374151"; ctx.fillText("Earliest month", lx + 16, legY1); lx += 106;
  drawDot(lx + 6, legY1, "#3b82f6", "#1d4ed8"); ctx.fillStyle = "#374151"; ctx.fillText("Latest month",   lx + 16, legY1);
  lx = Math.round((W - 406) / 2);
  drawLegLine(lx, legY2, "#ef4444"); ctx.fillStyle = "#374151"; ctx.fillText("Declined (<−8 pts)", lx + 22, legY2); lx += 136;
  drawLegLine(lx, legY2, "#d1d5db"); ctx.fillStyle = "#374151"; ctx.fillText("Stable (±8 pts)",    lx + 22, legY2); lx += 116;
  drawLegLine(lx, legY2, "#22c55e"); ctx.fillStyle = "#374151"; ctx.fillText("Improved (>+8 pts)", lx + 22, legY2);

  ctx.strokeStyle = "#000000"; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
  return { base64: canvas.toDataURL("image/png").split(",")[1], height: H };
}

function addActivityBreakdownSheet(wb, allTargets, sessions) {
  const allMonths = [...new Set(sessions.map(s => s.month))].sort((a, b) => {
    const [ma, ya] = parseMonth(a); const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });
  if (allMonths.length === 0) return;

  // Convert "YYYY-MM-DD" → "MonthName YYYY" for period comparison
  const dateToMonthLabel = dateStr => {
    if (!dateStr) return null;
    const parts = dateStr.split("-");
    const y = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
    const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    return `${names[m - 1]} ${y}`;
  };
  const [sm, sy] = parseMonth(allMonths[0]);
  const [em, ey] = parseMonth(allMonths[allMonths.length - 1]);
  const monthInPeriod = monthLabel => {
    if (!monthLabel) return false;
    const [pm, py] = parseMonth(monthLabel);
    return (py > sy || (py === sy && pm >= sm)) && (py < ey || (py === ey && pm <= em));
  };

  // Period label: "Jan–Jun 2026" or "Dec 2025–Jan 2026" for cross-year
  const fM = allMonths[0].split(" "), lM = allMonths[allMonths.length - 1].split(" ");
  const periodLabel = fM[1] === lM[1]
    ? `${fM[0].slice(0, 3)}–${lM[0].slice(0, 3)} ${lM[1]}`
    : `${fM[0].slice(0, 3)} ${fM[1]}–${lM[0].slice(0, 3)} ${lM[1]}`;

  const ws = wb.addWorksheet("Activity Breakdown");
  let rowOffset = 0;

  for (const target of allTargets) {
    const actDisplayNameMap = {};  // only for extraNames fallback
    const actStatusMap = {};
    // Per-section display name maps so the same pa.name in multiple sections
    // gets the correct section-specific counter (avoids last-write-wins overwrite).
    const activeDNMap = {}, masteredDNMap = {}, discontinuedDNMap = {};
    // Track ordered lists for each section
    const activeNames = [], masteredNames = [], discontinuedNames = [];
    // Pre-build parent map so sub-activities inherit discontinued/mastered status
    const parentPaMap = {};
    for (const pa of (target.predefinedActivities || [])) {
      if (!pa.parentActivity && (pa.name || pa.title)) parentPaMap[pa.title || pa.name] = pa;
    }
    // When a user moves an activity name from pa.name → pa.title, some session records
    // still carry activityName = old pa.name, or a combined "title + details" string from
    // before the title field existed. Build alias maps so buildEntry merges those records
    // into the correct predefined entry instead of showing them as duplicate extra rows.
    const paKeyToAliases  = {};  // paKey (display title) → [legacy activityName values]
    const paLegacyToKey   = {};  // exact legacy pa.name → paKey
    const paConfigIdToKey = {};  // pa.id → paKey (most reliable redirect)
    const paKeySearchText = {};  // paKey → lowercase combined title+name for fuzzy orphan matching
    for (const pa of (target.predefinedActivities || [])) {
      const key = pa.title || pa.name;
      if (!key) continue;
      if (pa.id) paConfigIdToKey[pa.id] = key;
      if (pa.title && pa.name && pa.title !== pa.name) {
        if (!paKeyToAliases[key]) paKeyToAliases[key] = [];
        paKeyToAliases[key].push(pa.name);
        paLegacyToKey[pa.name] = key;
      }
      paKeySearchText[key] = ((pa.title || "") + " " + (pa.name || "")).toLowerCase();
    }

    let activeIdx = 0, masteredIdx = 0, discontinuedIdx = 0;
    const parentSectionIdx = {}; // standalone pa.name → its section counter value (for sub-act labels)
    const parentSubCount   = {}; // parent pa.name → how many sub-acts have been labelled so far
    for (const pa of (target.predefinedActivities || [])) {
      if ((!pa.name && !pa.title) || pa.isHeading || pa.isNote || pa.isExportNote || pa.isMaintainHeading || pa.isMaintain
          || pa.isCompleted) continue;

      const parentPa = pa.parentActivity ? parentPaMap[pa.parentActivity] : null;
      const effectiveMasteredOn     = pa.masteredOn     || parentPa?.masteredOn;
      const effectiveDiscontinuedOn = pa.discontinuedOn || parentPa?.discontinuedOn;
      const effectiveArchived       = pa.isArchived || pa.isStopped || parentPa?.isArchived || parentPa?.isStopped;

      const masteredMonth     = dateToMonthLabel(effectiveMasteredOn);
      const discontinuedMonth = dateToMonthLabel(effectiveDiscontinuedOn);

      const isActive       = !effectiveMasteredOn && !effectiveDiscontinuedOn && !effectiveArchived;
      const isMastered     = !!effectiveMasteredOn && monthInPeriod(masteredMonth);
      const isDiscontinued = !effectiveMasteredOn && (effectiveArchived || (!!effectiveDiscontinuedOn && monthInPeriod(discontinuedMonth)));

      if (!isActive && !isMastered && !isDiscontinued) continue;

      const dnMap = isActive ? activeDNMap : isMastered ? masteredDNMap : discontinuedDNMap;

      let displayName;
      if (pa.parentActivity) {
        // Sub-activity: does NOT increment the section counter.
        // Unnamed ones use parent's index + letter suffix (a, b, c…).
        const pIdx   = parentSectionIdx[pa.parentActivity];
        const letterN = parentSubCount[pa.parentActivity] ?? 0;
        parentSubCount[pa.parentActivity] = letterN + 1;
        const letter = String.fromCharCode(97 + letterN);
        const subBase = (pa.title || pa.name || "").trim();
        displayName = pIdx != null
          ? `${pIdx}) ${letter}) ${subBase || `<Sub ${letter}>`}`
          : `${letter}) ${subBase || `<Sub-Activity ${letter}>`}`;
      } else {
        // Standalone activity: increment the section counter.
        let sectionIdx;
        if (isActive)        { sectionIdx = ++activeIdx; }
        else if (isMastered) { sectionIdx = ++masteredIdx; }
        else                 { sectionIdx = ++discontinuedIdx; }
        displayName = `${sectionIdx}) ${pa.title?.trim() || pa.name?.trim() || `<Activity ${sectionIdx}>`}`;
        parentSectionIdx[pa.title || pa.name] = sectionIdx;
      }

      const paKey = pa.title || pa.name;
      dnMap[paKey] = displayName;

      if (isActive)            { actStatusMap[paKey] = "active";       activeNames.push(paKey); }
      else if (isMastered)     { actStatusMap[paKey] = "mastered";     masteredNames.push(paKey); }
      else if (isDiscontinued) { actStatusMap[paKey] = "discontinued"; discontinuedNames.push(paKey); }
    }

    // Extra activities from session data not in predefined
    const extraNames = [];
    for (const sess of sessions) {
      for (const [, a] of Object.entries(sess.activities || {})) {
        if ((a.targetName === target.name || a.target === target.name) && a.activityName && !a.isHeading && !a.isNote) {
          if (!activeDNMap[a.activityName] && !masteredDNMap[a.activityName] && !discontinuedDNMap[a.activityName]
              && !actDisplayNameMap[a.activityName]) {
            // Redirect to predefined activity via configId (most reliable) or exact legacy pa.name match
            const paKey = (a.configId && paConfigIdToKey[a.configId]) || paLegacyToKey[a.activityName];
            if (paKey) {
              if (!paKeyToAliases[paKey]) paKeyToAliases[paKey] = [];
              if (!paKeyToAliases[paKey].includes(a.activityName)) paKeyToAliases[paKey].push(a.activityName);
              const status = actStatusMap[paKey] || "active";
              const targetDNMap = status === "mastered" ? masteredDNMap : status === "discontinued" ? discontinuedDNMap : activeDNMap;
              targetDNMap[a.activityName] = targetDNMap[paKey] || paKey;
              continue;
            }
            // Skip records with an unrecognised configId — created from a predefined activity
            // config that has since been deleted or restructured with a new pa.id.
            if (a.configId && !paConfigIdToKey[a.configId]) continue;
            // Fuzzy word-overlap: if ≥50% of the record's significant words (4+ chars) match
            // text in any predefined activity's combined title+name, it's likely an orphaned
            // predefined record whose name changed beyond what the alias maps can reach.
            // Minimum 5 words required to avoid false-positives on short user-added extras.
            const actWords = a.activityName.toLowerCase().match(/\b[a-z]{4,}\b/g);
            if (actWords && actWords.length >= 5) {
              const isOrphanedPredefined = Object.values(paKeySearchText).some(
                text => actWords.filter(w => text.includes(w)).length / actWords.length >= 0.5
              );
              if (isOrphanedPredefined) continue;
            }
            // Skip orphaned predefined records: isPredefined=true means the record was created
            // from a predefined activity config entry — if it got here it means the config name
            // has since changed and we have no way to match it back. Showing it as a separate
            // row would create duplicates. Non-predefined records are genuinely user-added extras.
            if (a.isPredefined) continue;
            actDisplayNameMap[a.activityName] = a.activityTitle || a.activityName;
            actStatusMap[a.activityName] = "active";
            extraNames.push(a.activityName);
          }
        }
      }
    }

    const allNames = [...activeNames, ...masteredNames, ...discontinuedNames, ...extraNames];
    if (allNames.length === 0) continue;

    // Build score data for each activity name; dnMap supplies the display label.
    // aliases lets buildEntry find records stored under legacy activityName variants.
    const buildEntry = (actName, dnMap, aliases = []) => {
      const monthBuckets = {};
      for (const sess of sessions) {
        const actEntry = Object.entries(sess.activities || {}).find(
          ([, a]) => (a.activityName === actName || aliases.includes(a.activityName)) && (a.targetName === target.name || a.target === target.name)
        );
        if (!actEntry) continue;
        const [actKey, act] = actEntry;
        const actId = act.id || actKey;
        const snap = (sess.targetsSnapshot || []).find(t => t.name === target.name);
        const mp = (snap ? (snap.maxPoints ?? target.maxPoints) : target.maxPoints) || 3;
        for (const rem of getRemarksForActivity(sess, actId)) {
          const scores = allScores(rem);
          if (scores.length === 0) continue;
          const pct = scores.reduce((a, b) => a + b, 0) / (scores.length * mp) * 100;
          if (!monthBuckets[sess.month]) monthBuckets[sess.month] = [];
          monthBuckets[sess.month].push(pct);
        }
      }
      let earliest = null, latest = null;
      for (const month of allMonths) {
        const scores = monthBuckets[month];
        if (!scores || scores.length === 0) continue;
        const mAvg = scores.reduce((a, b) => a + b, 0) / scores.length;
        if (earliest === null) earliest = { label: month.split(" ")[0].slice(0, 3), avg: mAvg };
        latest = { label: month.split(" ")[0].slice(0, 3), avg: mAvg };
      }
      if (earliest === null) return null;
      const monthCount = Object.values(monthBuckets).filter(b => b.length > 0).length;
      return { name: dnMap[actName] || actName, earliestLabel: earliest.label, earliestAvg: earliest.avg, latestLabel: latest.label, latestAvg: latest.avg, monthCount };
    };

    const activeData       = activeNames.map(n => buildEntry(n, activeDNMap, paKeyToAliases[n] || [])).filter(Boolean);
    const masteredData     = masteredNames.map(n => buildEntry(n, masteredDNMap, paKeyToAliases[n] || [])).filter(Boolean);
    const discontinuedData = discontinuedNames.map(n => buildEntry(n, discontinuedDNMap, paKeyToAliases[n] || [])).filter(Boolean);
    const extraData        = extraNames.map(n => buildEntry(n, actDisplayNameMap)).filter(Boolean);

    const activityData = [
      ...activeData,
      ...extraData,
      ...(masteredData.length > 0 ? [{ isSectionHeader: true, label: "Mastered" }, ...masteredData] : []),
      ...(discontinuedData.length > 0 ? [{ isSectionHeader: true, label: "Discontinued" }, ...discontinuedData] : []),
    ];
    if (activityData.filter(a => !a.isSectionHeader).length === 0) continue;

    const chartResult = renderActivityBreakdownChart(target.name, activityData, periodLabel);
    if (!chartResult) continue;
    const { base64, height: chartH } = chartResult;
    const imgId = wb.addImage({ base64, extension: "png" });
    ws.addImage(imgId, { tl: { col: 0, row: rowOffset }, ext: { width: 673, height: chartH } });
    const rowsNeeded = Math.ceil(chartH / 20) + 3;
    for (let r = rowOffset; r < rowOffset + rowsNeeded; r++) ws.addRow([]);
    rowOffset += rowsNeeded;
  }
}

function addActivityScoreSheet(wb, allTargets, sessions) {
  // Sessions in chronological order
  const sortedSessions = sessions.slice().sort((a, b) => a.date.localeCompare(b.date));
  if (sortedSessions.length === 0) return;

  const allMonths = [...new Set(sortedSessions.map(s => s.month).filter(Boolean))].sort((a, b) => {
    const [ma, ya] = parseMonth(a); const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  });
  if (allMonths.length === 0) return;

  // Build ordered column descriptors: one per session + one Avg per month
  // col = { type:"session", sess, month } | { type:"avg", month }
  const cols = [];
  for (const month of allMonths) {
    const monthSessions = sortedSessions.filter(s => s.month === month);
    for (const sess of monthSessions) cols.push({ type: "session", sess, month });
    cols.push({ type: "avg", month });
  }

  const ws = wb.addWorksheet("Score Reference");
  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 50;
  // Session cols: narrow; Avg cols: slightly wider
  cols.forEach((col, i) => { ws.getColumn(3 + i).width = col.type === "avg" ? 9 : 7; });

  // Header row: date labels for session cols, "Mon YY Avg" for avg cols
  const AVG_FILL   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFcfe2f3" } };
  const AVG_FONT   = { bold: true, size: 9, color: { argb: "FF1e3a5f" } };
  const SESS_FILL  = STYLE_COL_HEADER.fill;
  const SESS_FONT  = { ...STYLE_COL_HEADER.font, size: 9 };

  const hdrLabels = cols.map(col => {
    if (col.type === "avg") {
      const [mn, yr] = col.month.split(" ");
      return `${mn.slice(0,3)} ${yr.slice(2)}\nAvg`;
    }
    const [, , day] = col.sess.date.split("-");
    const [mn] = col.month.split(" ");
    return `${parseInt(day)}\n${mn.slice(0,3)}`;
  });

  const hdr = ws.addRow(["Target", "Activity", ...hdrLabels]);
  hdr.height = 30;
  hdr.getCell(1).fill = STYLE_COL_HEADER.fill; hdr.getCell(1).font = STYLE_COL_HEADER.font;
  hdr.getCell(1).alignment = { horizontal: "left", vertical: "middle" };
  hdr.getCell(2).fill = STYLE_COL_HEADER.fill; hdr.getCell(2).font = STYLE_COL_HEADER.font;
  hdr.getCell(2).alignment = { horizontal: "left", vertical: "middle" };
  cols.forEach((col, i) => {
    const cell = hdr.getCell(3 + i);
    cell.fill      = col.type === "avg" ? AVG_FILL : SESS_FILL;
    cell.font      = col.type === "avg" ? AVG_FONT : SESS_FONT;
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  });

  const TARGET_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFdbe9f7" } };

  for (const target of allTargets) {
    const predefined = target.predefinedActivities || [];

    // Alias + configId maps so legacy activityName variants are matched
    const paKeyToAliases  = {};
    const paKeyToConfigId = {};
    for (const pa of predefined) {
      const key = pa.title || pa.name;
      if (!key) continue;
      if (pa.id) paKeyToConfigId[key] = pa.id;
      if (pa.title && pa.name && pa.title !== pa.name) {
        if (!paKeyToAliases[key]) paKeyToAliases[key] = [];
        paKeyToAliases[key].push(pa.name);
      }
    }

    const activities = predefined.filter(pa =>
      (pa.name || pa.title) &&
      !pa.isHeading && !pa.isNote && !pa.isExportNote && !pa.isMaintainHeading
    );
    if (activities.length === 0) continue;

    // Target header row spanning all columns
    const tRow = ws.addRow([target.name, `(${activities.length} activities)`, ...cols.map(() => "")]);
    tRow.height = 18;
    tRow.eachCell(cell => { cell.fill = TARGET_FILL; });
    tRow.getCell(1).font = { bold: true, color: { argb: "FF1e3a5f" } };
    tRow.getCell(2).font = { italic: true, size: 9, color: { argb: "FF555555" } };

    let actNum = 0;
    const subCounters = {};
    for (const pa of activities) {
      const paKey   = pa.title || pa.name;
      const aliases = paKeyToAliases[paKey]  || [];
      const configId = paKeyToConfigId[paKey];

      // Per-session score and per-month buckets
      const sessScore  = {};   // sess.date → rounded %
      const monthBuckets = {}; // month → [raw %]

      for (const sess of sortedSessions) {
        let actEntry = Object.entries(sess.activities || {}).find(
          ([, a]) => (a.activityName === paKey || aliases.includes(a.activityName) ||
                      (configId && a.configId === configId)) &&
                     (a.targetName === target.name || a.target === target.name)
        );
        if (!actEntry) continue;

        const [actKey, act] = actEntry;
        const actId = act.id || actKey;
        const snap  = (sess.targetsSnapshot || []).find(t => t.name === target.name);
        const mp    = (snap ? (snap.maxPoints ?? target.maxPoints) : target.maxPoints) || 3;

        const remScores = [];
        for (const rem of getRemarksForActivity(sess, actId)) {
          const s = allScores(rem);
          if (s.length === 0) continue;
          remScores.push(s.reduce((a, b) => a + b, 0) / (s.length * mp) * 100);
        }
        if (remScores.length === 0) continue;

        const sessAvg = remScores.reduce((a, b) => a + b, 0) / remScores.length;
        sessScore[sess.date] = Math.round(sessAvg);
        if (!monthBuckets[sess.month]) monthBuckets[sess.month] = [];
        monthBuckets[sess.month].push(sessAvg);
      }

      // Display name with numbering to match the website
      let displayName;
      if (pa.parentActivity) {
        const n = subCounters[pa.parentActivity] || 0;
        subCounters[pa.parentActivity] = n + 1;
        displayName = `    ${String.fromCharCode(97 + n)}) ${(pa.title || pa.name || "").trim()}`;
      } else {
        actNum++;
        const status = (pa.isCompleted || pa.masteredOn)              ? " — Mastered"
                     : (pa.isArchived || pa.isStopped || pa.discontinuedOn) ? " — Discontinued"
                     : pa.isMaintain                                   ? " — Maintained"
                     : "";
        displayName = `${actNum}) ${(pa.title || pa.name || "").trim()}${status}`;
      }

      // Build row: session scores + month averages
      const rowVals = ["", displayName];
      for (const col of cols) {
        if (col.type === "session") {
          const v = sessScore[col.sess.date];
          rowVals.push(v !== undefined ? v : "");
        } else {
          const b = monthBuckets[col.month];
          rowVals.push(b && b.length ? Math.round(b.reduce((a, c) => a + c, 0) / b.length) + "%" : "");
        }
      }

      const row = ws.addRow(rowVals);
      row.getCell(2).alignment = { wrapText: true, vertical: "top" };
      cols.forEach((col, i) => {
        const cell = row.getCell(3 + i);
        cell.alignment = { horizontal: "center", vertical: "middle" };
        if (col.type === "avg") {
          cell.font = { bold: true };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFf0f6fc" } };
        }
      });
    }
  }

  applyBorders(ws, 2 + cols.length);
}

function addIndividualTargetSheets(wb, allTargets, sessions, studentName, includeTrials) {
  // Date | Activity | Remark | Score | [Trials] | Avg Score — Trials is an
  // optional extra column, so the avg-score column's letter/index shifts
  // from E/5 to F/6 whenever it's included.
  const numCols   = includeTrials ? 6 : 5;
  const avgCol    = includeTrials ? 6 : 5;
  const avgColLet = includeTrials ? "F" : "E";

  for (const target of allTargets) {
    const { rows, monthHeaderRows, colHeaderRows, activityHeadingRows, masteredSepRows, discontinuedSepRows, extraSepRows, noteRows, sessionDateBlocks, spacerRows, grayRows, greenRows } =
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
    for (const rowIdx of masteredSepRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`B${n}:${headingEndCol}${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(2);
      cell.fill      = STYLE_MASTERED_SEP.fill;
      cell.font      = STYLE_MASTERED_SEP.font;
      cell.alignment = { vertical: "top" };
    }
    for (const rowIdx of discontinuedSepRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`B${n}:${headingEndCol}${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(2);
      cell.fill      = STYLE_DISCONTINUED_SEP.fill;
      cell.font      = STYLE_DISCONTINUED_SEP.font;
      cell.alignment = { vertical: "top" };
    }
    for (const rowIdx of extraSepRows) {
      const n = rowIdx + 1;
      try { ws.mergeCells(`B${n}:${headingEndCol}${n}`); } catch (_) {}
      const cell = ws.getRow(n).getCell(2);
      cell.fill      = STYLE_EXTRA_SEP.fill;
      cell.font      = STYLE_EXTRA_SEP.font;
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

    // Row heights: measure both Activity (col B, ~50 ExcelJS wide) and Remark (col C, ~62 ExcelJS wide).
    // ExcelJS width units are the width of "0" at default font; mixed-case text fits ~15% more chars,
    // so effective capacities are ~58 and ~72. Use 55/68 (slightly conservative) to avoid false wraps.
    ws.eachRow((row, n) => {
      if (monthHeaderRows.has(n - 1) || colHeaderRows.has(n - 1) || noteRows.has(n - 1)) return;
      const getText = c => { const v = row.getCell(c).value; return typeof v === "string" ? v : (v?.richText?.map(r => r.text).join("") || ""); };
      const countLines = (t, w) => !t ? 0 : t.split("\n").reduce((s, seg) => s + Math.max(1, Math.ceil((seg.length || 1) / w)), 0);
      const needed = Math.max(countLines(getText(2), 55), countLines(getText(3), 68), 1);
      if (needed > 1 && (!row.height || row.height < needed * 20)) row.height = Math.max(22, needed * 20);
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
  addTrendSummarySheet(wb, allTargets, sortedSessions);
  addActivityBreakdownSheet(wb, allTargets, sortedSessions);
  addActivityScoreSheet(wb, allTargets, sortedSessions);
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
  addTrendSummarySheet(wb, sortedTargets, sortedSessions);
  addActivityBreakdownSheet(wb, sortedTargets, sortedSessions);
  addActivityScoreSheet(wb, sortedTargets, sortedSessions);
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
    else if (m[3] !== undefined) {
      // Bold-only match: second-pass for nested _underline_ inside
      const inner = m[3];
      const uRe = /_(.+?)_/g; let uLast = 0, um;
      while ((um = uRe.exec(inner)) !== null) {
        if (um.index > uLast) runs.push({ text: inner.slice(uLast, um.index), bold: true });
        runs.push({ text: um[1], bold: true, underline: true });
        uLast = uRe.lastIndex;
      }
      if (uLast < inner.length) runs.push({ text: inner.slice(uLast), bold: true });
    } else {
      // Underline-only match: second-pass for nested *bold* inside
      // (handles e.g. "_*Social Skills* _" where a stray space prevents the
      // combined _*...*_ regex from matching at the outer level)
      const inner = m[4];
      const bRe = /\*(.+?)\*/g; let bLast = 0, bm;
      while ((bm = bRe.exec(inner)) !== null) {
        if (bm.index > bLast) runs.push({ text: inner.slice(bLast, bm.index), underline: true });
        runs.push({ text: bm[1], bold: true, underline: true });
        bLast = bRe.lastIndex;
      }
      if (bLast < inner.length) runs.push({ text: inner.slice(bLast), underline: true });
    }
    lastIndex = re.lastIndex;
  }
  if (lastIndex < line.length) runs.push({ text: line.slice(lastIndex) });
  if (runs.length === 0) runs.push({ text: line });
  return runs;
}

// Builds actLines for the Word activity cell: handles checkbox-style bold/underline
// on the title, and appends a details line below if activityDisplayDetails is set.
function buildActLines(act, label) {
  const titleBold = act.activityTitleBold || act.activityIsBold || false;
  const titleUnderline = act.activityTitleUnderline || act.activityIsUnderline || false;
  const titleLines = (titleBold || titleUnderline)
    ? label.split("\n").map(line => [{ text: line, bold: titleBold, underline: titleUnderline }])
    : parseInlineMarkup(label);
  const details = act.activityDisplayDetails;
  if (details) return [...titleLines, ...parseInlineMarkup(details)];
  return titleLines;
}

function wordTargetRows(target, session, allTargets) {
  const rows = [];
  const activities = getAllActivitiesForTarget(session, target);

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
    if (act.isExtraSeparator) {
      rows.push({ merge: true, text: "Extra", style: "heading" });
      continue;
    }

    if (act.isMaintainSeparator) continue;

    if (act.isMaintainHeading) {
      rows.push({ merge: true, text: act.activityName, style: "heading", isGrayHeading: true });
      continue;
    }

    if (act.isMaintain) {
      rows.push({ cells: [act.activityName, act.maintainRemark || "", ""], actLines: buildActLines(act, act.activityName), remarkLines: parseInlineMarkup(act.maintainRemark || ""), isGray: act.isGray, isGreen: act.isGreen });
      continue;
    }

    // An activity's own attached note (from "+ Add Activity & Note") is also
    // facilitator-reference text, not session data — Word treats this exactly
    // like a plain "+ Add Activity" and drops the note, same reasoning as above.
    const activityLabel = act.activityName;

    // noRemark parent: numbered title, empty remark and score
    if (act.noRemark) {
      rows.push({ cells: [activityLabel, "", ""], actLines: buildActLines(act, activityLabel), isGray: act.isGray, isGreen: act.isGreen });
      continue;
    }

    // Sub-activity: indented lettered label, own remark
    if (act.isSubActivity) {
      const subDisplayName = `    ${act.subLabel}) ${act.activityName}`;
      const _nameLines = buildActLines(act, act.activityName);
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
      rows.push({ cells: [activityLabel, act.isMaintained ? "Maintain" : "", ""], actLines: buildActLines(act, activityLabel), isGray: act.isGray, isGreen: act.isGreen });
      continue;
    }

    const remarks = getRemarksForActivity(session, act.id).filter(hasRemarkContent);
    const _starterPa = (target.predefinedActivities || []).find(p => !p.isHeading && !p.isNote && p.name === act.activityName);
    const starter = (_starterPa?.inlineOptions || _starterPa?.remarkPresetId || _starterPa?.remarkHasNote) ? (_starterPa?.sentenceStarter || null) : null;

    if (remarks.length === 0) {
      rows.push({ cells: [activityLabel, act.isMaintained ? "Maintain" : "", ""], actLines: buildActLines(act, activityLabel), isGray: act.isGray, isGreen: act.isGreen });
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
        actLines: first ? buildActLines(act, activityLabel) : null,
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

// Filename: "[Student Full Name] - Session N - D Mon YYYY.docx"
function formatExportFilenameWord(name, sessionLabel, sessionDate) {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  let datePart = "";
  if (sessionDate) {
    const [y, mo, d] = sessionDate.split("-").map(Number);
    datePart = ` - ${d} ${months[mo - 1]} ${y}`;
  }
  const sessionPart = sessionLabel ? ` - ${sessionLabel}` : "";
  return `${name}${sessionPart}${datePart}.docx`;
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
  downloadBlob(blob, formatExportFilenameWord(studentToExport.name, sessionLabel, sessionToExport.date));
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
  downloadBlob(blob, formatExportFilenameWord(studentName, sessionLabel, sessionToUse.date));
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
  const months   = fillMonthGaps([...monthSet].sort((a, b) => {
    const [ma, ya] = parseMonth(a);
    const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  }));

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
  const months = fillMonthGaps([...new Set(sessions.map(s => s.month))].sort((a, b) => {
    const [ma, ya] = parseMonth(a);
    const [mb, yb] = parseMonth(b);
    return ya !== yb ? ya - yb : ma - mb;
  }));

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

// Expand a sorted list of month strings to include every month between
// the first and last, inserting any gaps (e.g. adds "February 2026"
// when sessions jump from January to March).
function fillMonthGaps(sortedMonths) {
  if (sortedMonths.length === 0) return sortedMonths;
  const names = ["January","February","March","April","May","June",
                 "July","August","September","October","November","December"];
  const [m0, y0] = parseMonth(sortedMonths[0]);
  const [mN, yN] = parseMonth(sortedMonths[sortedMonths.length - 1]);
  const result = [];
  let m = m0, y = y0;
  while (y < yN || (y === yN && m <= mN)) {
    result.push(`${names[m - 1]} ${y}`);
    if (++m > 12) { m = 1; y++; }
  }
  return result;
}

// ─── TARGET DETAIL SHEET ─────────────────────────────────────

function buildTargetSheet(target, sessions, allTargets, includeTrials) {
  const blank = () => (includeTrials ? ["", "", "", "", "", ""] : ["", "", "", "", ""]);
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  // Fill any month gaps (e.g. Feb when sessions jump Jan→Mar) with empty arrays
  const allFilledMonths = fillMonthGaps(
    [...byMonth.keys()].sort((a, b) => {
      const [ma, ya] = parseMonth(a);
      const [mb, yb] = parseMonth(b);
      return ya !== yb ? ya - yb : ma - mb;
    })
  );
  for (const m of allFilledMonths) { if (!byMonth.has(m)) byMonth.set(m, []); }

  const rows              = [];
  const monthHeaderRows   = new Set();
  const colHeaderRows     = new Set();
  const activityHeadingRows = new Set();
  const masteredSepRows     = new Set();
  const discontinuedSepRows = new Set();
  const extraSepRows        = new Set();
  const noteRows          = new Set();
  const grayRows          = new Set();
  const greenRows         = new Set();
  const sessionDateBlocks = []; // { startRow, endRow, dateLabel, avgScore }
  const spacerRows        = new Set(); // blank rows that should have no borders
  let firstMonth = true;

  for (const month of allFilledMonths) {
    const monthSessions = byMonth.get(month);
    const dailyAvgsForMonth = monthSessions
      .map(s => {
        const snap = (s.targetsSnapshot || []).find(t => t.name === target.name);
        const eff  = snap
          ? { ...target, maxPoints: snap.maxPoints ?? target.maxPoints, predefinedActivities: (snap.predefinedActivities && snap.predefinedActivities.length > 0) ? snap.predefinedActivities : (target.predefinedActivities || []) }
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
      appendSessionRows(rows, sessionDateBlocks, activityHeadingRows, masteredSepRows, discontinuedSepRows, extraSepRows, noteRows, grayRows, greenRows, session, effectiveTarget, allTargets, includeTrials);
    }
  }

  return { rows, monthHeaderRows, colHeaderRows, activityHeadingRows, masteredSepRows, discontinuedSepRows, extraSepRows, noteRows, grayRows, greenRows, sessionDateBlocks, spacerRows };
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

function appendSessionRows(rows, sessionDateBlocks, activityHeadingRows, masteredSepRows, discontinuedSepRows, extraSepRows, noteRows, grayRows, greenRows, session, target, allTargets, includeTrials) {
  const blankRow = () => (includeTrials ? ["", "", "", "", "", ""] : ["", "", "", "", ""]);
  const [, m, d] = session.date.split("-").map(Number);
  const shortMonths = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dateLabel = `${d} ${shortMonths[m - 1]}`;

  const startRow = rows.length;

  const activities = getAllActivitiesForTarget(session, target);

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
        masteredSepRows.add(rows.length);
        const r = blankRow(); r[1] = "— Mastered —"; rows.push(r);
        continue;
      }
      if (act.isStoppedSeparator) {
        discontinuedSepRows.add(rows.length);
        const r = blankRow(); r[1] = act.activityName || "— Discontinued —"; rows.push(r);
        continue;
      }
      if (act.isExtraSeparator) {
        extraSepRows.add(rows.length);
        const r = blankRow(); r[1] = "— Extra —"; rows.push(r);
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
        const r = blankRow(); r[1] = activityCell; if (act.isMaintained) r[2] = "Maintain"; rows.push(r);
        continue;
      }

      const remarks = getRemarksForActivity(session, act.id).filter(hasRemarkContent);
      const _starterPaX = (target.predefinedActivities || []).find(p => !p.isHeading && !p.isNote && p.name === act.activityName);
      const starter = (_starterPaX?.inlineOptions || _starterPaX?.remarkPresetId || _starterPaX?.remarkHasNote) ? (_starterPaX?.sentenceStarter || null) : null;

      if (remarks.length === 0) {
        if (act.isGray) grayRows.add(rows.length);
        if (act.isGreen) greenRows.add(rows.length);
        const r = blankRow(); r[1] = activityCell; if (act.isMaintained) r[2] = "Maintain"; rows.push(r);
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
  const masteredActivities      = [];
  const discontinuedActivities  = [];
  const stoppedActivities       = [];
  let exportActNum = 0;
  const subLabelCounters = {};

  // Match a session activity to a predefined activity config.
  // Prefer configId (exact PA identity) over name so that two PAs with the same
  // name (e.g. an old discontinued free-text one and a new select-one one) never
  // both claim the same session record.  Also excludes already-claimed records.
  const claimAct = pa => {
    const byId = pa.id ? sessionActs.find(a => a.configId === pa.id && !usedIds.has(a.id)) : null;
    if (byId) return byId;
    // Name fallback only for records with NO configId (legacy/imported).
    // Records that already have a configId pointing to a different PA must not
    // be stolen by another PA that happens to share the same name.
    // Also try pa.title as a fallback: if the activity name was moved from the
    // Details field (pa.name) to the Title field (pa.title), historical session
    // records still carry the old name in activityName.
    const byName = pa.name ? sessionActs.find(a => a.activityName === pa.name && a.isPredefined && !a.configId && !usedIds.has(a.id)) : null;
    if (byName) return byName;
    return pa.title ? sessionActs.find(a => a.activityName === pa.title && a.isPredefined && !a.configId && !usedIds.has(a.id)) : null;
  };

  for (const pa of (target.predefinedActivities || [])) {
    if (!isActivityActive(pa, session.date)) continue;
    if (pa.isCompleted || pa.isArchived || pa.isStopped) continue;
    if (pa.parentActivity) {
      const parentExists = (target.predefinedActivities || []).some(
        p => !p.parentActivity && p.name === pa.parentActivity
          && isActivityActive(p, session.date)
          && !p.isCompleted && !p.isArchived && !p.isStopped && !p.masteredOn && !p.discontinuedOn
      );
      if (!parentExists) continue;
    }
    if (!pa.name && !pa.title && !pa.isNote && !pa.isExportNote && !pa.isHeading && !pa.isMaintainHeading) continue;
    if (pa.isNote) {
      result.push({ isNote: true, activityName: pa.text || "" });
      continue;
    }
    if (pa.isExportNote) {
      result.push({ isExportNote: true, activityName: pa.text || "" });
      continue;
    }
    if (!pa.name && !pa.title) continue;
    if (pa.isHeading && !pa.headingColor && !pa.isMaintainHeading) {
      result.push({ isHeading: true, activityName: pa.title || pa.name });
      continue;
    }
    // Gray headings — inline in their natural position
    if ((pa.isHeading && pa.headingColor === "gray") || pa.isMaintainHeading) {
      result.push({ isMaintainHeading: true, activityName: pa.title || pa.name, isGray: true });
      continue;
    }
    // Green headings — inline in their natural position
    if (pa.isHeading && pa.headingColor === "green") {
      result.push({ isGreenHeading: true, activityName: pa.title || pa.name });
      continue;
    }

    // Sub-activity: lettered (a, b, c…), no exportActNum increment
    if (pa.parentActivity) {
      if (pa.isCompleted || pa.isArchived || pa.isStopped) continue;
      const si = subLabelCounters[pa.parentActivity] || 0;
      subLabelCounters[pa.parentActivity] = si + 1;
      const subLabel = String.fromCharCode(97 + si);
      const parentPa = (target.predefinedActivities || []).find(p => !p.parentActivity && p.name === pa.parentActivity);
      const subStatusPrefix = pa.discontinuedOn ? '(Discontinued) '
        : pa.masteredOn ? '(Mastered) '
        : pa.maintained ? '(Maintained) '
        : parentPa?.discontinuedOn ? '(Discontinued) '
        : parentPa?.masteredOn ? '(Mastered) '
        : parentPa?.maintained ? '(Maintained) '
        : '';
      const subActName = subStatusPrefix + (pa.title || pa.name);
      const sessionAct = claimAct(pa);
      if (sessionAct) {
        usedIds.add(sessionAct.id);
        result.push({ ...sessionAct, activityName: subActName, isSubActivity: true, subLabel, activityDisplayDetails: pa.title ? (pa.name || null) : null, activityTitleBold: !!pa.isBold, activityTitleUnderline: !!pa.isUnderline });
      } else {
        result.push({ id: null, activityName: subActName, isPredefined: true, empty: true, isSubActivity: true, subLabel, activityDisplayDetails: pa.title ? (pa.name || null) : null, activityTitleBold: !!pa.isBold, activityTitleUnderline: !!pa.isUnderline });
      }
      continue;
    }

    // Mastered / discontinued → defer to bottom with x) prefix, don't consume a number
    if (pa.masteredOn) {
      const _sAct = claimAct(pa);
      const _name = `x) (Mastered) ${pa.title || pa.name}`;
      if (_sAct) { usedIds.add(_sAct.id); masteredActivities.push({ ..._sAct, activityName: _name }); }
      else { masteredActivities.push({ id: null, activityName: _name, isPredefined: true, empty: true }); }
      continue;
    }
    if (pa.discontinuedOn) {
      const _sAct = claimAct(pa);
      const _name = `x) (Discontinued) ${pa.title || pa.name}`;
      if (_sAct) { usedIds.add(_sAct.id); discontinuedActivities.push({ ..._sAct, activityName: _name }); }
      else { discontinuedActivities.push({ id: null, activityName: _name, isPredefined: true, empty: true }); }
      continue;
    }

    // All remaining paths are real activities — assign sequential number
    exportActNum++;
    const _exportStatusPrefix = pa.maintained ? '(Maintained) ' : '';
    const _paDisplayBase = pa.title || pa.name;
    const numberedName = `${exportActNum}) ${_exportStatusPrefix}${_paDisplayBase}`;
    const paExtraProps = { activityDisplayDetails: pa.title ? (pa.name || null) : null, activityTitleBold: !!pa.isBold, activityTitleUnderline: !!pa.isUnderline };

    // Parent activity (noRemark) — numbered title, empty remark
    if (pa.noRemark) {
      const sActNr = claimAct(pa);
      if (sActNr) usedIds.add(sActNr.id);
      result.push({ id: null, activityName: numberedName, isPredefined: true, noRemark: true, empty: true, ...paExtraProps });
      continue;
    }

    // Fixed remark activities — inline in their natural position (NOT reordered to the bottom)
    if (pa.fixedRemark !== undefined) {
      const isGray = pa.activityColor === "gray" || !!pa.isMaintainLive;
      result.push({ isMaintain: true, activityName: numberedName, maintainRemark: pa.fixedRemark || "", ...(isGray ? { isGray: true } : {}), ...paExtraProps });
      continue;
    }
    if (pa.isMaintain) {
      const isGray = pa.activityColor === "gray" || !!pa.isMaintainLive;
      result.push({ isMaintain: true, activityName: numberedName, maintainRemark: pa.maintainRemark || "", ...(isGray ? { isGray: true } : {}), ...paExtraProps });
      continue;
    }
    if (pa.isCompleted) {
      const sessionAct = claimAct(pa);
      if (sessionAct) {
        usedIds.add(sessionAct.id);
        masteredActivities.push({ ...sessionAct, activityName: numberedName, isMastered: true, ...paExtraProps });
      } else {
        masteredActivities.push({ id: null, activityName: numberedName, isPredefined: true, empty: true, isMastered: true, ...paExtraProps });
      }
      continue;
    }
    if (pa.isArchived || pa.isStopped) {
      const sessionAct = claimAct(pa);
      if (sessionAct) {
        usedIds.add(sessionAct.id);
        stoppedActivities.push({ ...sessionAct, activityName: numberedName, isStopped: true, ...paExtraProps });
      } else {
        stoppedActivities.push({ id: null, activityName: numberedName, isPredefined: true, empty: true, isStopped: true, ...paExtraProps });
      }
      continue;
    }
    const sessionAct = claimAct(pa);
    const colorProps = (pa.activityColor === "gray" || pa.isMaintainLive) ? { isGray: true }
                     : pa.activityColor === "green" ? { isGreen: true } : {};
    const manualScoreProp = pa.manualScore ? { manualScore: true } : {};
    if (sessionAct) {
      usedIds.add(sessionAct.id);
      result.push(pa.isMapped
        ? { ...sessionAct, activityName: numberedName, isMapped: true, mappedTargetId: pa.mappedTargetId || null, ...colorProps, isMaintained: !!pa.maintained, ...paExtraProps }
        : { ...sessionAct, activityName: numberedName, ...colorProps, ...manualScoreProp, isMaintained: !!pa.maintained, ...paExtraProps });
    } else {
      result.push({
        id: null, activityName: numberedName, isPredefined: true, empty: true,
        isMapped: pa.isMapped || false, mappedTargetId: pa.mappedTargetId || null, ...colorProps, ...manualScoreProp, isMaintained: !!pa.maintained, ...paExtraProps
      });
    }
  }

  // Collect non-predefined (session-only) activities, numbered from 1)
  const extraActivities = [];
  let extraNum = 0;
  for (const act of sessionActs) {
    if (usedIds.has(act.id)) continue;
    if (act.isPredefined || act.parentActivity) continue;
    if (!act.activityName?.trim()) continue;
    extraNum++;
    // If activityTitle is set, use it as the label; the old activityName becomes Details
    const extraLabel = act.activityTitle || act.activityName;
    const extraDetails = act.activityTitle ? act.activityName : null;
    extraActivities.push({ ...act, activityName: `${extraNum}) ${extraLabel}`, activityDisplayDetails: extraDetails });
  }

  if (masteredActivities.length > 0) {
    result.push({ isMasteredSeparator: true, activityName: "— Mastered —" });
    result.push(...masteredActivities);
  }
  if (discontinuedActivities.length > 0) {
    result.push({ isStoppedSeparator: true, activityName: "— Discontinued —" });
    result.push(...discontinuedActivities);
  }
  if (stoppedActivities.length > 0) {
    result.push({ isStoppedSeparator: true, activityName: "— Stopped tracking —" });
    result.push(...stoppedActivities);
  }
  if (extraActivities.length > 0) {
    result.push({ isExtraSeparator: true, activityName: "— Extra —" });
    result.push(...extraActivities);
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
    if (act.isHeading || act.isNote || act.isExportNote || act.empty || act.isMasteredSeparator || act.isStoppedSeparator || act.isMaintainSeparator || act.isMaintain || act.isMaintainHeading) continue;
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
  const ppStr = lrDelta >= 0 ? `+${lrDelta} pts` : `${lrDelta} pts`;
  if (Math.abs(lrDelta) <= 8) {
    dirText  = `→  Stable (${ppStr})`;
    dirColor = "#888888";
  } else if (lrDelta > 0) {
    dirText  = `↑  Trending Up (${ppStr})`;
    dirColor = "#2A7A3B";
  } else {
    dirText  = `↓  Trending Down (${ppStr})`;
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
      },
      {
        id: "trendEndpoints",
        afterDatasetsDraw(c) {
          const meta1 = c.getDatasetMeta(1);
          if (!meta1 || meta1.data.length < 2) return;
          const { ctx: cx } = c;
          const trendBlue = "rgba(59,108,181,0.9)";
          const pts = [
            { pt: meta1.data[0],                     val: Math.round(trend[0]),                align: "left"  },
            { pt: meta1.data[meta1.data.length - 1], val: Math.round(trend[trend.length - 1]), align: "right" }
          ];
          for (const { pt, val, align } of pts) {
            cx.save();
            cx.fillStyle    = trendBlue;
            cx.font         = "bold 11px sans-serif";
            cx.textAlign    = align;
            cx.textBaseline = "bottom";
            cx.fillText(val + "%", pt.x + (align === "left" ? 4 : -4), pt.y - 4);
            cx.restore();
          }
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

function renderThresholdLegend() {
  // Table dimensions
  const COL1 = 240; // Direction column width
  const COL2 = 200; // Threshold column width
  const W    = COL1 + COL2;
  const TITLE_H = 34;
  const ROW_H   = 32;
  const ROWS    = 3;
  const H       = TITLE_H + ROW_H * ROWS;

  const SCALE = 2; // 2× for Word crispness
  const canvas = document.createElement("canvas");
  canvas.width  = W * SCALE;
  canvas.height = H * SCALE;
  const cx = canvas.getContext("2d");
  cx.scale(SCALE, SCALE);

  const BORDER  = "#9ca3af";
  const GRID    = "#d1d5db";
  const rows = [
    { arrow: "↑", label: "Trending Up",  cond: "> +8pp",        color: "#16a34a", bg: "#dcfce7" },
    { arrow: "→", label: "Stable",        cond: "−8pp to +8pp",  color: "#4b5563", bg: "#f9fafb" },
    { arrow: "↓", label: "Trending Down", cond: "< −8pp",        color: "#dc2626", bg: "#fff5f5" },
  ];

  // ── Title row ──────────────────────────────────────────────────
  cx.fillStyle = "#1e293b";
  cx.fillRect(0, 0, W, TITLE_H);
  cx.fillStyle = "#ffffff";
  cx.font = "bold 13px sans-serif";
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  cx.fillText("Trendline Direction Legend", W / 2, TITLE_H / 2);

  // ── Data rows ──────────────────────────────────────────────────
  rows.forEach(({ arrow, label, cond, color, bg }, i) => {
    const rowY = TITLE_H + i * ROW_H;
    const midY = rowY + ROW_H / 2;

    // Row background
    cx.fillStyle = bg;
    cx.fillRect(0, rowY, W, ROW_H);

    // Arrow (bold, slightly larger)
    cx.font = "bold 15px sans-serif";
    cx.fillStyle = color;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText(arrow, 20, midY);

    // Direction label (bold)
    cx.font = "bold 13px sans-serif";
    cx.textAlign = "left";
    cx.fillText(label, 38, midY);

    // Threshold (normal, dark, centred in col 2)
    cx.font = "13px sans-serif";
    cx.fillStyle = "#374151";
    cx.textAlign = "center";
    cx.fillText(cond, COL1 + COL2 / 2, midY);

    // Horizontal row divider
    cx.strokeStyle = GRID;
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(0, rowY); cx.lineTo(W, rowY);
    cx.stroke();
  });

  // ── Vertical column divider ────────────────────────────────────
  cx.strokeStyle = GRID;
  cx.lineWidth = 1;
  cx.beginPath();
  cx.moveTo(COL1, TITLE_H); cx.lineTo(COL1, H);
  cx.stroke();

  // ── Outer border ──────────────────────────────────────────────
  cx.strokeStyle = BORDER;
  cx.lineWidth = 1.5;
  cx.strokeRect(0.75, 0.75, W - 1.5, H - 1.5);

  return canvas.toDataURL("image/png").split(",")[1];
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
