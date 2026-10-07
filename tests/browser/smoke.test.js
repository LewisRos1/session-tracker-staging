// Does the real app start in a real browser with Firebase stubbed out?
//
// Everything else here depends on this, so it is checked on its own and
// reports what the page logged when it does not.

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: smoke.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

try {
  await page.fixture({
    today: "2026-10-08",
    // Arrays of documents, the way loadStudentsConfig and loadGroups return them.
    students: [
      {
        id: "amy", name: "Amy", order: 1,
        targets: [
          { name: "FEDC 1", scale: 3, predefinedActivities: [
            { id: "a1", name: "Greeting", type: "trials", details: "" },
            { id: "a2", name: "Turn taking", type: "trials", details: "" },
          ] },
        ],
      },
    ],
    groups: [],
    sessions: [],
  });

  await page.load();

  r.section("the app starts");

  r.ok("page loaded", await page.eval(`document.readyState === "complete"`));

  const title = await page.eval(`document.title`);
  r.ok("title is the app's", /zora|session|tracker/i.test(title || ""), `got ${JSON.stringify(title)}`);

  const bodyLen = await page.eval(`document.body.innerHTML.length`);
  r.ok("something rendered", bodyLen > 500, `body is ${bodyLen} characters`);

  const fatal = page.pageErrors.filter(e =>
    !/ServiceWorker|Failed to register|manifest|favicon/i.test(e));
  r.ok("no uncaught errors", fatal.length === 0, fatal.slice(0, 3).join("\n        "));

  const errors = page.consoleLines.filter(l => l.level === "error" &&
    !/ServiceWorker|manifest|favicon|404/i.test(l.text));
  r.ok("no console errors", errors.length === 0,
    errors.slice(0, 4).map(e => e.text).join("\n        "));

  // What the app actually put on screen, to work out the selectors from.
  const screens = await page.eval(`
    [...document.querySelectorAll("[id^='screen-'], .screen")]
      .map(e => e.id + (e.classList.contains("hidden") ? " (hidden)" : " VISIBLE"))`);
  console.log("\n  screens found:");
  for (const s of screens.slice(0, 20)) console.log(`    ${s}`);

  const calls = await page.eval(`(window.__harness?.calls || []).map(c => c.name)`);
  console.log(`\n  firebase calls made on startup: ${[...new Set(calls)].join(", ") || "(none)"}`);

  if (Deno.args.includes("--shot")) {
    console.log(`\n  screenshot: ${await page.screenshot("harness-smoke.png")}`);
  }
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
