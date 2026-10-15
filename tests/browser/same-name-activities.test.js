// Two activities with the same name must not share one record.
//
// A Behaviour Chart has an "Antecedent", a "Behaviours" and a "Consequence"
// under every behaviour, so the same three names appear under each heading.
// Lewis typed remarks into the first set and they appeared under the second
// set as well, which he had not touched. Typing under the second would then
// have written over the first.
//
// The card looked up its record by name and, finding exactly one, took it --
// without checking that it already belonged to a live sibling activity.
//
//   deno run -A tests/browser/same-name-activities.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: same-name-activities.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

// The shape Lewis builds all the time: one heading per behaviour, the same
// three names underneath each.
const ACTS = [
  { id: "h1", isHeading: true, name: "Behaviour Chart 1", order: 0 },
  { id: "a1", title: "Antecedent",  name: "", order: 1, createdOn: "2026-10-14" },
  { id: "a2", title: "Behaviours",  name: "", order: 2, createdOn: "2026-10-14" },
  { id: "a3", title: "Consequence", name: "", order: 3, createdOn: "2026-10-14" },
  { id: "h2", isHeading: true, name: "Behaviour Chart 2", order: 4 },
  { id: "a4", title: "Antecedent",  name: "", order: 5, createdOn: "2026-10-14" },
  { id: "a5", title: "Behaviours",  name: "", order: 6, createdOn: "2026-10-14" },
  { id: "a6", title: "Consequence", name: "", order: 7, createdOn: "2026-10-14" },
];

const fixture = {
  today: "2026-10-15",
  authUser: "daisy",
  students: [{
    id: "st1", name: "TEST yas", order: 1,
    targets: [{ id: "t1", name: "Behaviour Chart", scale: 3, predefinedActivities: ACTS }],
  }],
  groups: [], sessions: [],
};

// Only the FIRST Antecedent has anything in it. Written exactly as the app
// writes a record: a generated key, with the activity it belongs to named.
const TYPED = "typed into chart one only";
const sessionData = {
  date: "2026-10-15", targetName: "Behaviour Chart",
  activities: {
    rec1: { configId: "a1", targetName: "Behaviour Chart", activityName: "Antecedent",
            order: 1, isPredefined: true },
  },
  remarks: { rem1: { activityId: "rec1", text: TYPED, trials: [], order: 1 } },
};

try {
  await page.fixture(fixture);
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");

  const html = await page.eval(`(() => {
    const s = window.__app.state;
    s.currentStudent = s.students.find(x => x.id === "st1");
    s.selectedTargetName = "Behaviour Chart";
    s.currentSessionId = "sess1";
    s.sessionData = ${JSON.stringify(sessionData)};
    document.getElementById("screen-session")?.classList.remove("hidden");
    const out = window.__app.renderFedcTarget(s.currentStudent.targets[0]);
    return Array.isArray(out) ? out.join("") : String(out ?? "");
  })()`);

  r.section("a remark typed under one heading");

  // Not counted across the whole screen: calling the renderer directly emits
  // a section more than once, which is this test's doing and not the app's.
  // What matters is which record each activity is wired to.
  r.ok("the remark is on screen at all", html.includes(TYPED), "it rendered nowhere");

  // Which record each card is wired to. Two cards pointing at one record is
  // the fault itself: whichever is typed into last wins.
  const bound = await page.eval(`(() => {
    const s = window.__app.state;
    const out = window.__app.renderFedcTarget(s.currentStudent.targets[0]);
    const h = Array.isArray(out) ? out.join("") : String(out ?? "");
    const box = document.createElement("div");
    box.innerHTML = h;
    return [...box.querySelectorAll("[data-cfg-id]")].map(el => ({
      cfg: el.getAttribute("data-cfg-id"),
      act: el.getAttribute("data-act-id") || "",
    })).filter(x => x.cfg);
  })()`);

  const used = bound.filter(b => b.act).map(b => b.act);
  r.check("no record is claimed by two activities at once",
    used.length - new Set(used).size, 0);

  const a1 = bound.find(b => b.cfg === "a1");
  const a4 = bound.find(b => b.cfg === "a4");
  r.ok("the activity that was typed into holds the record",
    a1?.act === "rec1", JSON.stringify(a1));
  r.ok("the other Antecedent holds nothing",
    !a4?.act, JSON.stringify(a4));

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 160)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
