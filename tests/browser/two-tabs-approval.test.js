// Two people, two browsers, one set of records.
//
// This file started as a reproduction: Lewis approved a sub-activity as
// Ms. Daisy, and a little later it was waiting for approval again, because
// Rayhanah's window held a copy from before the approval and wrote it back.
//
// The lock means that can no longer happen -- two people cannot both be in one
// target's Edit Target at once -- so what this checks now is the whole
// arrangement end to end: kept out while somebody is in, let in once they
// leave, and an approval that stays approved.
//
// The lock itself is checked in edit-target-lock.test.js.
//
//   deno run -A tests/browser/two-tabs-approval.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: two-tabs-approval.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const settle = (ms = 700) => new Promise(res => setTimeout(res, ms));

/** A sub-activity proposed by the assistant, under an approved parent. */
const START = {
  today: "2026-10-08",
  sharedStore: true,
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [{
      id: "t1", name: "FEDC 1", scale: 3,
      predefinedActivities: [
        { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
        { id: "p1", title: "the parent", name: "", noRemark: true, _linkKey: "pk1",
          order: 1, createdOn: "2026-01-01" },
      ],
      pendingActivities: [
        { id: "s1", title: "as", name: "", parentActivity: "pk1",
          pendingAtIdx: 2, proposedBy: "ray", createdOn: "2026-10-08" },
      ],
    }],
  }],
  groups: [], sessions: [],
};

const daisy = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const ray   = await openPage(dir, { site: daisy.site });

/** Where the proposed sub-activity lives, according to the shared store. */
const inStore = async () => {
  const res = await fetch(`http://127.0.0.1:${daisy.site.port}/__store/students`).then(x => x.json());
  const t = res.docs.find(d => d.id === "amy")?.targets?.[0];
  const live    = (t?.predefinedActivities || []).some(a => a.id === "s1");
  const pending = (t?.pendingActivities   || []).some(a => a.id === "s1");
  return live ? "approved" : pending ? "still waiting" : "gone";
};

async function start(page, who) {
  await page.fixture({ ...START, authUser: who });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`,
    `the home screen for ${who}`);
  await page.eval(`window.confirm = () => true; window.alert = () => {};`);
}

const openEditTarget = async (page) => {
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await settle(1000);
};

const modalOpen = (page) => page.eval(
  `!document.getElementById("manage-modal").classList.contains("hidden")`);

const pressApprove = (page) => page.eval(`(() => {
  const btn = [...document.querySelectorAll(".mn-pending-foot button")]
    .filter(b => b.offsetParent !== null && /Approve/i.test(b.innerText) && !b.disabled)[0];
  if (!btn) return false;
  btn.click();
  return true;
})()`);

try {
  r.section("both browsers are looking at the same records");

  await start(daisy, "daisy");
  await start(ray, "rayhanah");
  r.check("it starts off waiting for approval", await inStore(), "still waiting");

  r.section("Rayhanah is in the target, so Ms. Daisy is kept out");

  await openEditTarget(ray);
  r.ok("Rayhanah is in", await modalOpen(ray));

  await openEditTarget(daisy);
  r.ok("Ms. Daisy could not get in", !(await modalOpen(daisy)));
  const told = await daisy.eval(`
    document.querySelector("[data-lock-wait]")?.innerText.replace(/\\s+/g, " ").trim() || null`);
  r.ok("and she is told who is in there", /Rayhanah/.test(told || ""),
    `she saw ${JSON.stringify(told)}`);

  r.check("nothing changed while she was kept out", await inStore(), "still waiting");

  r.section("Rayhanah finishes, Ms. Daisy approves");

  await ray.click("#manage-modal-close");
  await settle(1300);

  await daisy.eval(`document.querySelector("[data-lock-wait]")?.remove()`);
  await openEditTarget(daisy);
  r.ok("now Ms. Daisy can get in", await modalOpen(daisy));

  r.ok("the Approve button was there and was pressed", await pressApprove(daisy));
  await settle(1100);
  r.check("the store says it is approved", await inStore(), "approved");

  await daisy.click("#manage-modal-close");
  await settle(1300);
  r.check("and it is still approved after she closes", await inStore(), "approved");

  r.section("Rayhanah opens it again and sees the approval");

  await openEditTarget(ray);
  r.ok("she can get in now", await modalOpen(ray));

  const stillPending = await ray.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    const t = s.targets[0];
    return (t.pendingActivities || []).some(a => a.id === "s1");
  })()`);
  r.ok("her window shows it as approved, not waiting", !stillPending,
    "her browser still has it in the waiting list");

  await ray.click("#manage-modal-close");
  await settle(1300);
  r.check("and her closing does not undo it", await inStore(), "approved");

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  for (const [who, page] of [["Ms. Daisy", daisy], ["Rayhanah", ray]]) {
    const noise = page.consoleLines.filter(l => l.level === "error");
    r.ok(`${who}: no console errors`, noise.length === 0,
      noise.slice(0, 4).map(n => n.text.slice(0, 160)).join("\n        "));
  }
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await daisy.screenshot("two-tabs-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await ray.close();
  await daisy.close();
}

Deno.exit(r.done() ? 1 : 0);
