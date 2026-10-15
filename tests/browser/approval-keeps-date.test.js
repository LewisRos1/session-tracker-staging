// An approved activity keeps the date it was proposed for.
//
// Rayhanah proposes an activity while writing up the 12th. Ms. Daisy gets to
// it on the 15th. The approval used to stamp the activity with the day it was
// approved, which took it out of the very session it was added for: she could
// no longer record anything against it on the 12th.
//
//   deno run -A tests/browser/approval-keeps-date.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: approval-keeps-date.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

const PROPOSED = "2026-10-12";
const TODAY = "2026-10-15";

try {
  await page.fixture({
    today: TODAY, authUser: "daisy",
    students: [{
      id: "amy", name: "Amy", order: 1,
      targets: [{
        id: "t1", name: "FEDC 1", scale: 3,
        predefinedActivities: [
          { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01",
            activeFrom: "2026-01-01" },
        ],
        // Proposed on the 12th, inside the session being written up that day.
        pendingActivities: [
          { id: "p1", title: "Asking for help", name: "", pendingAtIdx: 1,
            proposedBy: "rayhanah", createdOn: PROPOSED, activeFrom: PROPOSED },
        ],
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
  await page.until(`document.querySelectorAll(".mn-pending-card").length >= 1`, "the proposal row");
  await settle(600);

  r.section("Ms. Daisy approves it three days later");

  await page.eval(`(() => {
    const ok = [...document.querySelectorAll(".mn-pending-ok")][0];
    if (!ok) throw new Error("no Approve button");
    ok.click();
  })()`);
  await settle(900);

  const after = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    const acts = s.targets[0].predefinedActivities || [];
    const a = acts.find(x => x.title === "Asking for help");
    if (!a) return { missing: true, titles: acts.map(x => x.title) };
    return { activeFrom: a.activeFrom, createdOn: a.createdOn, stillPending: !!a._pending };
  })()`);

  r.ok("the activity is now approved", after.stillPending === false, JSON.stringify(after));
  r.check("it is active from the day it was proposed for", after.activeFrom, PROPOSED);
  r.check("and its created date is that day too", after.createdOn, PROPOSED);

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
