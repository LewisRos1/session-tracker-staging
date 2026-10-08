// Two people, two browsers, one set of records.
//
// Lewis approved a sub-activity as Ms. Daisy, closed the window, saw it on the
// Start Session screen, and a little later it was waiting for approval again.
// He had Rayhanah signed in in another window at the same time.
//
// Every save writes the WHOLE student record, so a browser holding an older
// copy can put it back and undo what the other one just did. This file runs
// two real browsers against one shared store to find out whether that is what
// happens.
//
//   deno run -A tests/browser/two-tabs-approval.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: two-tabs-approval.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const settle = (ms = 600) => new Promise(res => setTimeout(res, ms));

/** One student, one target, with a sub-activity proposed by the assistant. */
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

/** Where the sub-activity lives, according to the shared store. */
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
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 1`, "the activity list");
  await settle();
};

try {
  r.section("both browsers are looking at the same records");

  await start(daisy, "daisy");
  await start(ray, "rayhanah");

  r.check("it starts off waiting for approval", await inStore(), "still waiting");

  // Rayhanah has Edit Target open, as she would while proposing things.
  await openEditTarget(ray);
  r.ok("Rayhanah has Edit Target open",
    await ray.eval(`!document.getElementById("manage-modal").classList.contains("hidden")`));

  r.section("Ms. Daisy approves it");

  await openEditTarget(daisy);
  const approved = await daisy.eval(`(() => {
    const btn = [...document.querySelectorAll(".mn-pending-approve, .mn-pending-foot button")]
      .filter(b => b.offsetParent !== null && /Approve/i.test(b.innerText) && !b.disabled)[0];
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  r.ok("the Approve button was there and was pressed", approved,
    "no enabled Approve button on Ms. Daisy's screen");
  await settle(900);

  // ...and closes the window with Done, as he did.
  await daisy.click("#manage-modal-close");
  await settle(1200);

  r.check("the store says it is approved", await inStore(), "approved");

  r.section("then Rayhanah's browser saves something");

  // Her listener has had time to hear about the approval.
  await settle(1200);

  // Anything at all that writes. Closing her window is the mildest thing she
  // could do, and it always saves.
  await ray.eval(`window.__app.closeManageModal()`);
  await settle(1500);

  const after = await inStore();
  r.check("the approval is still there", after, "approved");

  if (after !== "approved") {
    console.log("\n        Rayhanah's browser put the record back as it was before the approval.");
    const rayView = await ray.eval(`(() => {
      const s = window.__app.state.students.find(x => x.id === "amy");
      const t = s.targets[0];
      return { live: (t.predefinedActivities || []).map(a => a.id),
               pending: (t.pendingActivities || []).map(a => a.id) };
    })()`);
    console.log("        what her browser held: " + JSON.stringify(rayView));
  }

  r.section("and the other way round");

  // Ms. Daisy's browser now saves. Hers should be the fresher copy.
  await openEditTarget(daisy);
  await daisy.eval(`window.__app.closeManageModal()`);
  await settle(1500);
  r.check("Ms. Daisy's save does not undo anything either", await inStore(), "approved");

  // ══ her panel's own Save and Close ══════════════════════════════════
  //
  // Lewis's sequence: Rayhanah opens the activity she proposed and starts
  // editing it. Ms. Daisy approves it while that panel is open. Rayhanah then
  // presses Save and Close on the panel -- not Done on the window.
  r.section("Rayhanah saves from the panel while it is being approved");

  // The store keeps what the first scenario wrote, and a page only seeds it
  // when it is empty -- so it has to be cleared before new records go in.
  const clearStore = async () => {
    const res = await fetch(`http://127.0.0.1:${daisy.site.port}/__store/students`).then(x => x.json());
    for (const doc of res.docs) {
      await fetch(`http://127.0.0.1:${daisy.site.port}/__store/students/${doc.id}`, { method: "DELETE" });
    }
  };
  await clearStore();

  // Fresh records for this run.
  const SOLO = {
    today: "2026-10-08", sharedStore: true,
    students: [{
      id: "bea", name: "Bea", order: 1,
      targets: [{
        id: "t2", name: "FEDC 2", scale: 3,
        predefinedActivities: [
          { id: "b1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
        ],
        pendingActivities: [
          { id: "q1", title: "kahahahah", name: "asdfsd", pendingAtIdx: 1,
            proposedBy: "ray", createdOn: "2026-10-08" },
        ],
      }],
    }],
    groups: [], sessions: [],
  };

  /** How many times this activity appears, and where. */
  const whereIsQ1 = async () => {
    const res = await fetch(`http://127.0.0.1:${daisy.site.port}/__store/students`).then(x => x.json());
    const t = res.docs.find(d => d.id === "bea")?.targets?.[0];
    return {
      live:    (t?.predefinedActivities || []).filter(a => a.id === "q1").length,
      pending: (t?.pendingActivities   || []).filter(a => a.id === "q1").length,
      liveTitles: (t?.predefinedActivities || []).map(a => a.title),
      pendingTitles: (t?.pendingActivities || []).map(a => a.title),
    };
  };

  for (const [page, who] of [[ray, "rayhanah"], [daisy, "daisy"]]) {
    await page.fixture({ ...SOLO, authUser: who });
    await page.load();
    await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, `home for ${who}`);
    // Say NO to the "somebody else changed this" warning, which is what a
    // person would do, and yes to anything else.
    await page.eval(`window.__asked = [];
      window.confirm = m => { window.__asked.push(m); return !/resend Approval/i.test(m); };
      window.alert = () => {};`);
    await page.eval(`(() => {
      const s = window.__app.state.students.find(x => x.id === "bea");
      window.__app.openManageModal(s, s.targets[0]);
    })()`);
    await page.until(`document.querySelectorAll(".mn-act-card").length >= 2`, `the list for ${who}`);
    await settle();
  }

  // Rayhanah opens her proposal and types into its Details.
  const opened = await ray.eval(`(() => {
    const card = [...document.querySelectorAll(".mn-act-card")]
      .find(c => (c.innerText || "").includes("kahahahah"));
    if (!card) return false;
    const t = card.querySelector(".mn-act-compact-title");
    t.scrollIntoView({ block: "center" });
    const b = t.getBoundingClientRect();
    window.__hit = { x: b.left + 40, y: b.top + b.height / 2 };
    return true;
  })()`);
  r.ok("Rayhanah can see her own proposal", opened);
  const hit = await ray.eval(`window.__hit`);
  await ray.clickAt(hit.x, hit.y);
  await ray.until(`document.querySelector("#mn-act-panel-overlay .mn-rich, #mn-act-panel-overlay textarea")`,
    "her activity panel");
  await settle();
  await ray.eval(`(() => {
    const p = document.querySelector("#mn-act-panel-overlay");
    const box = p.querySelector(".mn-rich") || p.querySelector(".mn-act-details-input");
    box.focus();
    const sel = window.getSelection(), rg = document.createRange();
    rg.selectNodeContents(box); rg.collapse(false);
    sel.removeAllRanges(); sel.addRange(rg);
  })()`);
  await ray.type(" and more");
  await settle(300);

  // Ms. Daisy approves it while that panel is open.
  const approvedSolo = await daisy.eval(`(() => {
    const btn = [...document.querySelectorAll(".mn-pending-foot button")]
      .filter(b => b.offsetParent !== null && /Approve/i.test(b.innerText) && !b.disabled)[0];
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  r.ok("Ms. Daisy approved it", approvedSolo);
  await settle(1200);
  r.check("it is approved in the store", (await whereIsQ1()).live, 1);

  // Rayhanah presses Save and Close on her panel.
  await ray.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(1500);

  const asked = await ray.eval(`window.__asked || []`);
  r.ok("she was warned before her save could overwrite it",
    asked.some(m => /resend Approval/i.test(m)),
    `she was asked: ${JSON.stringify(asked)}`);

  const spot = await whereIsQ1();
  r.check("it is still approved, once", spot.live, 1);
  r.check("and it has NOT come back as a proposal", spot.pending, 0);
  if (spot.pending) {
    console.log(`        live:    ${JSON.stringify(spot.liveTitles)}`);
    console.log(`        pending: ${JSON.stringify(spot.pendingTitles)}`);
    console.log("        Her Save and Close put the proposal back alongside the approved one.");
  }

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
