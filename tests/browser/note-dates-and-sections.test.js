// A note's dates, and the collapsed lists at the bottom of Edit Target.
//
// Five things Lewis reported in one go:
//
//   1. The Mastered and Discontinued lists came back expanded every time
//      Edit Target was reopened. They are meant to start closed.
//   2. A note's kebab still carried an "Active Period" box, a second place
//      to set the start date the row already had.
//   3. The Set Start Date sheet called a note "this activity ()" -- a note
//      keeps its words in text/noteTitle, not in title or name.
//   4. A note on the Start Session screen never said when it was created,
//      unlike every activity above it.
//   5. A note that was not active yet was faded to 30%. Nothing else in
//      the list fades, so it read as a fault rather than as information.
//
//   deno run -A tests/browser/note-dates-and-sections.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: note-dates-and-sections.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 650) => new Promise(res => setTimeout(res, ms));

const ACTS = [
  { id: "a1", title: "kek lahh", name: "", order: 0, activeFrom: "2026-10-01", createdOn: "2026-10-01" },
  { id: "n1", isNote: true, text: "sadf asd fd\nsome details", order: 1,
    activeFrom: "2026-10-07", createdOn: "2026-10-07" },
  // Not started yet on the session date below, so this is the one that used
  // to be faded.
  { id: "n2", isNote: true, text: "later note", order: 2,
    activeFrom: "2026-12-01", createdOn: "2026-12-01" },
  { id: "m1", title: "Rolling a ball", name: "", order: 3, createdOn: "2026-01-01",
    masteredOn: "2026-06-01" },
  { id: "d1", title: "Stacking", name: "", order: 4, createdOn: "2026-01-01",
    discontinuedOn: "2026-07-01" },
];

