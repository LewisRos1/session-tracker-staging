// A sub-activity's own kebab menu, and the pending rows above it.
//
// Lewis reported the kebab missing from his sub-activities. The compact row
// is rendered without one; it is MOVED there afterwards, out of the
// sub-activity's full editor, which is found by index:
//
//   const item = list.querySelector(`.mn-sub-item[data-idx="${subIdx}"]`);
//   const subKebab = item.querySelector(".mn-sub-kebab-wrap");
//
// His target had seven items waiting for approval, and a proposal is
// spliced into the middle of the list at its pendingAtIdx, which moves every
// activity after it. This checks the kebabs are still there when that has
// happened.
//
//   deno run -A tests/browser/sub-kebab-reachable.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: sub-kebab-reachable.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 600) => new Promise(res => setTimeout(res, ms));

const kebabs = () => page.eval(`(() => {
  const rows = [...document.querySelectorAll("#manage-modal-body .mn-sub-compact")];
  return rows.map(e => ({
    text: e.innerText.replace(/\\s+/g, " ").trim().slice(0, 40),
    hasKebab: !!e.querySelector(".mn-sub-kebab-btn"),
    pending: e.classList.contains("mn-pending-card"),
  }));
})()`);

const open = (target) => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "s1");
  s.targets[0] = ${JSON.stringify(target)};
  window.__app.openManageModal(s, s.targets[0]);
})()`);

try {
  await page.fixture({
    today: "2026-10-31", authUser: "daisy",
    students: [{ id: "s1", name: "TEST yas", order: 1,
      targets: [{ id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: [] }] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // ── 1. nothing pending ───────────────────────────────────────────────
  r.section("1. a parent with two sub-activities, nothing pending");
  await open({
    id: "t1", name: "FEDC 1", scale: 3,
    predefinedActivities: [
      { id: "p1", title: "hello", name: "", noRemark: true, order: 0, createdOn: "2026-01-01" },
      { id: "sa", title: "[Unnamed Subactivity]", name: "", parentActivity: "hello", order: 1, createdOn: "2026-01-01" },
      { id: "sb", title: "bch nga", name: "", parentActivity: "hello", order: 2, createdOn: "2026-01-01" },
    ],
  });
  await settle();
  const plain = await kebabs();
  r.check("both sub-activities are listed", plain.length, 2);
  r.ok("and both have their kebab on the row",
    plain.every(x => x.hasKebab), JSON.stringify(plain));

  // ── 2. a proposal spliced in above them ──────────────────────────────
  // This is Lewis's screenshot: a parent waiting for approval, with its own
  // pending sub-activity, sitting directly above an approved family.
  r.section("2. with a proposal spliced in above, as Lewis had");
  await open({
    id: "t1", name: "FEDC 1", scale: 3,
    predefinedActivities: [
      { id: "p1", title: "hello", name: "", noRemark: true, order: 0, createdOn: "2026-01-01" },
      { id: "sa", title: "[Unnamed Subactivity]", name: "", parentActivity: "hello", order: 1, createdOn: "2026-01-01" },
      { id: "sb", title: "bch nga", name: "", parentActivity: "hello", order: 2, createdOn: "2026-01-01" },
    ],
    pendingActivities: [
      { id: "pp", title: "idk", name: "", noRemark: true, pendingAtIdx: 0,
        createdOn: "2026-01-01", proposedBy: "rayhanah" },
      { id: "ps", title: "shit la", name: "", parentActivity: "idk", pendingAtIdx: 1,
        createdOn: "2026-01-01", proposedBy: "rayhanah" },
    ],
  });
  await settle(900);

  const withPending = await kebabs();
  r.check("three sub-activity rows now", withPending.length, 3);

  const approved = withPending.filter(x => !x.pending);
  r.check("two of them are the approved ones", approved.length, 2);
  // The one Lewis reported. A proposal above them must not cost the approved
  // sub-activities their menu.
  r.ok("the approved sub-activities keep their kebab",
    approved.length > 0 && approved.every(x => x.hasKebab),
    JSON.stringify(withPending));

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

r.done("A sub-activity's kebab menu");
