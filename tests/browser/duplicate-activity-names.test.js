// Two rows in one target that a person could not tell apart.
//
// Lewis found a parent activity called "hello" with no sub-activities under
// it, while the Start Session screen showed two. The cause was a second
// parent also called "hello": a sub-activity stores its parent as a NAME and
// nothing else, so both parents matched and one of them drew empty.
//
// The obvious fix -- refuse every repeated name -- turned out to be wrong.
// A scan of live found 18 repeated names and every one of them was put there
// on purpose:
//
//   Hayden's Behaviour Chart   "Behaviour 1" and "Behaviour 2", each with its
//                              own Antecedent, Behaviours and Consequence
//   Leven's Social Skills      "Social Detective" and "SSJ Diary", each with
//                              its own Situation and Comment
//   Hayden's Social Skills     "I can wait", mastered, then started again
//
// So the rule is about what is distinguishable on the page, not about the
// string. Same name under a different section heading is fine. Same name
// under the SAME heading is not. A parent is stricter than both, because the
// link from a sub-activity carries no heading with it.
//
//   deno run -A tests/browser/duplicate-activity-names.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: duplicate-activity-names.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 650) => new Promise(res => setTimeout(res, ms));

// The refusal is showAlertOverlay, a real overlay with an OK button, not
// window.alert. Read what it said and dismiss it the way a person would.
const takeAlert = () => page.eval(`(() => {
  const ok = [...document.querySelectorAll("button.dp-ok")].pop();
  if (!ok) return null;
  const box = ok.closest("div[style*='position:fixed']") || ok.parentElement.parentElement;
  const said = (box?.innerText || "").replace(/\\s+/g, " ").trim();
  ok.click();
  return said;
})()`);

const openTarget = (acts) => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "s1");
  s.targets[0] = { id: "t1", name: "FEDC 1", scale: 3,
    predefinedActivities: ${JSON.stringify(acts)} };
  window.__app.openManageModal(s, s.targets[0]);
})()`);

const closeTarget = () => page.eval(`window.__app.closeManageModal()`);

// Type into a row's box and blur it, the way a person does.
const rename = (rowText, field, value) => page.eval(`(async () => {
  const sel = { title: ".mn-act-title-input", details: ".mn-act-details-input" }[${JSON.stringify(field)}];
  const el = [...document.querySelectorAll("#manage-modal-body " + sel)]
    .find(x => (x.value || "").trim() === ${JSON.stringify(rowText)});
  if (!el) return "NO ROW: " + ${JSON.stringify(rowText)};
  el.focus();
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  await new Promise(res => setTimeout(res, 450));
  return el.value;
})()`);

// What is actually stored, in list order, headings marked.
const configNames = () => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "s1");
  return (s.targets[0].predefinedActivities || []).map(a =>
    (a.isHeading ? "# " : a.parentActivity ? "  " : "") + (a.title || a.name || "").trim());
})()`);

// The rule itself, asked directly. The handlers above are how a person
// reaches it; this is every branch of it, without the typing.
const conflict = (acts, idx, proposed, asParent = false) => page.eval(`(() => {
  const acts = ${JSON.stringify(acts)};
  const hit = window.__app.mnNameConflict(acts, acts[${idx}], ${JSON.stringify(proposed)}, ${asParent});
  return hit ? (hit.title || hit.name || "(blank)") : null;
})()`);

// Hayden's Behaviour Chart, as it actually is on live.
const CHART = [
  { id: "h1", title: "Behaviour 1", name: "", isHeading: true, order: 0 },
  { id: "a1", title: "Antecedent",  name: "", order: 1, createdOn: "2026-01-01" },
  { id: "a2", title: "Behaviours",  name: "", order: 2, createdOn: "2026-01-01" },
  { id: "a3", title: "Consequence", name: "", order: 3, createdOn: "2026-01-01" },
  { id: "h2", title: "Behaviour 2", name: "", isHeading: true, order: 4 },
  { id: "a4", title: "Antecedent",  name: "", order: 5, createdOn: "2026-01-01" },
  { id: "a5", title: "Behaviours",  name: "", order: 6, createdOn: "2026-01-01" },
  { id: "a6", title: "Consequence", name: "", order: 7, createdOn: "2026-01-01" },
];

// A parent with a sub, a plain activity, and one mastered long ago.
const MIXED = [
  { id: "p1", title: "hello",     name: "", noRemark: true, order: 0, createdOn: "2026-01-01" },
  { id: "s1", title: "bch nga",   name: "", parentActivity: "hello", order: 1, createdOn: "2026-01-01" },
  { id: "m1", title: "kek lahh",  name: "", order: 2, createdOn: "2026-01-01" },
  { id: "m2", title: "I can wait", name: "", order: 3, createdOn: "2026-01-01",
    masteredOn: "2026-05-01" },
];