const openTarget = () => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "s1");
  window.__app.openManageModal(s, s.targets[0]);
})()`);
const closeTarget = () => page.eval(`window.__app.closeManageModal()`);

// Each collapsed group, and whether its panel is showing.
const groups = () => page.eval(`(() => {
  return [...document.querySelectorAll("#manage-modal-body .mn-inact-group")].map(g => ({
    label: (g.querySelector(".mn-inact-toggle")?.textContent || "").replace(/\\s+/g, " ").trim(),
    open: g.querySelector(".mn-inact-panel")?.style.display === "block",
  }));
})()`);

try {
  await page.fixture({
    today: "2026-11-01", authUser: "daisy",
    students: [{ id: "s1", name: "TEST yas", order: 1,
      targets: [{ id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: ACTS }] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // ── 1. the collapsed lists ──────────────────────────────────────────
  r.section("1. the Mastered and Discontinued lists start closed");
  await openTarget();
  await settle();
  const first = await groups();
  r.check("both lists are there", first.length, 2);
  r.ok("and both start closed", first.every(g => !g.open), JSON.stringify(first));

  // Open one, then close and reopen the window. It must be closed again.
  await page.eval(`document.querySelectorAll("#manage-modal-body .mn-inact-toggle")[0].click()`);
  await settle(350);
  const opened = await groups();
  r.ok("one opens when clicked", opened.some(g => g.open), JSON.stringify(opened));

  await closeTarget();
  await settle(350);
  await openTarget();
  await settle();
  const reopened = await groups();
  r.ok("but reopening the window closes it again",
    reopened.length === 2 && reopened.every(g => !g.open), JSON.stringify(reopened));

  // ── 2 & 3. the note's two dates ─────────────────────────────────────
  r.section("2. a note has a Start Date and an End Date on its row");
  const noteRow = await page.eval(`(() => {
    const row = [...document.querySelectorAll("#manage-modal-body .admin-note-item")]
      .find(x => x.textContent.includes("sadf asd fd"));
    if (!row) return null;
    return {
      start: row.querySelector(".mn-act-start-btn")?.textContent.trim() || "",
      end: row.querySelector(".mn-act-end-btn")?.textContent.trim() || "",
      kebabHasPeriod: !!row.querySelector(".mn-period-section"),
      kebabItems: [...row.querySelectorAll(".mn-kebab-menu button")]
        .map(b => b.textContent.replace(/\\s+/g, " ").trim()),
      faded: /opacity:\\s*0\\.3/.test(row.getAttribute("style") || ""),
    };
  })()`);
  r.ok("the note row is there", !!noteRow, "no note row found");
  r.check("its Start Date is shown", noteRow && noteRow.start, "📅 7 Oct 2026");
  r.check("and an End Date box sits under it", noteRow && noteRow.end, "📅 No end date");

  r.section("3. and nothing in its kebab but Delete");
  r.ok("the Active Period box is gone",
    !!noteRow && !noteRow.kebabHasPeriod, JSON.stringify(noteRow && noteRow.kebabItems));
  r.check("only Delete Note is left", noteRow && noteRow.kebabItems, ["🗑️ Delete Note"]);

  // ── 4. a note that has not started is not faded ─────────────────────
  r.section("4. a note that has not started yet is not faded");
  const later = await page.eval(`(() => {
    const row = [...document.querySelectorAll("#manage-modal-body .admin-note-item")]
      .find(x => x.textContent.includes("later note"));
    return row ? { faded: /opacity:\\s*0\\.3/.test(row.getAttribute("style") || "") } : null;
  })()`);
  r.ok("the December note is on screen", !!later, "not found");
  r.ok("and is not faded", !!later && !later.faded, JSON.stringify(later));
  r.ok("nor is the one that has started", !!noteRow && !noteRow.faded, JSON.stringify(noteRow));

  // ── 5. the sheet calls a note a note ────────────────────────────────
  r.section("5. the Set Start Date sheet, opened on a note");
  await page.eval(`(() => {
    const row = [...document.querySelectorAll("#manage-modal-body .admin-note-item")]
      .find(x => x.textContent.includes("sadf asd fd"));
    row.querySelector(".mn-act-start-btn").click();
  })()`);
  await settle(350);
  const startSheet = await page.eval(`(() => {
    const ov = document.getElementById("act-start-picker-overlay");
    return (ov?.innerText || "").replace(/\\s+/g, " ").trim();
  })()`);
  r.ok("it says Set Start Date", /Set Start Date/.test(startSheet), startSheet.slice(0, 180));
  r.ok("it calls it a note, not an activity",
    /this note/.test(startSheet) && !/this activity/.test(startSheet), startSheet.slice(0, 180));
  r.ok("and names it instead of showing empty brackets",
    startSheet.includes("sadf asd fd") && !startSheet.includes("()"), startSheet.slice(0, 180));
  await page.eval(`window.__app.closeActStartDatePicker?.() ||
    (document.getElementById("act-start-picker-overlay").innerHTML = "")`);
  await settle(250);

  r.section("6. and the End Date sheet says the opposite");
  await page.eval(`(() => {
    const row = [...document.querySelectorAll("#manage-modal-body .admin-note-item")]
      .find(x => x.textContent.includes("sadf asd fd"));
    row.querySelector(".mn-act-end-btn").click();
  })()`);
  await settle(350);
  const endSheet = await page.eval(`(() => {
    const ov = document.getElementById("act-start-picker-overlay");
    return (ov?.innerText || "").replace(/\\s+/g, " ").trim();
  })()`);
  r.ok("it says Set End Date", /Set End Date/.test(endSheet), endSheet.slice(0, 180));
  r.ok("and asks when it should STOP appearing",
    /stop appearing/.test(endSheet), endSheet.slice(0, 180));

  // ── 7. the note says when it started, on the session screen ─────────
  r.section("7. a note on the Start Session screen is dated");
  const sessionHtml = await page.eval(`(() => {
    const s = window.__app.state;
    s.currentStudent = s.students.find(x => x.id === "s1");
    s.selectedTargetName = "FEDC 1";
    s.currentSessionId = "sess1";
    s.sessionData = { date: "2026-11-01", studentId: "s1", activities: {}, remarks: {} };
    document.getElementById("screen-session")?.classList.remove("hidden");
    const html = window.__app.renderFedcTarget(s.currentStudent.targets[0]);
    return Array.isArray(html) ? html.join("") : String(html ?? "");
  })()`);
  const noteBlock = sessionHtml
    .split('border-left:4px solid #f59e0b')[1] || "";
  const noteText = noteBlock.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  r.ok("the note is on the screen", noteText.includes("sadf asd fd"), noteText.slice(0, 200));
  r.ok("and carries its created date, like the activities above it",
    /Created: 7 Oct 2026/.test(noteText), noteText.slice(0, 200));

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

r.done("A note's dates, and the collapsed lists");
