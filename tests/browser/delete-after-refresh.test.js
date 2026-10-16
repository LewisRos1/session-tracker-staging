// Pressing Delete once, and the activity still being there.
//
// Lewis and the boss have both hit this: type the word, press Delete,
// nothing happens, press it again and it goes. No error, nothing in the
// console.
//
// The confirm handler looks the activity up by object identity in a list
// captured when the bin was first pressed. Between that press and the
// confirmation, the app waits for every session to load, and a save coming
// back from Firestore can replace that list with fresh objects. indexOf then
// returns -1, nothing is removed, and the unchanged list is saved over the
// top. This replaces the list the same way, on purpose.
//
//   deno run -A tests/browser/delete-after-refresh.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: delete-after-refresh.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

try {
  await page.fixture({
    today: "2026-10-16", authUser: "daisy",
    students: [{
      id: "amy", name: "Amy", order: 1,
      targets: [{
        id: "t1", name: "FEDC 1", scale: 3,
        predefinedActivities: [
          { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
          { id: "a2", title: "Turn taking", name: "", order: 1, createdOn: "2026-01-01" },
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
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 2`, "the activity list");
  await settle(500);

  r.section("the list is replaced while the confirmation box is open");

  // Open the kebab on the second activity, then its Delete Activity.
  await page.eval(`(() => {
    const btns = [...document.querySelectorAll(".mn-kebab-btn")];
    const btn = btns[btns.length - 1];
    if (!btn) throw new Error("no kebab button");
    btn.click();
  })()`);
  await settle(400);
  await page.eval(`(() => {
    const opt = [...document.querySelectorAll('.mn-km-opt[data-action="delete"]')]
      .filter(b => b.offsetParent !== null)[0];
    if (!opt) throw new Error("no Delete Activity in the menu");
    opt.click();
  })()`);
  await page.until(`document.querySelector("#del-type-input")`, "the confirmation box");
  await settle(400);

  // What a save coming back from Firestore does: the same activities, as new
  // objects. Nothing a person did, and nothing they can see.
  const swapped = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    const t = s.targets[0];
    t.predefinedActivities = JSON.parse(JSON.stringify(t.predefinedActivities));
    return t.predefinedActivities.length;
  })()`);
  r.check("the target still has both activities", swapped, 2);

  const word = await page.eval(`document.querySelector("#del-type-input")?.placeholder || ""`);
  await page.eval(`(() => {
    const inp = document.querySelector("#del-type-input");
    inp.focus(); inp.value = "";
  })()`);
  await page.type(word);
  await settle(250);
  await page.click("#del-type-ok");
  await settle(1200);

  const after = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    return (s.targets[0].predefinedActivities || []).map(a => a.title);
  })()`);

  r.check("the activity is gone after one press", after, ["Greeting"]);

  // ── with the activity's own panel open ──────────────────────────────
  //
  // The sequence Lewis described: he had just made the activity, which opens
  // its panel to be named, and then deleted it. A panel holds a snapshot of
  // the whole list so Discard Changes can put it back, and saveTarget refuses
  // to write while one is open.
  r.section("deleting while the activity's panel is open");

  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 1`, "the list again");
  await settle(500);

  const opened = await page.eval(`(() => {
    const card = [...document.querySelectorAll(".mn-act-card")].pop();
    if (!card) return "no card";
    const t = card.querySelector(".mn-act-compact-title") || card;
    t.click();
    return true;
  })()`);
  await settle(600);
  r.ok("a card was clicked into", opened === true, String(opened));
  r.ok("the panel is open",
    await page.eval(`!!document.querySelector("#mn-act-panel-overlay")`),
    "no panel opened, so this case proves nothing");

  await page.eval(`(() => {
    const btns = [...document.querySelectorAll(".mn-kebab-btn")].filter(b => b.offsetParent !== null);
    const btn = btns[btns.length - 1];
    if (!btn) throw new Error("no kebab button");
    btn.click();
  })()`);
  await settle(400);
  await page.eval(`(() => {
    const opt = [...document.querySelectorAll('.mn-km-opt[data-action="delete"]')]
      .filter(b => b.offsetParent !== null)[0];
    if (!opt) throw new Error("no Delete Activity in the menu");
    opt.click();
  })()`);
  await page.until(`document.querySelector("#del-type-input")`, "the confirmation box");
  await settle(400);

  const word2 = await page.eval(`document.querySelector("#del-type-input")?.placeholder || ""`);
  await page.eval(`(() => {
    const inp = document.querySelector("#del-type-input");
    inp.focus(); inp.value = "";
  })()`);
  await page.type(word2);
  await settle(250);
  await page.click("#del-type-ok");
  await settle(1400);

  const left = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    return (s.targets[0].predefinedActivities || []).map(a => a.title);
  })()`);
  r.check("it went on the first press, panel or no panel", left, []);

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