try {
  await page.fixture({
    today: "2026-11-01", authUser: "daisy",
    students: [{ id: "s1", name: "TEST yas", order: 1,
      targets: [{ id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: [] }] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // ── 1. the live Behaviour Chart must stay legal ─────────────────────
  r.section("1. the same name under a different section heading");
  r.check("Behaviour 2's Antecedent does not clash with Behaviour 1's",
    await conflict(CHART, 5, "Antecedent"), null);
  r.check("nor does its Consequence",
    await conflict(CHART, 7, "Consequence"), null);
  r.check("Leven's two Situations are the same shape and also fine",
    await conflict(CHART, 6, "Behaviours"), null);

  r.section("2. but not twice under ONE heading");
  r.check("renaming Behaviour 2's Behaviours to Antecedent is refused",
    await conflict(CHART, 6, "Antecedent"), "Antecedent");
  r.check("and the same inside Behaviour 1",
    await conflict(CHART, 2, "Consequence"), "Consequence");

  r.section("3. case and spacing are not a difference");
  r.check("ANTECEDENT is Antecedent", await conflict(CHART, 6, "ANTECEDENT"), "Antecedent");
  r.check("so is '  antecedent  '", await conflict(CHART, 6, "  antecedent  "), "Antecedent");
  r.check("so is one with markup", await conflict(CHART, 6, "*Antecedent*"), "Antecedent");
  r.check("but a_b is not ab", await conflict(CHART, 6, "Antecedent 2"), null);

  // ── 4. the bug that started it ──────────────────────────────────────
  r.section("4. two parent activities, wherever they sit");
  r.check("a second row may not take a parent's name",
    await conflict(MIXED, 2, "hello"), "hello");
  r.check("and a parent may not take a plain activity's name",
    await conflict(MIXED, 0, "kek lahh"), "kek lahh");
  // Same name, different sections -- allowed for plain rows, refused once
  // either of them is a parent, because the link carries no heading.
  const CHART_PARENT = CHART.map(a => a.id === "a1" ? { ...a, noRemark: true } : a)
    .concat([{ id: "sx", title: "step one", name: "", parentActivity: "Antecedent", order: 8 }]);
  r.check("a parent's name is taken even in another section",
    await conflict(CHART_PARENT, 5, "Antecedent"), "Antecedent");

  r.section("5. sub-activities");
  const SIBS = [
    { id: "p1", title: "Chart 1", name: "", noRemark: true, order: 0 },
    { id: "x1", title: "Antecedent", name: "", parentActivity: "Chart 1", order: 1 },
    { id: "x2", title: "Consequence", name: "", parentActivity: "Chart 1", order: 2 },
    { id: "p2", title: "Chart 2", name: "", noRemark: true, order: 3 },
    { id: "y1", title: "Antecedent", name: "", parentActivity: "Chart 2", order: 4 },
  ];
  r.check("one name under two different parents is fine",
    await conflict(SIBS, 4, "Antecedent"), null);
  r.check("but not twice under one parent",
    await conflict(SIBS, 2, "Antecedent"), "Antecedent");

  r.section("6. a name that has been finished with");
  r.check("a mastered activity does not hold its name",
    await conflict(MIXED, 2, "I can wait"), null);
  const DISC = MIXED.map(a => a.id === "m2"
    ? { id: "m2", title: "I can wait", name: "", order: 3, discontinuedOn: "2026-05-01" } : a);
  r.check("nor does a discontinued one", await conflict(DISC, 2, "I can wait"), null);

  r.section("7. headings and notes are not activities");
  const WITHNOTE = CHART.concat([
    { id: "n1", isNote: true, text: "Antecedent", order: 8 },
  ]);
  r.check("an activity may be called what a heading is called",
    await conflict(CHART, 1, "Behaviour 1"), null);
  r.check("and a note never clashes with anything",
    await conflict(WITHNOTE, 8, "Antecedent"), null);
  r.check("nor does an activity clash with a note",
    await conflict(WITHNOTE, 5, "Antecedent"), null);

  // ── 8. through the actual Edit Target window ────────────────────────
  r.section("8. typing it, in Edit Target");
  await openTarget(CHART);
  await settle();
  const typed = await rename("Behaviours", "title", "Antecedent");
  r.check("the typed name is put straight back", typed, "Behaviours");
  const said = await takeAlert();
  r.ok("and a message says why", !!said && /already/i.test(said), String(said).slice(0, 200));
  r.ok("naming what it clashed with", !!said && said.includes("Antecedent"), String(said).slice(0, 200));
  r.ok("and which section", !!said && /Behaviour 1/.test(said), String(said).slice(0, 200));
  await settle(300);
  r.check("nothing was saved", await configNames(),
    ["# Behaviour 1", "Antecedent", "Behaviours", "Consequence",
     "# Behaviour 2", "Antecedent", "Behaviours", "Consequence"]);

  r.section("9. a free name still goes in");
  const ok2 = await rename("Consequence", "title", "Consequence 2");
  r.check("accepted", ok2, "Consequence 2");
  r.check("with nothing said", await takeAlert(), null);
  await settle(300);
  const after = await configNames();
  r.ok("and saved", after.includes("Consequence 2"), JSON.stringify(after));

  r.section("10. repairing a duplicate that is already there");
  await closeTarget();
  await settle(300);
  await openTarget([
    { id: "p1", title: "hello", name: "", noRemark: true, order: 0 },
    { id: "s1", title: "bch nga", name: "", parentActivity: "hello", order: 1 },
    { id: "p2", title: "hello", name: "", order: 2 },
  ]);
  await settle();
  const fixed = await rename("hello", "title", "hello 2");
  r.ok("one of the pair can be renamed out of the way",
    fixed === "hello 2", String(fixed));
  r.check("with nothing said", await takeAlert(), null);

  // ── 11. the drag Lewis asked for ────────────────────────────────────
  //
  // Dropped where it should not be, then put back. A real drag: pointerdown
  // on the handle, the placeholder moved to the slot under the pointer, then
  // pointerup -- which is exactly what initDragSort reads.
  r.section("11. dragging a row into a section that already has the name");
  await closeTarget();
  await settle(300);
  await openTarget(CHART);
  await settle();

  const rowTitles = () => page.eval(`(() => {
    return [...document.querySelectorAll("#mn-act-list > [data-idx]")].map(el => {
      const inp = el.querySelector(".mn-act-title-input, .mn-heading-input");
      return (inp ? inp.value : el.innerText).replace(/\\s+/g, " ").trim().slice(0, 30);
    });
  })()`);

  const before = await rowTitles();
  r.ok("the list starts with both sections", before.length >= 8, JSON.stringify(before));

  // Grab Behaviour 2's Antecedent (list index 5) and drop it directly after
  // Behaviour 1's Antecedent (list index 1).
  const dragged = await page.eval(`(async () => {
    const list = document.getElementById("mn-act-list");
    const rows = [...list.querySelectorAll(":scope > [data-idx]")];
    const from = rows.find(el => Number(el.dataset.idx) === 5);
    const to   = rows.find(el => Number(el.dataset.idx) === 1);
    if (!from || !to) return "rows not found";
    const handle = from.querySelector(".drag-handle");
    if (!handle) return "no drag handle";
    const r1 = from.getBoundingClientRect();
    const pd = new PointerEvent("pointerdown", { bubbles: true, cancelable: true,
      clientX: r1.left + 8, clientY: r1.top + 8, pointerId: 1 });
    handle.dispatchEvent(pd);
    const ph = list.querySelector(".drag-placeholder");
    if (!ph) return "drag never started";
    // Put the gap where the pointer would have carried it.
    to.after(ph);
    list.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    // A real browser follows pointerup with a click at the release point.
    // endDrag arms a one-shot listener to swallow exactly that one, so a test
    // that never sends it leaves the listener armed to eat the next real click.
    list.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(res => setTimeout(res, 800));
    return "dropped";
  })()`);
  r.check("the drag ran", dragged, "dropped");
  const dragSaid = await takeAlert();
  r.ok("it was refused", !!dragSaid && /already/i.test(String(dragSaid)),
    String(dragSaid).slice(0, 200));
  r.ok("saying which section it landed in",
    !!dragSaid && /Behaviour 1/.test(String(dragSaid)), String(dragSaid).slice(0, 200));

  await settle(400);
  r.check("and the row snapped back to where it was", await configNames(),
    ["# Behaviour 1", "Antecedent", "Behaviours", "Consequence",
     "# Behaviour 2", "Antecedent", "Behaviours", "Consequence"]);
  const orders = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    return (s.targets[0].predefinedActivities || []).map(a => a.order);
  })()`);
  r.check("with its order numbers put back too", orders, [0, 1, 2, 3, 4, 5, 6, 7]);

  r.check("and the message closes on the first click on OK",
    await page.eval(`document.querySelectorAll("button.dp-ok").length`), 0);

  r.section("12. a drag that does not clash still works");
  const moved2 = await page.eval(`(async () => {
    const list = document.getElementById("mn-act-list");
    const rows = [...list.querySelectorAll(":scope > [data-idx]")];
    const from = rows.find(el => Number(el.dataset.idx) === 3);   // Consequence
    const to   = rows.find(el => Number(el.dataset.idx) === 1);   // Antecedent
    if (!from || !to) return "rows not found";
    const r1 = from.getBoundingClientRect();
    from.querySelector(".drag-handle").dispatchEvent(new PointerEvent("pointerdown",
      { bubbles: true, cancelable: true, clientX: r1.left + 8, clientY: r1.top + 8, pointerId: 2 }));
    const ph = list.querySelector(".drag-placeholder");
    if (!ph) return "drag never started";
    to.before(ph);
    list.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 2 }));
    list.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise(res => setTimeout(res, 800));
    return "dropped";
  })()`);
  r.check("the drag ran", moved2, "dropped");
  r.check("nothing was said", await takeAlert(), null);
  await settle(400);
  r.check("and the row moved", await configNames(),
    ["# Behaviour 1", "Consequence", "Antecedent", "Behaviours",
     "# Behaviour 2", "Antecedent", "Behaviours", "Consequence"]);

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

r.done("Duplicate activity names");
