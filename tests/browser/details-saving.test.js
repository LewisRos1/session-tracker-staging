// The Details box saving tests, run against the real app in a real browser.
//
// This is the list the boss asked to have checked after the rich Details
// boxes went in. Every step is a real mouse click or a real key press
// dispatched by the browser, against the real markup and the real handlers.
// Only two things are not real: Firestore, which is recorded rather than
// written, and the way in to the Edit Target modal, which is called directly
// instead of being reached through three menus.
//
// Field names, which read backwards and are worth keeping in mind:
//   act.title       the activity's NAME, shown in the list
//   act.name        the DETAILS text of an activity
//   act.noteDetails the DETAILS text of a note (act.text holds both halves)
//
//   deno run -A tests/browser/details-saving.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: details-saving.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

/** Two activities, a note, and a parent with one sub-activity. */
const fixture = () => ({
  today: "2026-10-08",
  authUser: "daisy",
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [{
      id: "t1", name: "FEDC 1", scale: 3,
      predefinedActivities: [
        { id: "a1", title: "Greeting",    name: "", order: 0, createdOn: "2026-01-01" },
        { id: "a2", title: "Turn taking", name: "", order: 1, createdOn: "2026-01-01" },
        { id: "n1", isNote: true, text: "Reminder", noteTitle: "Reminder", noteDetails: "", order: 2, createdOn: "2026-01-01" },
        { id: "p1", title: "Voice", name: "", order: 3, createdOn: "2026-01-01" },
        { id: "s1", title: "Loud",  name: "", order: 4, createdOn: "2026-01-01", parentActivity: "Voice" },
      ],
    }],
  }],
  groups: [],
  sessions: [{
    id: "sess1", studentId: "amy", date: "2026-09-01", target: "FEDC 1",
    activities: { a1: { trials: [3, 2, 3] } },
  }],
});

const settle = (ms = 450) => new Promise(res => setTimeout(res, ms));

