// "+ Add Parent Activity with Sub-activities", from adding it to closing the
// window, in a real browser.
//
// The rules, as the boss set them out:
//
//   - Adding a parent creates the parent and one blank sub-activity, both
//     ready to be clicked.
//   - You name them one at a time: name the parent, Save and Close, THEN open
//     the sub. So a blank sub-activity has to survive Save and Close.
//   - Done clears anything still blank. A named parent whose only
//     sub-activity was never filled in goes with it.
//   - A parent with one real sub and one blank keeps the parent and the real
//     sub; only the blank row goes.
//   - Opening Edit Target clears blank rows too, in case a tab was closed.
//   - A blank sub-activity never appears on a Start Session screen.
//
//   deno run -A tests/browser/parent-sub-lifecycle.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: parent-sub-lifecycle.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

const settle = (ms = 450) => new Promise(res => setTimeout(res, ms));

const fixture = (who = "daisy", acts = null) => ({
  today: "2026-10-08",
  authUser: who,
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [{
      id: "t1", name: "FEDC 1", scale: 3,
      predefinedActivities: acts || [
        { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
      ],
    }],
  }],
  groups: [], sessions: [],
});

async function openEditTarget(who = "daisy", acts = null) {
  await page.fixture(fixture(who, acts));
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 1`, "the activity list");
  await settle();
  await page.eval(`window.__dialogs = [];
    window.confirm = m => { window.__dialogs.push(m); return true; };
    window.alert  = m => { window.__dialogs.push(m); };`);
}

/** The target's rows, live and proposed together, as the app holds them. */
const rows = () => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "amy");
  const t = s.targets[0];
  const all = [
    ...(t.predefinedActivities || []),
    ...(t.pendingActivities || []),
  ];
  return all.map(a => ({
    id: a.id, title: a.title || "", details: a.name || "",
    parentOf: a._linkKey || null, childOf: a.parentActivity || null,
  }));
})()`);

/** What the Edit Target list is showing. */
const onScreen = () => page.eval(`
  [...document.querySelectorAll(".mn-act-card, .mn-sub-compact")]
    .filter(e => e.offsetParent !== null)
    .map(e => {
      const chip = e.querySelector(".mn-row-chip");
      return (chip ? chip.innerText.trim() : "SUB")
        + "|" + (e.querySelector(".mn-act-compact-title, .mn-sub-title-text")?.innerText || "").trim();
    })`);

const addParent = async () => {
  await page.click("#btn-mn-add-parent");
  await settle(900);
};

