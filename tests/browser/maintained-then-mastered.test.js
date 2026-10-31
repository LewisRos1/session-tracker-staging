// An activity that was maintained for months, then mastered.
//
// Lewis asked what becomes of it: on the website, and in the data the Excel
// export, the Word export and the AI reports are all built from.
//
// Mastering clears the maintained fields and sets masteredOn. The question
// is whether the months of auto-filled "Maintain" remarks already written
// into past sessions survive that, since every export and every report is
// built from those remarks.
//
//   deno run -A tests/browser/maintained-then-mastered.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: maintained-then-mastered.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 600) => new Promise(res => setTimeout(res, ms));

// Maintained since June. Three sessions since then, each carrying the
// "Maintain" note the app writes by itself, plus one real session before it.
const session = (id, date, text) => ({
  id, studentId: "s1", date, sessionNumber: Number(id.slice(4)),
  activities: { [`a_${id}`]: { configId: "act1", targetName: "Play",
    activityName: "Rolling a ball", order: 1, isPredefined: true } },
  remarks: { [`r_${id}`]: { id: `r_${id}`, activityId: `a_${id}`, text, trials: [], order: 1 } },
});

try {
  await page.fixture({
    today: "2026-10-31", authUser: "daisy",
    students: [{ id: "s1", name: "TEST yas", order: 1,
      targets: [{ id: "t1", name: "Play", scale: 3, predefinedActivities: [
        { id: "act1", title: "Rolling a ball", name: "", order: 0,
          activeFrom: "2026-01-01", createdOn: "2026-01-01",
          maintained: true, activityColor: "gray", maintainedAt: "2026-06-01" },
      ] }] }],
    groups: [],
    sessions: [
      session("sess1", "2026-05-20", "Rolled the ball back four times"),
      session("sess2", "2026-06-10", "Maintain"),
      session("sess3", "2026-08-14", "Maintain"),
      session("sess4", "2026-10-02", "Maintain"),
    ],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  r.section("before: it is a maintained activity");
  const before = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    const a = s.targets[0].predefinedActivities[0];
    return { maintained: !!a.maintained, since: a.maintainedAt || "", mastered: a.masteredOn || "" };
  })()`);
  r.check("maintained since June", before, { maintained: true, since: "2026-06-01", mastered: "" });

  r.section("master it");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await settle();
  const pressed = await page.eval(`(() => {
    const row = [...document.querySelectorAll("#manage-modal-body .mn-act-card")]
      .find(x => x.textContent.includes("Rolling a ball"));
    if (!row) return "no row";
    row.querySelector(".mn-kebab-btn")?.click();
    const btn = [...document.querySelectorAll("#manage-modal-body .mn-km-status-btn")]
      .filter(b => b.dataset.action === "master" && b.offsetParent !== null)[0];
    if (!btn) return "no master button";
    btn.click();
    return "ok";
  })()`);
  r.check("Activity Mastered is pressed", pressed, "ok");
  await page.until(`!!document.querySelector(".dp-confirm")`, "the date picker", 8000);

  const offered = await page.eval(`(() => ({
    info: document.querySelector(".dp-confirm")?.closest("div")?.innerText
      .replace(/\\s+/g, " ").trim().slice(0, 190) || "",
    min: document.getElementById("dp-date-inp")?.min || "",
    date: document.getElementById("dp-date-text")?.textContent || "",
  }))()`);
  // The last Maintain session is 2 Oct, and that is the floor: anything
  // dated after the mastery date stops being shown, so mastering it back
  // in May or June would hide the months of Maintain notes.
  r.check("the earliest allowed is the last session with anything in it",
    offered.min, "2026-10-02");
  r.check("and that is what it offers", offered.date, "2 Oct 2026");

  await page.eval(`document.querySelector(".dp-confirm").click()`);
  await settle(900);

  r.section("after: what the config says");
  const after = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    const a = (s.targets[0].predefinedActivities || [])
      .find(x => (x.title || x.name) === "Rolling a ball");
    return a ? { mastered: a.masteredOn || "", maintained: !!a.maintained,
                 maintainedAt: a.maintainedAt || "", colour: a.activityColor || "" } : null;
  })()`);
  r.check("it is mastered as of the last session", after && after.mastered, "2026-10-02");
  // Maintained AND mastered. The tag is what explains the months of
  // "Maintain" remarks under this name, so mastering keeps it and its
  // date instead of deleting both.
  r.check("it is still marked maintained", after && after.maintained, true);
  r.check("with the date it began", after && after.maintainedAt, "2026-06-01");
  // Grey means "being checked over time". It is finished now, so it goes.
  r.check("but the grey is gone", after && after.colour, "");

  r.section("the months of Maintain notes are still in the sessions");
  // Every export and every report is built from these.
  const remarks = await page.eval(`(() => {
    const out = [];
    for (const s of globalThis.__FIXTURE.sessions || []) {
      for (const rm of Object.values(s.remarks || {})) out.push({ date: s.date, text: rm.text });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  })()`);
  r.check("all four sessions still have their remark", remarks.length, 4);
  r.check("the real one before it was maintained",
    remarks[0], { date: "2026-05-20", text: "Rolled the ball back four times" });
  r.check("and the three Maintain notes are untouched",
    remarks.slice(1).map(x => x.text), ["Maintain", "Maintain", "Maintain"]);
  // None of them falls after the mastery date, which is the whole point
  // of the floor: every one of these stays visible.
  const afterMastery = remarks.filter(x => x.date > "2026-10-02").length;
  r.check("and none of them is stranded after the mastery date", afterMastery, 0);

  r.section("the website shows both tags");
  const shown = await page.eval(`(() => {
    // The Mastered section starts collapsed, so innerText cannot see
    // inside it. The markup can.
    const txt = (document.getElementById("manage-modal-body")?.innerHTML || "")
      .replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\\s+/g, " ");
    return {
      saysMastered: /Mastered on 2 Oct 2026/i.test(txt),
      saysMaintained: /Maintained on 1 Jun 2026/i.test(txt),
    };
  })()`);
  r.ok("it carries the mastered tag", shown.saysMastered, JSON.stringify(shown));
  r.ok("and the maintained tag beside it", shown.saysMaintained, JSON.stringify(shown));

  // ── the other way of finishing ──────────────────────────────────────
  // Discontinuing always kept the maintained tag; what it did NOT do is
  // drop the grey. The two actions have to behave the same, so this is
  // the same walk-through with the other button.
  r.section("discontinuing one works the same way");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    s.targets[0].predefinedActivities = [{
      id: "act1", title: "Rolling a ball", name: "", order: 0,
      activeFrom: "2026-01-01", createdOn: "2026-01-01",
      maintained: true, activityColor: "gray", maintainedAt: "2026-06-01",
    }];
    window.__app.closeManageModal?.();
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await settle();
  const pressedD = await page.eval(`(() => {
    const row = [...document.querySelectorAll("#manage-modal-body .mn-act-card")]
      .find(x => x.textContent.includes("Rolling a ball"));
    if (!row) return "no row";
    row.querySelector(".mn-kebab-btn")?.click();
    const btn = [...document.querySelectorAll("#manage-modal-body .mn-km-status-btn")]
      .filter(b => b.dataset.action === "discontinue" && b.offsetParent !== null)[0];
    if (!btn) return "no discontinue button";
    btn.click();
    return "ok";
  })()`);
  r.check("Discontinue is pressed", pressedD, "ok");
  await page.until(`!!document.querySelector(".dp-confirm")`, "the date picker", 8000);
  const offeredD = await page.eval(`document.getElementById("dp-date-inp")?.min || ""`);
  r.check("the same floor as mastering", offeredD, "2026-10-02");
  await page.eval(`document.querySelector(".dp-confirm").click()`);
  await settle(900);

  const afterD = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    const a = s.targets[0].predefinedActivities.find(x => x.title === "Rolling a ball");
    return a ? { disc: a.discontinuedOn || "", maintained: !!a.maintained,
                 maintainedAt: a.maintainedAt || "", colour: a.activityColor || "" } : null;
  })()`);
  r.check("it is discontinued", afterD && afterD.disc, "2026-10-02");
  r.check("still marked maintained", afterD && afterD.maintained, true);
  r.check("with its date", afterD && afterD.maintainedAt, "2026-06-01");
  r.check("and the grey gone, the same as mastering", afterD && afterD.colour, "");

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

r.done("Maintained for months, then mastered");
