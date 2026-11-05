// A parent activity can have Details, and typing them keeps its children.
//
// Details are stored in an activity's `name`. A sub-activity finds its
// parent by `parentActivity === <the parent's key>`, and the Details box's
// blur handler treated every edit as a rename: it repointed every
// sub-activity at whatever had just been typed and called
// propagateActivityRename, which rewrites every session document for that
// student. So a Details box on a parent would have scattered its children
// the moment anybody used it, which is why parents never had one.
//
// A row that has a title is identified BY that title -- `name` is only the
// details line underneath it -- and a parent must always have a title: the
// screen refuses to close and flashes the field red otherwise. So the fix
// is to rename only when the title is blank, which is the same question the
// duplicate check three lines above it was already asking.
//
//   deno run -A tests/browser/parent-details.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: parent-details.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 450) => new Promise(res => setTimeout(res, ms));

// One parent with five sub-activities, the shape Lewis was looking at.
const ACTS = [
  // Details already filled in, which is the case that matters: an edit
  // with nothing to rename FROM never reached the rename at all.
  { id: "p1", title: "To Pee into the toilet bowl", name: "Step by step",
    order: 0, createdOn: "2026-01-01" },
  ...[1, 2, 3, 4, 5].map((n, i) => ({
    id: `s${n}`, title: `Attempt ${n}`, name: "", order: i + 1,
    parentActivity: "To Pee into the toilet bowl", createdOn: "2026-01-01",
  })),
];

async function openEditTarget(acts) {
  await page.fixture({
    today: "2026-11-05", authUser: "daisy",
    students: [{
      id: "amy", name: "Amy", order: 1,
      targets: [{ id: "t1", name: "Toilet Training", scale: 3,
                  predefinedActivities: JSON.parse(JSON.stringify(acts)) }],
    }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll("#manage-modal-body .mn-act-details-input").length >= 1`,
    "the activity list");
  await settle();
}

/** Every row as the app holds it, after whatever just happened. */
const rows = () => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "amy");
  return (s.targets[0].predefinedActivities || []).map(a => ({
    id: a.id, title: a.title || "", name: a.name || "",
    parent: a.parentActivity || null,
  }));
})()`);

/** Every session-wide rename the app has asked the service for. */
const renameCalls = () => page.eval(`(() => {
  const calls = (window.__harness && window.__harness.calls) || [];
  return calls
    .filter(c => c.name === "renameActivityAcrossSessions")
    .map(c => (c.args || []).slice(2));   // [oldName, newName]
})()`);

/** Type into a row's Details box and blur it, the way a person would. */
const typeDetails = async (id, text) => {
  await page.eval(`(async () => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    const acts = s.targets[0].predefinedActivities;
    const idx = acts.findIndex(a => a.id === ${JSON.stringify(id)});
    const ta = document.getElementById("mn-act-details-" + idx);
    if (!ta) throw new Error("no Details box on row " + idx);
    ta.focus();
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.dispatchEvent(new Event("blur", { bubbles: true }));
  })()`);
  await settle(600);
};

try {
  // ── 1. the box exists ───────────────────────────────────────────────
  r.section("1. a parent activity has a Details box");
  await openEditTarget(ACTS);
  const boxes = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    const acts = s.targets[0].predefinedActivities;
    return acts.map((a, i) => ({
      title: a.title,
      hasDetails: !!document.getElementById("mn-act-details-" + i),
    }));
  })()`);
  r.check("the parent has one", boxes[0].hasDetails, true);
  r.check("and every sub-activity still has one",
    boxes.slice(1).every(b => b.hasDetails), true);

  // ── 2. typing in it keeps the children ──────────────────────────────
  //
  // The whole reason the box was withheld. Five sub-activities point at
  // "To Pee into the toilet bowl"; none of them may end up pointing at
  // the details text.
  r.section("2. typing details does not scatter the sub-activities");
  await typeDetails("p1", "Pants down, sit, wait, flush");
  const after = await rows();
  const parent = after.find(a => a.id === "p1");
  const subs = after.filter(a => a.id !== "p1");

  r.check("the details are stored", parent.name, "Pants down, sit, wait, flush");
  r.check("the parent keeps its title", parent.title, "To Pee into the toilet bowl");
  r.check("all five sub-activities are still there", subs.length, 5);
  r.check("and every one still points at the parent",
    subs.map(a => a.parent),
    Array(5).fill("To Pee into the toilet bowl"));
  r.check("none was repointed at the details text",
    subs.some(a => a.parent === "Pants down, sit, wait, flush"), false);

  // The part that actually changed. A details edit used to call
  // renameActivityAcrossSessions, which rewrites every session document
  // where an activity carries that name -- so editing a parent's details
  // could rename an unrelated activity that happened to be called the
  // same thing, and rewrote records even when it matched nothing.
  r.check("and no session rewrite was fired",
    await renameCalls(), []);

  // Editing it again must be just as safe.
  await typeDetails("p1", "Pants down, sit, wait");
  const after2 = await rows();
  r.check("and again on a second edit",
    after2.filter(a => a.id !== "p1").map(a => a.parent),
    Array(5).fill("To Pee into the toilet bowl"));
  r.check("with the new details kept",
    after2.find(a => a.id === "p1").name, "Pants down, sit, wait");

  // ── 3. a sub-activity's own details behave the same ─────────────────
  r.section("3. a sub-activity's details are just as safe");
  await typeDetails("s2", "Second go");
  const after3 = await rows();
  r.check("its details are stored",
    after3.find(a => a.id === "s2").name, "Second go");
  r.check("it still sits under the same parent",
    after3.find(a => a.id === "s2").parent, "To Pee into the toilet bowl");
  r.check("and its title is untouched",
    after3.find(a => a.id === "s2").title, "Attempt 2");

  // ── 4. an untitled row still renames, as it always did ──────────────
  //
  // With no title, the details line IS the activity's name, so changing
  // it is a real rename and the children have to come with it.
  r.section("4. an untitled parent still renames, because its name is its name");
  await openEditTarget([
    { id: "p1", title: "", name: "Old parent name", order: 0, createdOn: "2026-01-01" },
    { id: "s1", title: "Attempt 1", name: "", order: 1,
      parentActivity: "Old parent name", createdOn: "2026-01-01" },
  ]);
  await typeDetails("p1", "New parent name");
  const untitled = await rows();
  r.check("the name changed",
    untitled.find(a => a.id === "p1").name, "New parent name");
  r.check("and the child came with it",
    untitled.find(a => a.id === "s1").parent, "New parent name");

  // ── 5. the rule is written once, and asked the same way twice ───────
  r.section("5. the rename and the duplicate check now agree");
  const src = await Deno.readTextFile("app.js");
  r.check("the target screen asks whether the title is blank",
    /const isIdentity = !\(a\.title \|\| ""\)\.trim\(\);/.test(src), true);
  r.check("and only repoints when it is",
    /if \(isIdentity\) \{\s*\r?\n\s*acts\.forEach\(a2 => \{ if \(a2\.parentActivity === oldName\)/.test(src), true);
  r.check("and only rewrites sessions when it is",
    /if \(isIdentity && oldName && v\) propagateActivityRename/.test(src), true);
  r.check("the template screen asks the same question",
    /if \(!\(a\.title \|\| ""\)\.trim\(\)\) \{\s*\r?\n\s*acts\.forEach\(a2 => \{ if \(a2\.parentActivity === oldName\)/.test(src), true);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join(" | "));
} finally {
  await page.close?.();
}

r.done("A parent activity's Details");
