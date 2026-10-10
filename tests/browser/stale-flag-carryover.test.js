// A window must not ask about something that happened in an earlier window.
//
// Lewis got this over an activity he had just created, as himself:
//
//   Ms. Daisy has approved the previous version.
//   Do you want to resend Approval with the new changes?
//
// Nothing had been sent to Ms. Daisy. Nothing had been approved. The row did
// not exist until a second earlier.
//
// Three faults, all in this file:
//
//  1. _mnEditTargetStale and _mnStaleFrom outlive the window that set them.
//     Somebody really does change a target while you have it open -- that is
//     what the flag is for -- and then the flag sits there through the close
//     and fires in the NEXT window, over a different target entirely.
//     _mnStaleFrom was worse: declining would have drawn the OTHER student's
//     target into the window in front of you.
//  2. _mnPanelSaveWanted was not cleared when a window opened either, so a
//     window left by the back arrow told the next one it had unsaved work.
//  3. The message named a person and an approval it knew nothing about. All
//     it ever knew was that the record had changed.
//
//   deno run -A tests/browser/stale-flag-carryover.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: stale-flag-carryover.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 700) => new Promise(res => setTimeout(res, ms));
const store = (path, init) =>
  fetch(`http://127.0.0.1:${page.site.port}/__store/${path}`, init).then(x => x.json());

const act = (id, title, order) =>
  ({ id, title, name: "", order, createdOn: "2026-01-01", activeFrom: "2026-01-01" });

await page.fixture({
  today: "2026-10-10", authUser: "rayhanah", sharedStore: true,
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [
      { id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: [act("a1", "Greeting", 0)] },
      { id: "t2", name: "FEDC 2", scale: 3, predefinedActivities: [act("b1", "Waiting", 0)] },
    ],
  }],
  groups: [], sessions: [],
});

