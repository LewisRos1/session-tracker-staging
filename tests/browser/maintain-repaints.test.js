// Maintain repaints the row it was used on.
//
// Lewis pressed "Maintain Activity" on an activity in Edit Target, chose the
// date, and the row stayed exactly as it was: no grey, no "Maintained on"
// tag. Closing Edit Target and opening it again showed both, so the write
// had gone through and only the drawing on screen was stale.
//
//   deno run -A tests/browser/maintain-repaints.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: maintain-repaints.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 500) => new Promise(res => setTimeout(res, ms));

try {
  await page.fixture({
    today: "2026-10-21",
    authUser: "daisy",
    students: [{
      id: "s1", name: "TEST yas", order: 1,
      targets: [{
        id: "t1", name: "Behaviour Chart", scale: 3,
        predefinedActivities: [
          { id: "a1", name: "Antecedent", order: 0, activeFrom: "2026-10-15" },
          { id: "a2", name: "kek lahh",   order: 1, activeFrom: "2026-10-15" },
          { id: "a3", name: "Consequences", order: 2, activeFrom: "2026-10-15" },
        ],
      }],
    }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // Opened the way Lewis opened it: from inside a live session, not from
  // the home screen. The session screen stays behind the window, and the
  // handler repaints it too.
  await page.eval(`(() => {
    const s = window.__app.state;
    s.currentStudent = s.students.find(x => x.id === "s1");
    s.selectedTargetName = "Behaviour Chart";
    s.currentSessionId = "sess1";
    s.sessionData = { date: "2026-10-21", targetName: "Behaviour Chart",
                      activities: {}, remarks: {} };
    document.getElementById("screen-session")?.classList.remove("hidden");
    window.__app.openManageModal(s.currentStudent, s.currentStudent.targets[0]);
  })()`);
  await settle();

  r.section("before: the row is an ordinary activity");
  const before = await page.eval(`(() => {
    const rows = [...document.querySelectorAll("#manage-modal-body .mn-act-card")];
    const row = rows.find(x => x.textContent.includes("kek lahh"));
    return row ? { found: true, maintained: /Maintained on/.test(row.textContent) } : { found: false };
  })()`);
  r.ok("the activity is on screen", before.found, JSON.stringify(before));
  r.check("and is not maintained yet", before.maintained, false);

  r.section("press Maintain Activity and confirm the date");
  // The kebab for that row, then the Maintain entry inside it.
  const opened = await page.eval(`(() => {
    const rows = [...document.querySelectorAll("#manage-modal-body .mn-act-card")];
    const row = rows.find(x => x.textContent.includes("kek lahh"));
    if (!row) return "no row";
    const kebab = row.querySelector(".mn-kebab-btn");
    if (!kebab) return "no kebab";
    kebab.click();
    return "ok";
  })()`);
  r.check("the kebab opens", opened, "ok");
  await settle(300);

  const pressed = await page.eval(`(() => {
    const btns = [...document.querySelectorAll("#manage-modal-body .mn-km-status-btn")]
      .filter(b => b.dataset.action === "maintain" && b.offsetParent !== null);
    if (!btns.length) return "no maintain button";
    btns[0].click();
    return "ok";
  })()`);
  r.check("Maintain Activity is pressed", pressed, "ok");
  // It checks past sessions before the date picker appears.
  await page.until(`!!document.querySelector(".dp-confirm")`, "the date picker", 8000);

  const shown = await page.eval(`(() => {
    const ov = document.querySelector(".dp-confirm")?.closest("div[style]")?.parentElement;
    return {
      date: document.getElementById("dp-date-text")?.textContent || "",
      tag: document.getElementById("dp-date-default")?.textContent || "",
      min: document.getElementById("dp-date-inp")?.min || "",
    };
  })()`);
  r.check("it offers today", shown.date, "21 Oct 2026");
  r.check("marked as the default", shown.tag, "(Default)");
  // Created 15 Oct, no sessions, so the calendar may go back to creation.
  r.check("and allows back-dating to the creation date", shown.min, "2026-10-15");

  await page.eval(`document.querySelector(".dp-confirm").click()`);
  await settle(900);

  r.section("after: the row says so straight away, without reopening");
  const after = await page.eval(`(() => {
    const rows = [...document.querySelectorAll("#manage-modal-body .mn-act-card")];
    const row = rows.find(x => x.textContent.includes("kek lahh"));
    if (!row) return { found: false };
    return {
      found: true,
      maintained: /Maintained on/.test(row.textContent),
      text: row.textContent.replace(/\\s+/g, " ").trim().slice(0, 90),
    };
  })()`);
  r.ok("the row is still there", after.found, JSON.stringify(after));
  r.ok("and now shows it is maintained", after.maintained,
    `the row still reads: ${after.text}`);

  r.section("and the change really was saved");
  const saved = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    const a = (s.targets[0].predefinedActivities || []).find(x => x.name === "kek lahh");
    return { maintained: !!a?.maintained, at: a?.maintainedAt || "" };
  })()`);
  r.check("maintained is set on the activity", saved.maintained, true);
  r.check("with today's date", saved.at, "2026-10-21");

  // ---- the same thing again, with an activity panel open ----------------
  // Opening a panel puts a hold on every write and keeps a snapshot for
  // Discard Changes. Delete hit exactly this and had to close the panel
  // first (v2266); the status buttons never learned to.
  r.section("with another activity's panel open");
  const panelOpened = await page.eval(`(() => {
    const rows = [...document.querySelectorAll("#manage-modal-body .mn-act-card")];
    const row = rows.find(x => x.textContent.includes("Antecedent"));
    if (!row) return "no row";
    row.click();
    return "clicked";
  })()`);
  await settle(500);
  const holdOn = await page.eval(`!!document.querySelector(".mn-act-panel-open")`);
  r.ok("a panel really is open", holdOn === true,
    `click said ${panelOpened}, panel in DOM: ${holdOn}`);

  const pressed2 = await page.eval(`(() => {
    const rows = [...document.querySelectorAll("#manage-modal-body .mn-act-card")];
    const row = rows.find(x => x.textContent.includes("Consequences"));
    const kebab = row && row.querySelector(".mn-kebab-btn");
    if (!kebab) return "no kebab";
    kebab.click();
    const btns = [...document.querySelectorAll("#manage-modal-body .mn-km-status-btn")]
      .filter(b => b.dataset.action === "maintain" && b.offsetParent !== null);
    if (!btns.length) return "no maintain button";
    btns[0].click();
    return "ok";
  })()`);
  r.check("Maintain is pressed on another row", pressed2, "ok");
  await page.until(`!!document.querySelector(".dp-confirm")`, "the date picker", 8000);
  await page.eval(`document.querySelector(".dp-confirm").click()`);
  await settle(900);

  const after2 = await page.eval(`(() => {
    const rows = [...document.querySelectorAll("#manage-modal-body .mn-act-card")];
    const row = rows.find(x => x.textContent.includes("Consequences"));
    const s = window.__app.state.students.find(x => x.id === "s1");
    const a = (s.targets[0].predefinedActivities || []).find(x => x.name === "Consequences");
    return {
      onScreen: row ? /Maintained on/.test(row.textContent) : null,
      inState: !!a?.maintained,
      text: row ? row.textContent.replace(/\\s+/g, " ").trim().slice(0, 80) : "",
    };
  })()`);
  r.ok("it is saved", after2.inState === true, JSON.stringify(after2));
  r.ok("and the row shows it without reopening", after2.onScreen === true,
    `the row still reads: ${after2.text}`);

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

r.done("Maintain repaints the row");
