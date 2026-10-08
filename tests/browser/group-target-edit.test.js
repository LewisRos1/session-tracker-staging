// Editing a GROUP target's activities, in a real browser.
//
// Individual and group sessions are parallel features and share the Edit
// Target screen, but the save goes somewhere else: saveGroup, chosen by a
// module flag that closeManageModal clears on the way out. So the group path
// needs its own checks rather than being assumed to follow the individual one.
//
// The case that started this file: an activity whose title was blank and
// whose Details said "Yuh". Moving "Yuh" up into the title and typing
// something new into Details, then pressing Save and Close, left the group
// session screen still showing the placeholder title with "Yuh" underneath.
//
//   deno run -A tests/browser/group-target-edit.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: group-target-edit.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

const fixture = () => ({
  today: "2026-10-08",
  authUser: "daisy",
  students: [
    { id: "s1", name: "Test Wong", order: 1, targets: [] },
    { id: "s2", name: "Test Yas",  order: 2, targets: [] },
  ],
  groups: [{
    id: "g1", name: "test WONG & TEST yas", order: 1,
    students: ["s1", "s2"],
    targets: [{
      id: "gt1", name: "FEDC 1", scale: 3,
      predefinedActivities: [
        // Exactly the shape on screen: no title, the words sitting in Details.
        { id: "ga1", title: "", name: "Yuh",  order: 0, createdOn: "2026-01-01" },
        { id: "ga2", title: "", name: "Gang", order: 1, createdOn: "2026-01-01" },
      ],
    }],
  }],
  sessions: [],
});

const settle = (ms = 450) => new Promise(res => setTimeout(res, ms));

async function openGroupEditTarget() {
  await page.fixture(fixture());
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`(() => {
    const g = window.__app.state.groups.find(x => x.id === "g1");
    window.__app.openGroupManageModal(g, g.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 2`, "the activity list");
  await settle();
  await page.eval(`window.__dialogs = [];
    window.confirm = m => { window.__dialogs.push(m); return true; };
    window.alert  = m => { window.__dialogs.push(m); };
    window.__harness.calls.length = 0;`);
}

/**
 * Open the card at position `idx`.
 *
 * Not by its visible words: Edit Target's collapsed header shows the TITLE
 * alone, so an activity whose words live in Details -- which is exactly the
 * case being tested -- reads "(Untitled activity)" there.
 */
async function openCard(idx) {
  const hit = await page.eval(`(() => {
    const card = document.querySelectorAll(".mn-act-card")[${idx}];
    if (!card) return null;
    const t = card.querySelector(".mn-act-compact-title");
    t.scrollIntoView({ block: "center" });
    const b = t.getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
  if (!hit) throw new Error(`no activity card at position ${idx}`);
  await page.clickAt(hit.x, hit.y);
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-act-title-input")`, `the panel for card ${idx}`);
  await settle();
}

/** Replace the Activity Title, as a person would: select all, then type. */
async function setTitle(text) {
  await page.eval(`(() => {
    const el = document.querySelector("#mn-act-panel-overlay .mn-act-title-input");
    el.scrollIntoView({ block: "center" });
    el.focus();
    el.setSelectionRange(0, el.value.length);
  })()`);
  await page.key("a", { ctrl: true });
  await page.type(text);
  await settle(250);
}

/** Replace the Details text. */
async function setDetails(text) {
  await page.eval(`(() => {
    const p = document.querySelector("#mn-act-panel-overlay");
    const box = p.querySelector(".mn-rich") || p.querySelector(".mn-act-details-input");
    box.scrollIntoView({ block: "center" });
    box.focus();
    if (box.isContentEditable) {
      const sel = window.getSelection(), rg = document.createRange();
      rg.selectNodeContents(box);
      sel.removeAllRanges(); sel.addRange(rg);
    } else { box.setSelectionRange(0, box.value.length); }
  })()`);
  await page.key("a", { ctrl: true });
  await page.type(text);
  await settle(250);
}

