// The "Move this activity under a Parent Activity" picker.
//
// It used to be a flat list of activity names, with no sign of which section
// each one belonged to -- so a target with three activities called
// "Behaviours" under different headings offered three identical buttons.
//
// It now follows the shape of the target: each activity under its own
// section heading and indented beneath it. A heading cannot be a parent, so
// it is a label rather than a button, and a heading with nothing pickable
// under it is left out. Sub-activities are never listed, because nothing can
// go under one; a parent says how many it has instead.
//
//   deno run -A tests/browser/move-under-parent.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: move-under-parent.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 450) => new Promise(res => setTimeout(res, ms));

// One heading with ordinary activities, one with a parent that already has
// two sub-activities, and one whose only activity is the one being moved --
// so that heading has nothing left to offer and must not be drawn.
const ACTS = [
  { id: "h1", name: "Behaviour Chart 1", isHeading: true, order: 0 },
  { id: "a1", name: "Antecedent",   order: 1, activeFrom: "2026-10-01" },
  { id: "a2", name: "Behaviours",    order: 2, activeFrom: "2026-10-01" },
  { id: "h2", name: "Behaviour Chart 2", isHeading: true, order: 3 },
  { id: "a3", name: "Consequences",  order: 4, activeFrom: "2026-10-01", noRemark: true },
  { id: "s1", name: "First sub",  parentActivity: "Consequences", order: 5, activeFrom: "2026-10-01" },
  { id: "s2", name: "Second sub", parentActivity: "Consequences", order: 6, activeFrom: "2026-10-01" },
  { id: "h3", name: "Empty Section", isHeading: true, order: 7 },
  { id: "a4", name: "kek lahh",      order: 8, activeFrom: "2026-10-01" },
];

try {
  await page.fixture({
    today: "2026-10-21", authUser: "daisy",
    students: [{ id: "s1", name: "TEST yas", order: 1,
      targets: [{ id: "t1", name: "Behaviour Chart", scale: 3, predefinedActivities: ACTS }] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await settle();

  r.section("open the picker on \"kek lahh\"");
  const opened = await page.eval(`(() => {
    const rows = [...document.querySelectorAll("#manage-modal-body .mn-act-card")];
    const row = rows.find(x => x.textContent.includes("kek lahh"));
    if (!row) return "no row";
    const kebab = row.querySelector(".mn-kebab-btn");
    if (!kebab) return "no kebab";
    kebab.click();
    const move = [...document.querySelectorAll("#manage-modal-body .mn-km-move-to-parent")]
      .filter(b => b.offsetParent !== null);
    if (!move.length) return "no move button";
    move[0].click();
    return "ok";
  })()`);
  r.check("the picker opens", opened, "ok");
  await settle(400);

  const picker = await page.eval(`(() => {
    const ov = document.querySelector("[data-move-overlay]");
    if (!ov) return null;
    const box = ov.firstElementChild;
    return {
      headings: [...box.querySelectorAll("div")]
        .filter(d => /uppercase/.test(d.getAttribute("style") || ""))
        .map(d => d.textContent.trim()),
      buttons: [...box.querySelectorAll(".mn-move-pick-btn")].map(b => ({
        text: b.textContent.replace(/\\s+/g, " ").trim(),
        indented: /margin-left: *\\.9rem/.test(b.getAttribute("style") || ""),
      })),
    };
  })()`);
  r.ok("the picker is on screen", !!picker, "no overlay found");

  r.section("what it offers");
  const texts = picker ? picker.buttons.map(b => b.text) : [];
  r.check("the two headings that have something under them are shown",
    picker && picker.headings, ["Behaviour Chart 1", "Behaviour Chart 2"]);
  // "Empty Section" holds only the activity being moved, so it offers nothing.
  r.ok("a heading with nothing pickable is left out",
    !!picker && !picker.headings.includes("Empty Section"),
    JSON.stringify(picker && picker.headings));

  r.check("three activities are offered", texts.length, 3);
  r.ok("the activity being moved is not one of them",
    !texts.some(t => t.includes("kek lahh")), JSON.stringify(texts));
  r.ok("and neither are the sub-activities",
    !texts.some(t => t.includes("First sub") || t.includes("Second sub")),
    JSON.stringify(texts));

  r.section("a parent says how many it has");
  r.ok("Consequences is marked as having two",
    texts.some(t => /Consequences.*\(2 sub-activities\)/.test(t)), JSON.stringify(texts));
  r.ok("and an activity with none says nothing",
    texts.some(t => t === "Antecedent"), JSON.stringify(texts));

  r.section("everything under a heading is indented");
  r.ok("all three are indented",
    !!picker && picker.buttons.every(b => b.indented),
    JSON.stringify(picker && picker.buttons));

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

r.done("Moving an activity under a parent");