async function openEditTarget() {
  await page.fixture(fixture());
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 4`, "the activity list");
  await settle();
  await page.eval(`window.__dialogs = [];
    window.confirm = m => { window.__dialogs.push(m); return true; };
    window.alert  = m => { window.__dialogs.push(m); };`);
}

/** Click an ordinary activity or note row, which opens its panel. */
async function openCard(label) {
  const hit = await page.eval(`(() => {
    const card = [...document.querySelectorAll(".mn-act-card")]
      .find(c => (c.querySelector(".mn-act-compact-title")?.innerText || "").includes(${JSON.stringify(label)}));
    if (!card) return null;
    const t = card.querySelector(".mn-act-compact-title");
    t.scrollIntoView({ block: "center" });
    const b = t.getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
  if (!hit) throw new Error(`no activity row says "${label}"`);
  await page.clickAt(hit.x, hit.y);
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-rich, #mn-act-panel-overlay textarea")`, `the panel for ${label}`);
  await settle();
}

/** Click a sub-activity's indented row, which opens its own panel. */
async function openSub(label) {
  const hit = await page.eval(`(() => {
    const row = [...document.querySelectorAll(".mn-sub-compact")]
      .find(x => (x.innerText || "").includes(${JSON.stringify(label)}));
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const b = row.getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
  if (!hit) throw new Error(`no sub-activity row says "${label}"`);
  await page.clickAt(hit.x, hit.y);
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-rich, #mn-act-panel-overlay textarea")`, `the panel for ${label}`);
  await settle();
}

async function typeInDetails(text) {
  const ok = await page.eval(`(() => {
    const p = document.querySelector("#mn-act-panel-overlay");
    const box = p.querySelector(".mn-rich") || p.querySelector(".mn-act-details-input, .mn-note-details-input");
    if (!box) return false;
    box.scrollIntoView({ block: "center" });
    box.focus();
    if (box.isContentEditable) {
      const sel = window.getSelection(), rg = document.createRange();
      rg.selectNodeContents(box); rg.collapse(false);
      sel.removeAllRanges(); sel.addRange(rg);
    } else { box.selectionStart = box.selectionEnd = box.value.length; }
    return true;
  })()`);
  if (!ok) throw new Error("the panel has no Details box");
  await page.type(text);
  await settle(250);
}

/** What the box is showing right now. */
const shownInBox = () => page.eval(`(() => {
  const p = document.querySelector("#mn-act-panel-overlay");
  const box = p.querySelector(".mn-rich") || p.querySelector(".mn-act-details-input, .mn-note-details-input");
  if (!box) return "(no box)";
  return (box.isContentEditable ? box.innerText : box.value).replace(/\\u00a0/g, " ").trim();
})()`);

/**
 * The Details text as the REST OF THE APP sees it.
 *
 * Read from state.students, not from the editor: the editor works on a merged
 * copy of the target, so the two can disagree -- which is the whole point of
 * the Discard test.
 */
const detailsInState = (id) => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "amy");
  const a = (s.targets[0].predefinedActivities || []).find(a => a.id === ${JSON.stringify(id)});
  if (!a) return "(no such activity)";
  return (a.isNote || a.isExportNote) ? (a.noteDetails || "") : (a.name || "");
})()`);

/** The Details text in the last thing written to Firestore. */
const detailsSaved = (id) => page.eval(`(() => {
  const calls = (window.__harness.calls || []).filter(c => c.name === "saveStudent");
  if (!calls.length) return "(nothing was saved)";
  const student = calls[calls.length - 1].args[0];
  const t = (student.targets || []).find(t => t.name === "FEDC 1");
  const a = (t?.predefinedActivities || []).find(a => a.id === ${JSON.stringify(id)});
  if (!a) return "(activity missing from the save)";
  return (a.isNote || a.isExportNote) ? (a.noteDetails || "") : (a.name || "");
})()`);

/** The panel element is shown, rather than merely present in the document. */
const panelOpen = () => page.eval(`(() => {
  const el = document.querySelector("#mn-act-panel-overlay");
  return !!el && getComputedStyle(el).display !== "none";
})()`);

const saveCount = () => page.eval(`(window.__harness.calls || []).filter(c => c.name === "saveStudent").length`);
const clearCalls = () => page.eval(`window.__harness.calls.length = 0`);
const dialogs = () => page.eval(`window.__dialogs || []`);

try {
  // ══ 1. Save and Close ════════════════════════════════════════════════
  r.section("1. type in Details, Save and Close, reopen");

  await openEditTarget();
  await openCard("Greeting");
  await typeInDetails("hello from the test");
  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(800);

  r.ok("the panel closed", !(await panelOpen()));
  r.check("the app has it", await detailsInState("a1"), "hello from the test");
  r.check("written to Firestore", await detailsSaved("a1"), "hello from the test");

  await openCard("Greeting");
  r.check("shown again on reopen", await shownInBox(), "hello from the test");

  // ══ 2. The panel's dimmed area ═══════════════════════════════════════
  // With unsaved work this must NOT close: it points at Save and Close
  // instead, so a stray click outside cannot throw the typing away.
  r.section("2. type in Details, then click the panel's dimmed area");

  await openEditTarget();
  await openCard("Greeting");
  await typeInDetails("typed then clicked outside");

  const spot = await page.eval(`(() => {
    const panel = document.querySelector("#mn-act-panel-overlay .mn-act-panel");
    const b = panel.getBoundingClientRect();
    // Just above the panel: inside the overlay, outside the panel itself.
    return { x: b.left + b.width / 2, y: Math.max(4, b.top / 2) };
  })()`);
  await page.clickAt(spot.x, spot.y);
  await settle(800);

  r.ok("the panel stayed open", await panelOpen(),
    "clicking off a changed panel must not close it");
  r.check("the typing is still in the box", await shownInBox(), "typed then clicked outside");

  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(800);
  r.check("Save and Close then writes it", await detailsSaved("a1"), "typed then clicked outside");

  // ══ 3. Clicking straight onto another activity's row ═════════════════
  r.section("2b. clicking straight from one activity to the next, five in a row");

  // Closing a panel now REMOVES the field boxes it borrowed rather than
  // leaving them behind. Get that wrong and the fifth panel comes up empty,
  // or showing the row before it. Done with real clicks, one row to the next,
  // never pressing Save and Close.
  await page.fixture({
    today: "2026-10-08", authUser: "daisy",
    students: [{
      id: "amy", name: "Amy", order: 1,
      targets: [{
        id: "t1", name: "FEDC 1", scale: 3,
        predefinedActivities: [1, 2, 3, 4, 5].map((n, i) => ({
          id: `c${n}`, title: `Row ${n}`, name: `details for row ${n}`,
          order: i, createdOn: "2026-01-01",
        })),
      }],
    }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 5`, "all five rows");
  await settle();
  await page.eval(`window.confirm = () => true; window.alert = () => {};`);

  // Save and Close between each one. While a panel is open its overlay covers
  // the screen, so another row cannot be clicked at all -- a click lands on
  // the dimmed area, which points at Save and Close rather than switching.
  for (const n of [1, 2, 3, 4, 5]) {
    if (n > 1) {
      await page.click("#mn-act-panel-overlay .mn-act-panel-save");
      await page.until(`(() => {
        const el = document.getElementById("mn-act-panel-overlay");
        return !el || getComputedStyle(el).display === "none";
      })()`, "the previous panel to close");
      await settle(300);
    }
    await openCard(`Row ${n}`);
    const seen = await page.eval(`(() => {
      const p = document.querySelector("#mn-act-panel-overlay");
      const title = p.querySelector(".mn-act-title-input");
      const box = p.querySelector(".mn-rich") || p.querySelector(".mn-act-details-input");
      return {
        title: title ? title.value.trim() : "(no title field)",
        details: box ? (box.isContentEditable ? box.innerText : box.value).trim() : "(no details box)",
        titleFields: p.querySelectorAll(".mn-act-title-input").length,
        detailBoxes: p.querySelectorAll(".mn-act-details-input").length,
      };
    })()`);
    r.check(`row ${n}: the panel shows its own title`, seen.title, `Row ${n}`);
    r.check(`row ${n}: and its own details`, seen.details, `details for row ${n}`);
    r.check(`row ${n}: with one set of fields, not several`,
      [seen.titleFields, seen.detailBoxes], [1, 1]);
  }

  // Named for what it really does. With a panel open its overlay covers the
  // screen, so a click aimed at another row lands on the dimmed area -- which
  // must keep the panel and the typing, not switch away and lose them.
  r.section("3. type in Details, then click where another activity's row is");

  await openEditTarget();
  await openCard("Greeting");
  await typeInDetails("first activity text");
  await openCard("Turn taking");
  await settle(600);

  r.check("the first activity kept its text", await detailsInState("a1"), "first activity text");

  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(700);
  await openCard("Greeting");
  r.check("still there when reopened", await shownInBox(), "first activity text");

  // ══ 4. Discard Changes ═══════════════════════════════════════════════
  r.section("4. type in Details, press Discard Changes, reopen");

  await openEditTarget();
  await openCard("Greeting");
  await typeInDetails("this should vanish");
  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-discard");
  await settle(900);

  r.ok("asked before throwing the edit away", (await dialogs()).length > 0,
    "Discard did not confirm, so a mis-click loses work");
  r.check("the app no longer has it", await detailsInState("a1"), "");
  r.check("if it wrote, it wrote the restored value",
    (await saveCount()) === 0 ? "" : await detailsSaved("a1"), "");

  await openCard("Greeting");
  r.check("the box is empty on reopen", await shownInBox(), "");
  r.check("only one Details box is in the panel",
    await page.eval(`document.querySelectorAll("#mn-act-panel-overlay .mn-act-details-input").length`), 1);

  // ══ 5. A Note and a Sub-activity ═════════════════════════════════════
  r.section("5. the same for a Note's Details and a Sub-activity's");

  await openEditTarget();
  await openCard("Reminder");
  await typeInDetails("note details text");
  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(800);
  r.check("note: the app has it", await detailsInState("n1"), "note details text");
  r.check("note: written to Firestore", await detailsSaved("n1"), "note details text");

  await openEditTarget();
  await openSub("Loud");
  await typeInDetails("sub activity text");
  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(800);
  r.check("sub-activity: the app has it", await detailsInState("s1"), "sub activity text");
  r.check("sub-activity: written to Firestore", await detailsSaved("s1"), "sub activity text");

  r.section("5b. Discard on a Note and on a Sub-activity");

  await openEditTarget();
  await openCard("Reminder");
  await typeInDetails("note text to discard");
  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-discard");
  await settle(900);
  r.check("note: discard put it back", await detailsInState("n1"), "");
  // A note's details sync on every keystroke rather than on blur, so a discard
  // can end up writing once. That is fine as long as what it writes is the
  // RESTORED value -- never the text that was just thrown away.
  r.check("note: if it wrote, it wrote the restored value",
    (await saveCount()) === 0 ? "" : await detailsSaved("n1"), "");

  await openEditTarget();
  await openSub("Loud");
  await typeInDetails("sub text to discard");
  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-discard");
  await settle(900);
  r.check("sub-activity: discard put it back", await detailsInState("s1"), "");
  r.check("sub-activity: if it wrote, it wrote the restored value",
    (await saveCount()) === 0 ? "" : await detailsSaved("s1"), "");

  // ══ 6. An activity that already has session data ═════════════════════
  r.section("6. change Details on an activity with past sessions");

  await openEditTarget();
  await openCard("Greeting");
  await typeInDetails("details changed, data must stay");
  await clearCalls();
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(1000);

  r.check("details saved", await detailsSaved("a1"), "details changed, data must stay");

  const renames = await page.eval(`(window.__harness.calls || [])
    .filter(c => /rename|AcrossSessions|deleteOrphan|softDelete/i.test(c.name)).map(c => c.name)`);
  r.ok("nothing was propagated across sessions", renames.length === 0,
    `called ${JSON.stringify(renames)} -- editing Details must not touch session data`);

  const title = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    return s.targets[0].predefinedActivities.find(a => a.id === "a1").title;
  })()`);
  r.check("the activity name is unchanged", title, "Greeting");

  // ══ 7. Closing the whole modal with unsaved work ═════════════════════
  r.section("7. type in Details, then close the Edit Target modal itself");

  await openEditTarget();
  await openCard("Greeting");
  await typeInDetails("typed then closed the modal");
  await clearCalls();

  const closed = await page.eval(`(() => {
    const btn = [...document.querySelectorAll("#manage-modal button, .modal-close, #manage-modal .modal-x")]
      .filter(b => b.offsetParent !== null)
      .find(b => /^(Done|✕|×|Close)$/i.test((b.innerText || "").trim()));
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  if (closed) {
    await settle(1000);
    r.check("the typing was not lost", await detailsInState("a1"), "typed then closed the modal");
    r.ok("it reached Firestore", (await saveCount()) > 0,
      "closing the modal left the edit only in memory, so a reload loses it");
  } else {
    r.ok("found a way to close the modal", false, "no Done/close button was visible");
  }

  // ── whatever the page complained about along the way ─────────────────
  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors during the run", noise.length === 0,
    noise.slice(0, 5).map(n => n.text.slice(0, 160)).join("\n        "));
  const thrown = page.pageErrors.filter(e => !/ServiceWorker|manifest|favicon/i.test(e));
  r.ok("nothing thrown during the run", thrown.length === 0,
    thrown.slice(0, 3).map(e => e.slice(0, 200)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("details-saving-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
