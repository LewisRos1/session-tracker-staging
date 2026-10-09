// What an assistant may and may not touch in Edit Target.
//
// Everything already approved belongs to the main teachers. An assistant adds
// proposals and edits her own, and that is all. The fields inside an approved
// row were already read-only, but the row still opened, so she could sit in a
// panel full of dead boxes with no idea why nothing would type.
//
//   deno run -A tests/browser/assistant-readonly.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: assistant-readonly.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 700) => new Promise(res => setTimeout(res, ms));

const FIX = (who) => ({
  today: "2026-10-08", authUser: who,
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [{
      id: "t1", name: "FEDC 1", scale: 3,
      predefinedActivities: [
        { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
        { id: "n1", isNote: true, text: "A note", noteTitle: "A note", noteDetails: "",
          order: 1, createdOn: "2026-01-01" },
        { id: "m1", title: "Old one", name: "", order: 2, createdOn: "2026-01-01",
          masteredOn: "2026-08-17" },
      ],
      pendingActivities: [
        { id: "q1", title: "mine", name: "", pendingAtIdx: 3,
          proposedBy: "ray", createdOn: "2026-10-08" },
      ],
    }],
  }],
  groups: [], sessions: [],
});

const open = async (who) => {
  await page.fixture(FIX(who));
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, `home for ${who}`);
  await page.eval(`window.confirm = () => true; window.alert = () => {};`);
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 2`, "the activity list");
  await settle();
};

/** Click the card whose text contains `label`, and say what came up. */
const clickRow = async (label) => {
  const hit = await page.eval(`(() => {
    const card = [...document.querySelectorAll(".mn-act-card")]
      .find(c => (c.innerText || "").includes(${JSON.stringify(label)}));
    if (!card) return null;
    const t = card.querySelector(".mn-act-compact-title") || card;
    t.scrollIntoView({ block: "center" });
    const b = t.getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
  if (!hit) throw new Error(`no row says "${label}"`);
  await page.clickAt(hit.x, hit.y);
  await settle(600);
  return {
    panelOpen: await page.eval(`(() => {
      const el = document.getElementById("mn-act-panel-overlay");
      return !!el && getComputedStyle(el).display !== "none";
    })()`),
    lock: await page.eval(`
      document.querySelector("[data-lock-overlay]")?.innerText.replace(/\\s+/g, " ").trim() || null`),
  };
};

const dismiss = () => page.eval(`
  document.querySelectorAll("[data-lock-overlay]").forEach(e => e.remove());
  document.querySelectorAll("#mn-act-panel-overlay").forEach(e => { e.style.display = "none"; });`);

try {
  r.section("the assistant, on work that is already approved");

  await open("rayhanah");

  const approved = await clickRow("Greeting");
  r.ok("an approved activity does not open", !approved.panelOpen,
    "the panel opened on an approved row");
  r.ok("and she is told who can change it",
    /Only Ms\. Daisy can make changes to approved activities\./i.test(approved.lock || ""),
    `she saw ${JSON.stringify(approved.lock)}`);
  console.log(`        activity: ${approved.lock}`);
  await dismiss();

  const note = await clickRow("A note");
  r.ok("an approved note does not open either", !note.panelOpen);
  r.ok("and it is called a note", /approved notes/i.test(note.lock || ""),
    `she saw ${JSON.stringify(note.lock)}`);
  console.log(`        note:     ${note.lock}`);
  await dismiss();

  r.ok("the cursor says so before she clicks",
    await page.eval(`(() => {
      const card = [...document.querySelectorAll(".mn-act-card")]
        .find(c => (c.innerText || "").includes("Greeting"));
      return card ? getComputedStyle(card).cursor : "(no row)";
    })()`) === "not-allowed");

  r.section("but her own proposal is hers to edit");

  const mine = await clickRow("mine");
  r.ok("her own proposal opens", mine.panelOpen, `lock said ${JSON.stringify(mine.lock)}`);
  r.ok("with no lock message", !mine.lock);
  await dismiss();

  r.section("she can still look at the mastered list");

  const opened = await page.eval(`(() => {
    const btn = [...document.querySelectorAll(".mn-inact-toggle")]
      .find(b => /Mastered/i.test(b.innerText));
    if (!btn) return "(no toggle)";
    btn.click();
    return true;
  })()`);
  await settle(500);
  r.ok("the mastered list opens for her", opened === true,
    `toggle result ${JSON.stringify(opened)}`);
  r.ok("and opening it did not show a lock",
    !(await page.eval(`!!document.querySelector("[data-lock-overlay]")`)));

  r.section("a main teacher is not restricted");

  await open("daisy");
  const asDaisy = await clickRow("Greeting");
  r.ok("Ms. Daisy can open an approved activity", asDaisy.panelOpen);
  r.ok("and sees no lock", !asDaisy.lock, `she saw ${JSON.stringify(asDaisy.lock)}`);
  r.ok("and her cursor is normal",
    await page.eval(`(() => {
      const card = [...document.querySelectorAll(".mn-act-card")]
        .find(c => (c.innerText || "").includes("Greeting"));
      return card ? getComputedStyle(card).cursor : "(no row)";
    })()`) !== "not-allowed");

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 4).map(n => n.text.slice(0, 160)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("assistant-readonly-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
