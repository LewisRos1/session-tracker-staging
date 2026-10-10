// A window must not mistake its own save for somebody else's change.
//
// Edit Target watches the record it is editing, so that a change made on
// another machine can be taken on board. But every save from this screen comes
// back through that same watch. Without telling the two apart, the window
// flagged ITSELF: add anything, press Discard Changes, and it asked
//
//   Somebody else changed this target while you had it open.
//   Save your changes anyway?
//
// with nobody else involved. It used to name Ms. Daisy and claim an approval,
// which it knew nothing about -- see stale-flag-carryover.test.js.
//
// All four "+ Add" buttons go the same way, so all four are checked.
//
//   deno run -A tests/browser/own-save-echo.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: own-save-echo.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 700) => new Promise(res => setTimeout(res, ms));

// sharedStore puts a real listener behind the screen. Without one nothing
// polls, the echo never arrives, and this bug cannot show itself at all --
// which is why it was not caught before.
const FIX = (who) => ({
  today: "2026-10-10", authUser: who, sharedStore: true,
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [{ id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: [
      { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
    ] }],
  }],
  groups: [], sessions: [],
});

const clearStore = async () => {
  // Records AND locks. A page that reloads without pressing Done leaves its
  // lock behind for ten minutes, which is right in the app and would lock
  // every later part of this run out of the target.
  for (const kind of ["students", "editLocks"]) {
    const res = await fetch(`http://127.0.0.1:${page.site.port}/__store/${kind}`).then(x => x.json());
    for (const doc of res.docs) {
      await fetch(`http://127.0.0.1:${page.site.port}/__store/${kind}/${doc.id}`, { method: "DELETE" });
    }
  }
};

async function openEditTarget(who) {
  await clearStore();
  await page.fixture(FIX(who));
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, `home for ${who}`);
  await page.eval(`window.__asked = [];
    window.confirm = m => { window.__asked.push(m); return true; };
    window.alert = () => {};`);
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 1`, "the activity list");
  await settle();
}

/** Type into whichever field the new row opened with. */
async function typeSomething(text) {
  const where = await page.eval(`(() => {
    const p = document.querySelector("#mn-act-panel-overlay");
    if (!p) return null;
    const el = p.querySelector(".mn-act-title-input, .mn-act-name-input, textarea, .mn-rich");
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    el.focus();
    if (el.isContentEditable) {
      const sel = window.getSelection(), rg = document.createRange();
      rg.selectNodeContents(el); rg.collapse(false);
      sel.removeAllRanges(); sel.addRange(rg);
    } else if (el.setSelectionRange) {
      el.setSelectionRange(el.value.length, el.value.length);
    }
    return el.className;
  })()`);
  if (!where) return false;
  await page.type(text);
  await settle(400);
  return true;
}

const falseApproval = () => page.eval(`
  (window.__asked || []).filter(m =>
    /resend Approval|changed this target|Save your changes anyway/i.test(m))`);

const BUTTONS = [
  ["+ Add Activity",                        "btn-mn-add-act"],
  ["+ Add Parent Activity with Sub-activities", "btn-mn-add-parent"],
  ["+ Add Section Heading",                 "btn-mn-add-heading"],
  ["+ Add Note",                            "btn-mn-add-note"],
];

try {
  for (const [label, id] of BUTTONS) {
    r.section(`${label} → type → Discard Changes`);

    await openEditTarget("daisy");
    await page.click("#" + id);
    await page.until(`document.querySelector("#mn-act-panel-overlay")
      && getComputedStyle(document.querySelector("#mn-act-panel-overlay")).display !== "none"`,
      `the panel for ${label}`);
    await settle(700);

    r.ok("something to type into opened", await typeSomething("typed by the test"));

    await page.click("#mn-act-panel-overlay .mn-act-panel-discard");
    await settle(1600);

    const bogus = await falseApproval();
    r.check("no approval question", bogus, []);

    // What Discard has to undo is the typing. Counting rows would be the
    // wrong question: a blank parent and its blank sub-activity are allowed
    // to stay until Done -- they are what you came to fill in.
    const survived = await page.eval(`(() => {
      const s = window.__app.state.students.find(x => x.id === "amy");
      const t = s.targets[0];
      return [...(t.predefinedActivities || []), ...(t.pendingActivities || [])]
        .some(a => JSON.stringify(a).includes("typed by the test"));
    })()`);
    r.ok("what was typed did not survive the discard", !survived,
      "the text is still in the list");
  }

  r.section("and the same for an assistant, whose rows are proposals");

  await openEditTarget("rayhanah");
  await page.click("#btn-mn-add-act");
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-act-title-input")`, "the panel");
  await settle(700);
  await typeSomething("a proposal");
  await page.click("#mn-act-panel-overlay .mn-act-panel-discard");
  await settle(1600);
  r.check("no approval question for her either", await falseApproval(), []);

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 4).map(n => n.text.slice(0, 160)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("own-save-echo-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