/** What the app holds for this activity, as every screen reads it. */
const inState = (id) => page.eval(`(() => {
  const g = window.__app.state.groups.find(x => x.id === "g1");
  const a = (g.targets[0].predefinedActivities || []).find(a => a.id === ${JSON.stringify(id)});
  return a ? { title: a.title || "", details: a.name || "" } : "(gone)";
})()`);

/** What the last write to Firestore contained. */
const inSave = (id) => page.eval(`(() => {
  const calls = (window.__harness.calls || []).filter(c => c.name === "saveGroup");
  if (!calls.length) return "(nothing was saved)";
  const g = calls[calls.length - 1].args[0];
  const t = (g.targets || []).find(t => t.id === "gt1");
  const a = (t?.predefinedActivities || []).find(a => a.id === ${JSON.stringify(id)});
  return a ? { title: a.title || "", details: a.name || "" } : "(activity missing from the save)";
})()`);

const savedToStudentInstead = () => page.eval(`
  (window.__harness.calls || []).filter(c => c.name === "saveStudent").length`);

try {
  // ══ 1. Move the words from Details up into the Title ═════════════════
  r.section("1. group: move Details into the Title, Save and Close");

  await openGroupEditTarget();
  await openCard(0);   // the one whose words are in Details
  await setTitle("Yuh");
  await setDetails("yes");
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(900);

  r.check("the app has the new title and details", await inState("ga1"),
    { title: "Yuh", details: "yes" });
  r.check("that is what was written to Firestore", await inSave("ga1"),
    { title: "Yuh", details: "yes" });
  r.check("it did not save to a student by mistake", await savedToStudentInstead(), 0);
  r.check("the other activity was left alone", await inState("ga2"),
    { title: "", details: "Gang" });

  // ══ 2. The same edit, then closing the modal ═════════════════════════
  r.section("2. group: the same edit, then close the Edit Target window");

  await openGroupEditTarget();
  await openCard(0);   // the one whose words are in Details
  await setTitle("Yuh");
  await setDetails("yes");
  await page.eval(`window.__app.closeManageModal()`);
  await settle(1000);

  r.check("the app has it", await inState("ga1"), { title: "Yuh", details: "yes" });
  r.check("written to Firestore", await inSave("ga1"), { title: "Yuh", details: "yes" });
  r.check("still not saved to a student", await savedToStudentInstead(), 0);

  // ══ 3. Details alone, on a group ═════════════════════════════════════
  r.section("3. group: change only the Details");

  await openGroupEditTarget();
  await openCard(1);
  await setDetails("group details text");
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(900);

  r.check("the app has it", await inState("ga2"), { title: "", details: "group details text" });
  r.check("written to Firestore", await inSave("ga2"), { title: "", details: "group details text" });

  // ══ 4. Discard, on a group ═══════════════════════════════════════════
  r.section("4. group: Discard Changes");

  await openGroupEditTarget();
  await openCard(0);   // the one whose words are in Details
  await setDetails("this should vanish");
  await page.click("#mn-act-panel-overlay .mn-act-panel-discard");
  await settle(900);

  r.check("the app put it back", await inState("ga1"), { title: "", details: "Yuh" });

  // Reopen before counting: a discard closes the panel, so an empty panel
  // proves nothing. What matters is that reopening shows ONE box, not the
  // discarded one stacked on top of the real one.
  await openCard(0);
  r.check("only one Details box on reopen",
    await page.eval(`document.querySelectorAll("#mn-act-panel-overlay .mn-act-details-input").length`), 1);
  r.check("and it shows the restored text",
    await page.eval(`(() => {
      const p = document.querySelector("#mn-act-panel-overlay");
      const box = p.querySelector(".mn-rich") || p.querySelector(".mn-act-details-input");
      return (box.isContentEditable ? box.innerText : box.value).trim();
    })()`), "Yuh");

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors during the run", noise.length === 0,
    noise.slice(0, 5).map(n => n.text.slice(0, 160)).join("\n        "));
  const thrown = page.pageErrors.filter(e => !/ServiceWorker|manifest|favicon/i.test(e));
  r.ok("nothing thrown during the run", thrown.length === 0,
    thrown.slice(0, 3).map(e => e.slice(0, 200)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("group-target-edit-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
