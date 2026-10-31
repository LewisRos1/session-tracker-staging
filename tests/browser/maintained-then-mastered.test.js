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
  // A "Maintain" note is not therapy data, by design:
  //   if ((rText === "Maintain" || rNote === "Maintain") && !rTrials ...) return false;
  // so the three Maintain sessions are not the last data. The last REAL
  // data was 20 May, and the floor is then the day maintaining began.
  r.check("the earliest allowed is the day it began being maintained",
    offered.min, "2026-06-01");
  r.check("and that is what it offers", offered.date, "1 Jun 2026");

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
  // Worth knowing rather than fixing quietly: accept the default and the
  // activity is mastered as of the day maintaining STARTED, months back,
  // while the Maintain notes from after that date stay in the sessions.
  r.check("it is mastered as of the day maintaining began",
    after && after.mastered, "2026-06-01");
  // These have to go, or it would be both at once. Several places read
  // maintainedAt with a hardcoded fallback date, all of them behind a check
  // on `maintained`, so clearing the flag is what keeps them out of it.
  r.check("and no longer maintained", after && after.maintained, false);
  r.check("with the maintained date cleared", after && after.maintainedAt, "");
  r.check("and the grey colour cleared", after && after.colour, "");

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
  // All three are dated AFTER the mastery date the picker offered. The
  // exports and the reports are built from these remarks, so the history
  // runs months past the date the activity says it was mastered.
  const afterMastery = remarks.filter(x => x.date > "2026-06-01").length;
  r.check("all three fall after the mastery date it suggested", afterMastery, 3);

  r.section("the website shows it as mastered, not maintained");
  const shown = await page.eval(`(() => {
    const txt = document.getElementById("manage-modal-body")?.innerText || "";
    return {
      saysMastered: /Mastered/i.test(txt),
      stillSaysMaintainedOn: /Maintained on/i.test(txt),
    };
  })()`);
  r.ok("it is labelled mastered", shown.saysMastered, JSON.stringify(shown));
  r.ok("and carries no maintained tag", !shown.stillSaysMaintainedOn, JSON.stringify(shown));

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
