// Setting an activity's Start Date from inside its edit panel.
//
// Two bugs, one cause. The Edit Target screen deliberately writes nothing
// while an activity panel is open -- Discard Changes can only put things
// back if they never left -- so saveTarget begins:
//
//   if (_mnPanelHold) { _mnPanelSaveWanted = true; return; }
//
// The date picker did not know that. It set the value, called a save the
// hold swallowed, and then forced a full redraw, which tore the panel down
// and took the date with it. Nothing reached Firestore and the row still
// showed the old day.
//
// The picker was also acting on the date input's own 'change' event, which
// a calendar fires the moment you touch a day: no chance to look at what
// you had picked, and no way back but re-opening the sheet.
//
// Notes, parent activities, sub-activities and template rows all draw this
// button from the same two classes, so all of them had it.
//
//   deno run -A tests/browser/activity-start-date.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: activity-start-date.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const src = await Deno.readTextFile("app.js");

try {
  await page.fixture({
    today: "2026-11-05", authUser: "daisy",
    students: [], groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // ── 1. the sheet asks before it acts ────────────────────────────────
  r.section("1. a date is chosen, then confirmed");
  r.check("there is a Confirm button",
    /id="act-start-picker-confirm"[^>]*>Confirm</.test(src), true);
  r.check("Cancel is still there",
    /id="act-start-picker-cancel"[^>]*>Cancel</.test(src), true);
  // Left and right, in that order in the markup.
  const cancelAt  = src.indexOf('id="act-start-picker-cancel"');
  const confirmAt = src.indexOf('id="act-start-picker-confirm"');
  r.ok("Cancel on the left, Confirm on the right",
    cancelAt > 0 && confirmAt > cancelAt, `${cancelAt} / ${confirmAt}`);

  r.check("Confirm is what applies the date",
    /getElementById\('act-start-picker-confirm'\)\s*\r?\n?\s*\.addEventListener\('click', handleActStartPickerChange\)/
      .test(src), true);
  // The calendar fires 'change' on the first day you touch. It may only
  // clear the error now -- never apply, never close.
  const onChange = src.match(
    /addEventListener\('change', \(\) => \{([\s\S]*?)\n  \}\);/);
  r.ok("picking a date no longer applies it", !!onChange, "handler not found");
  r.check("and only clears the error message",
    !!onChange && !/handleActStartPickerChange|closeActStartDatePicker|SaveFn/.test(onChange[1]),
    true);

  // Only an end date can be taken off. Clearing a START date meant "show
  // this in every session, however old", which nobody wanted -- and which
  // did not hold anyway: a backfill set any empty one to 2026-01-01 the
  // next time a session was started, so the button quietly reset the date
  // rather than removing it.
  r.section("1b. a start date cannot be cleared, an end date can");
  r.check("the button is offered for an end date only",
    /const hasExistingDate = isEnd && !!act\?\.activeTo;/.test(src), true);
  r.check("and it is called No End Date, never Clear Date",
    /Clear Date/.test(src), false);
  r.check("the backfill that made clearing pointless is still there",
    /a\.activeFrom == null\) \{\s*\r?\n\s*a\.activeFrom = "2026-01-01";/.test(src), true);

  // ── 2. a held write does not redraw ─────────────────────────────────
  r.section("2. while a panel is open the date joins the draft");
  // Both screens -- a student's target, and a template -- must check.
  const holds = src.match(/if \(_mnPanelHold\) \{ mnPaintDateBtn\(idx, field, value \|\| null\); return; \}/g) || [];
  r.check("both save paths check the hold before redrawing", holds.length, 2);
  // The check has to come BEFORE the save and the redraw, or the panel is
  // torn down anyway.
  for (const [what, fn] of [
    ["the target screen", /const savePeriodField = async \(idx, field, value\) => \{[\s\S]*?\n  \};/],
    ["the template screen", /_actStartPickerSaveFn = async \(idx, field, value\) => \{[\s\S]*?\n      \};/],
  ]) {
    const body = (src.match(fn) || [""])[0];
    const hold = body.indexOf("_mnPanelHold");
    const draw = body.search(/render(Target|Template)ManageContent/);
    r.ok(`${what}: the hold is checked first`,
      hold > 0 && draw > hold, `hold ${hold}, redraw ${draw}`);
  }

  // ── 3. the button shows the new date without a redraw ───────────────
  r.section("3. the button repaints in place");
  const painted = await page.eval(`(() => {
    const host = document.createElement("div");
    host.innerHTML =
      '<button class="mn-act-start-btn" data-idx="2">old</button>' +
      '<button class="mn-act-start-btn" data-idx="9">untouched</button>' +
      '<button class="mn-act-end-btn" data-idx="2">old end</button>';
    document.body.appendChild(host);
    const read = () => [...host.querySelectorAll("button")].map(b => b.textContent);
    window.__app.mnPaintDateBtn(2, "activeFrom", "2026-09-03");
    const afterStart = read();
    window.__app.mnPaintDateBtn(2, "activeTo", "2026-12-01");
    const afterEnd = read();
    window.__app.mnPaintDateBtn(2, "activeFrom", null);
    const afterClear = read();
    host.remove();
    return { afterStart, afterEnd, afterClear };
  })()`);

  r.check("the start button shows the chosen day",
    painted.afterStart[0], "\u{1F4C5} 3 Sep 2026");
  r.check("another row is left alone", painted.afterStart[1], "untouched");
  r.check("the end button is a different button",
    painted.afterStart[2], "old end");
  r.check("and takes its own date", painted.afterEnd[2], "\u{1F4C5} 1 Dec 2026");
  r.check("cleared, a start date reads Set date",
    painted.afterClear[0], "\u{1F4C5} Set date");

  const cleared = await page.eval(`(() => {
    const b = document.createElement("button");
    b.className = "mn-act-end-btn"; b.dataset.idx = "4";
    document.body.appendChild(b);
    window.__app.mnPaintDateBtn(4, "activeTo", null);
    const t = b.textContent; b.remove(); return t;
  })()`);
  r.check("and a cleared end date reads No end date", cleared, "\u{1F4C5} No end date");

  // ── 4. every block type is covered ──────────────────────────────────
  //
  // Lewis asked whether notes had this too. They did: every live date
  // button on the screen is one of these two classes, so one fix reaches
  // all of them.
  r.section("4. notes and templates use the same two classes");
  const startBtns = (src.match(/class="mn-act-start-btn"/g) || []).length;
  const endBtns   = (src.match(/class="mn-act-end-btn"/g) || []).length;
  r.ok("several start buttons across the screens", startBtns >= 5, String(startBtns));
  r.ok("and the end buttons too", endBtns >= 2, String(endBtns));
  r.check("the picker is wired to both classes, nothing narrower",
    (src.match(/querySelectorAll\("\.mn-act-start-btn, \.mn-act-end-btn"\)/g) || []).length, 2);
  r.check("and repainting looks for the same two",
    /const cls   = isEnd \? "mn-act-end-btn" : "mn-act-start-btn";/.test(src), true);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join(" | "));
} finally {
  await page.close?.();
}

r.done("Setting an activity's Start Date");