/** Open a row's panel by its position among the cards, or a sub row. */
async function openRow(selector, index = 0) {
  const hit = await page.eval(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return null;
    const t = el.querySelector(".mn-act-compact-title") || el;
    t.scrollIntoView({ block: "center" });
    const b = t.getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
  if (!hit) throw new Error(`nothing at ${selector}[${index}]`);
  await page.clickAt(hit.x, hit.y);
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-act-title-input")`, "a panel");
  await settle();
}

async function setTitle(value) {
  await page.eval(`(() => {
    const el = document.querySelector("#mn-act-panel-overlay .mn-act-title-input");
    el.focus(); el.setSelectionRange(0, el.value.length);
  })()`);
  await page.key("a", { ctrl: true });
  await page.type(value);
  await settle(200);
}

const saveAndClose = async () => {
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(800);
};

const pressDone = async () => {
  await page.click("#manage-modal-close");
  await settle(1200);
};

try {
  // ══ 1. the window has one way out ════════════════════════════════════
  r.section("1. one Done, not two");

  await openEditTarget();
  r.check("the header button says Done",
    await page.eval(`document.getElementById("manage-modal-close")?.innerText.trim()`), "Done");
  r.check("there is no second Done under the list",
    await page.eval(`!!document.getElementById("btn-mn-done-target")`), false);

  // ══ 2. a blank sub-activity survives Save and Close ══════════════════
  r.section("2. name the parent, Save and Close, the sub-activity is still there");

  await openEditTarget();
  await addParent();
  const added = await rows();
  r.check("a parent and a sub were added", added.length, 3);

  await openRow(".mn-act-card", 1);          // the new parent
  await setTitle("my parent");
  await saveAndClose();

  const afterSave = await rows();
  const parent = afterSave.find(a => a.title === "my parent");
  const sub    = afterSave.find(a => a.childOf);
  r.ok("the parent kept its name", !!parent, JSON.stringify(afterSave));
  r.ok("the blank sub-activity is still there", !!sub, JSON.stringify(afterSave));
  r.ok("and it still belongs to that parent",
    !!sub && !!parent && sub.childOf === (parent.parentOf || parent.title),
    JSON.stringify(afterSave));

  const screen = await onScreen();
  r.ok("the row still shows as a PARENT ACTIVITY",
    screen.some(x => x.startsWith("PARENT ACTIVITY")), JSON.stringify(screen));
  r.ok("with its sub-activity under it",
    screen.some(x => x.startsWith("SUB")), JSON.stringify(screen));

  // ══ 3. then name the sub-activity ════════════════════════════════════
  r.section("3. now open the sub-activity and name it");

  await openRow(".mn-sub-compact", 0);
  await setTitle("my sub");
  await saveAndClose();

  const named = await rows();
  r.ok("the sub-activity kept its name",
    named.some(a => a.title === "my sub"), JSON.stringify(named));

  await pressDone();
  const kept = await rows();
  r.ok("Done keeps a parent with a real sub-activity",
    kept.some(a => a.title === "my parent") && kept.some(a => a.title === "my sub"),
    JSON.stringify(kept));

  // ══ 4. Done clears a family that was never filled in ═════════════════
  r.section("4. Done removes a named parent whose sub-activity is still blank");

  await openEditTarget();
  await addParent();
  await openRow(".mn-act-card", 1);
  await setTitle("abandoned parent");
  await saveAndClose();
  await pressDone();

  const swept = await rows();
  r.check("only the original activity is left", swept.length, 1);
  r.check("and it is the right one", swept[0]?.title, "Greeting");

  // ══ 5. only the blank row goes when a real sub exists ════════════════
  r.section("5. a parent with one real sub and one blank keeps both parent and real sub");

  await openEditTarget("daisy", [
    { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
    { id: "p1", title: "Voice", name: "", noRemark: true, order: 1, createdOn: "2026-01-01" },
    { id: "s1", title: "Loud", name: "", parentActivity: "Voice", order: 2, createdOn: "2026-01-01" },
    { id: "s2", title: "", name: "", parentActivity: "Voice", order: 3, createdOn: "2026-01-01" },
  ]);
  await pressDone();

  const mixed = await rows();
  r.ok("the parent stayed", mixed.some(a => a.title === "Voice"), JSON.stringify(mixed));
  r.ok("the real sub-activity stayed", mixed.some(a => a.title === "Loud"), JSON.stringify(mixed));
  r.check("the blank one went", mixed.length, 3);

  // ══ 6. opening Edit Target clears what a closed tab left ═════════════
  r.section("6. opening Edit Target clears a blank row left from last time");

  await openEditTarget("daisy", [
    { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
    { id: "p1", title: "Leftover", name: "", noRemark: true, order: 1, createdOn: "2026-01-01" },
    { id: "s1", title: "", name: "", parentActivity: "Leftover", order: 2, createdOn: "2026-01-01" },
  ]);
  await settle(700);

  const onOpen = await rows();
  r.check("the leftover family is gone on open", onOpen.length, 1);
  const shown = await onScreen();
  r.ok("and nothing blank is on screen",
    !shown.some(x => x.endsWith("|") || x.includes("Leftover")), JSON.stringify(shown));

  // ══ 7. an assistant's proposal follows the same rules ════════════════
  r.section("7. the same for a proposal (Rayhanah)");

  await openEditTarget("rayhanah");
  await addParent();
  await openRow(".mn-act-card", 1);
  await setTitle("proposed parent");
  await saveAndClose();

  const proposed = await rows();
  r.ok("the proposed parent kept its name",
    proposed.some(a => a.title === "proposed parent"), JSON.stringify(proposed));
  r.ok("its blank sub-activity survived Save and Close",
    proposed.some(a => a.childOf), JSON.stringify(proposed));

  await pressDone();
  const proposedAfter = await rows();
  r.check("Done clears the unfinished proposal too", proposedAfter.length, 1);

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
  try { console.log(`screenshot: ${await page.screenshot("parent-sub-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