try {
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`window.__asked = [];
    window.confirm = m => { window.__asked.push(m); return false; };
    window.alert = () => {};`);

  const openTarget = async (which) => {
    await page.eval(`(() => {
      const s = window.__app.state.students.find(x => x.id === "amy");
      window.__app.openManageModal(s, s.targets[${which}]);
    })()`);
    await page.until(`document.querySelectorAll(".mn-act-card").length >= 1`, "the activity list");
    await settle();
  };

  // ── 1. somebody else really changes the first target ──────────────────
  r.section("somebody else changes the target you have open");

  await openTarget(0);
  await page.click("#btn-mn-add-act");
  await page.until(`document.querySelector("#mn-act-panel-overlay")`, "the activity panel");
  await settle();

  // From outside the browser, as another machine would. A panel is open, so
  // the window cannot refresh itself and flags itself stale instead -- which
  // is correct, and is the whole point of the flag.
  const amy = (await store("students")).docs.find(d => d.id === "amy");
  amy.targets[0].predefinedActivities[0].title = "Greeting (changed by Ms. Daisy)";
  amy.lastWriteBy = "daisy@example.com";
  amy.lastWriteTab = "ms-daisys-machine";
  await store("students/amy", { method: "POST", body: JSON.stringify(amy) });
  await settle(1400);

  const sawIt = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    return (s.targets[0].predefinedActivities || []).some(a => /changed by Ms. Daisy/.test(a.title || ""));
  })()`);
  r.ok("the window took the other change on board", sawIt,
    "the listener never delivered it, so the rest of this test proves nothing");

  // ── 2. leave by the back arrow, not by Done ───────────────────────────
  // Done asks about the flag and clears it. The back arrow never did, which
  // is how the flag reached the next window.
  r.section("leave by the back arrow and open a different target");

  await page.eval(`window.__app.showHome()`);
  await settle();
  await page.eval(`window.__asked = []`);          // anything asked so far was fair

  await openTarget(1);

  // ── 3. a brand new row in the SECOND target ───────────────────────────
  r.section("add a brand new activity and discard it");

  await page.click("#btn-mn-add-act");
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-act-title-input")`, "the panel");
  await settle();
  await page.eval(`(() => {
    const el = document.querySelector("#mn-act-panel-overlay .mn-act-title-input");
    el.focus(); el.setSelectionRange((el.value || "").length, (el.value || "").length);
  })()`);
  await page.type("hhhhhhhhhhhhhhhh");
  await settle(500);
  await page.click("#mn-act-panel-overlay .mn-act-panel-discard");
  await settle(1600);

  const asked = await page.eval(`window.__asked || []`);
  const bogus = asked.filter(m => /resend Approval|changed this target|Save your changes anyway/i.test(m));
  r.check("nothing asked about somebody else's change", bogus, []);

  // And Done, right after, must not ask either.
  await page.eval(`window.__asked = []`);
  await page.eval(`window.__app.closeManageModal()`);
  await settle(1200);
  const askedOnClose = await page.eval(`(window.__asked || [])
    .filter(m => /resend Approval|changed this target|Save your changes anyway/i.test(m))`);
  r.check("nor on the way out", askedOnClose, []);

  // ── 4. the message itself ─────────────────────────────────────────────
  r.section("what the message says when it is right to show it");
  const src = await fetch(`http://127.0.0.1:${page.site.port}/app.js`).then(x => x.text());
  r.ok("it no longer claims Ms. Daisy approved anything",
    !src.includes("Ms. Daisy has approved the previous version"),
    "the old wording is still in app.js");
  r.ok("it says what actually happened",
    src.includes("Somebody else changed this target while you had it open"),
    "the replacement wording is missing");

  // ── 5. and a window still must not flag its own save ──────────────────
  r.section("a window still must not flag its own save");
  r.ok("writes carry the tab that made them", src.includes("WRITE_TAB_ID"),
    "the write stamp is gone from app.js");
  const stamped = (await store("students")).docs.find(d => d.id === "amy");
  r.ok("and the saved document carries one", !!stamped?.lastWriteTab,
    "the document in the store has no lastWriteTab");

  // ── 5b. Lewis's own hypothesis: "maybe the somebody else is Rayhanah" ─
  // It was. A reload, a second tab and the local cache all produce a copy
  // carrying a tab id that is not this page load's, and every one of those
  // read as a stranger. Her own work must never be somebody else's, however
  // it reaches her.
  r.section("her own change, arriving as if from another machine");

  await page.eval(`window.__asked = []`);
  await openTarget(0);
  await page.click("#btn-mn-add-act");
  await page.until(`document.querySelector("#mn-act-panel-overlay")`, "the panel");
  await settle(900);

  const hers = (await store("students")).docs.find(d => d.id === "amy");
  hers.targets[0].predefinedActivities[0].title = "Greeting (saved by Rayhanah earlier)";
  hers.lastWriteTab = "an-earlier-page-load";       // not this one
  hers.lastWriteBy  = "rayhanah@session-tracker.app";
  await store("students/amy", { method: "POST", body: JSON.stringify(hers) });
  await settle(1600);

  await page.eval(`window.__app.closeManageModal()`);
  await settle(1400);
  r.check("nothing asked about her own work", await page.eval(`(window.__asked || [])
    .filter(m => /changed this target|Save your changes anyway/i.test(m))`), []);

  // ── 6. and the warning must still work when it is real ───────────────
  // Four separate guards were added to stop it mis-firing. If one of them is
  // too broad the warning never appears at all, and two people quietly
  // overwrite each other again -- which is what it is there to prevent.
  r.section("the warning still appears when somebody else really did change it");

  await page.eval(`window.__asked = []`);
  await openTarget(0);
  await page.click("#btn-mn-add-act");
  await page.until(`document.querySelector("#mn-act-panel-overlay")`, "the panel again");
  await settle(900);

  const amy2 = (await store("students")).docs.find(d => d.id === "amy");
  amy2.targets[0].predefinedActivities[0].title = "Greeting (changed again)";
  amy2.lastWriteTab = "some-other-machine";
  // And by a different PERSON. Rayhanah's own writes are never somebody else,
  // however they reach her, which is the whole point of the guard.
  amy2.lastWriteBy = "daisy@example.com";
  await store("students/amy", { method: "POST", body: JSON.stringify(amy2) });
  await settle(1600);

  await page.eval(`window.__app.closeManageModal()`);
  await settle(1400);
  const warned = await page.eval(`(window.__asked || [])
    .filter(m => /changed this target|Save your changes anyway/i.test(m))`);
  r.ok("it warned", warned.length === 1,
    `expected one warning, got ${JSON.stringify(warned)}`);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 4).map(n => n.text.slice(0, 160)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("stale-carryover-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
