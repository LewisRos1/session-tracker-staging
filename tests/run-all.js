// Runs every test, building the browser harness first.
//
//   deno run -A tests/run-all.js
//
// Exits non-zero if anything fails, so it can gate a deploy.

// Throwaway, rebuilt on every run, and named after this process.
//
// Two runs at once used to share one folder: the second rebuilt it while
// the first was reading it, and eighteen suites failed with "harness-meta
// not found". That looked exactly like the app being broken, twice, and
// cost more time than the tests it was running.
const HARNESS = `.harness-${Deno.pid}`;

const run = async (label, cmd) => {
  console.log(`\n${"=".repeat(60)}\n${label}\n${"=".repeat(60)}`);
  const p = new Deno.Command(Deno.execPath(), { args: cmd, stdout: "inherit", stderr: "inherit" }).spawn();
  const { code } = await p.status;
  return { label, code };
};

const results = [];

// The harness is a copy of the app with Firebase stubbed out. It has to be
// rebuilt each time or the browser tests would run against an older app.js.
const build = await run("building the browser harness",
  ["run", "-A", "tests/browser/build-harness.js", HARNESS]);
if (build.code !== 0) {
  console.error("\nthe harness did not build, so the browser tests cannot run");
  Deno.exit(1);
}

results.push(await run("Details: markers to HTML and back (no browser)",
  ["run", "--allow-read", "tests/details-markers.test.js"]));

results.push(await run("Details: bullet points (no browser)",
  ["run", "--allow-read", "tests/details-bullets.test.js"]));

results.push(await run("Everyone signs in again each Monday (no browser)",
  ["run", "--allow-read", "tests/week-signout.test.js"]));

results.push(await run("List of Corrections: three states, Ms. Daisy approves (no browser)",
  ["run", "--allow-read", "tests/corrections-status.test.js"]));

results.push(await run("Why something was discontinued (no browser)",
  ["run", "--allow-read", "tests/discontinue-reason.test.js"]));

results.push(await run("Which targets a report for a period covers (no browser)",
  ["run", "--allow-read", "tests/report-period-targets.test.js"]));

results.push(await run("Which session records belong to which activity (no browser)",
  ["run", "--allow-read", "tests/activity-identity.test.js"]));

results.push(await run("AI Translator: swapping text inside a .docx (no browser)",
  ["run", "--allow-read", "tests/docx-text-swap.test.js"]));

results.push(await run("AI Translator: telling Word the text is Chinese (no browser)",
  ["run", "--allow-read", "tests/docx-chinese-font.test.js"]));

results.push(await run("the app starts in a real browser",
  ["run", "-A", "tests/browser/smoke.test.js", HARNESS]));

results.push(await run("Details: saving, in a real browser",
  ["run", "-A", "tests/browser/details-saving.test.js", HARNESS]));

results.push(await run("Details toolbar: bold, underline and bullets, in a real browser",
  ["run", "-A", "tests/browser/details-toolbar.test.js", HARNESS]));

results.push(await run("Group targets: editing and saving, in a real browser",
  ["run", "-A", "tests/browser/group-target-edit.test.js", HARNESS]));

results.push(await run("Parent activities and their sub-activities, in a real browser",
  ["run", "-A", "tests/browser/parent-sub-lifecycle.test.js", HARNESS]));

results.push(await run("A window must not flag its own save",
  ["run", "-A", "tests/browser/own-save-echo.test.js", HARNESS]));

results.push(await run("A window must not ask about an earlier window",
  ["run", "-A", "tests/browser/stale-flag-carryover.test.js", HARNESS]));

results.push(await run("The Undo button is actually visible",
  ["run", "-A", "tests/browser/sticky-note-undo.test.js", HARNESS]));

results.push(await run("AI Translator: the screen and what it tells the model",
  ["run", "-A", "tests/browser/ai-translator.test.js", HARNESS]));

results.push(await run("The Student Database at half a screen",
  ["run", "-A", "tests/browser/student-database-layout.test.js", HARNESS]));

results.push(await run("The kebab menu on a short screen",
  ["run", "-A", "tests/browser/kebab-menu-position.test.js", HARNESS]));

results.push(await run("The daily session note's footer",
  ["run", "-A", "tests/browser/session-note-footer.test.js", HARNESS]));

results.push(await run("Two notices in the corner, stacked",
  ["run", "-A", "tests/browser/notice-stack.test.js", HARNESS]));

results.push(await run("The monthly report's chart can be turned into Chinese",
  ["run", "-A", "tests/browser/monthly-chart-translates.test.js", HARNESS]));

results.push(await run("Redrawing a chart in Chinese",
  ["run", "-A", "tests/browser/chart-redraw.test.js", HARNESS]));

results.push(await run("What an assistant may and may not touch",
  ["run", "-A", "tests/browser/assistant-readonly.test.js", HARNESS]));

results.push(await run("One person in a target at a time (the Edit Target lock)",
  ["run", "-A", "tests/browser/edit-target-lock.test.js", HARNESS]));

results.push(await run("Two people in two browsers at once",
  ["run", "-A", "tests/browser/two-tabs-approval.test.js", HARNESS]));

results.push(await run("An approved activity keeps the date it was proposed for",
  ["run", "-A", "tests/browser/approval-keeps-date.test.js", HARNESS]));

results.push(await run("Deleting an activity with its panel open",
  ["run", "-A", "tests/browser/delete-after-refresh.test.js", HARNESS]));

results.push(await run("Maintain repaints the row",
  ["run", "-A", "tests/browser/maintain-repaints.test.js", HARNESS]));

results.push(await run("Moving an activity under a parent",
  ["run", "-A", "tests/browser/move-under-parent.test.js", HARNESS]));

results.push(await run("Two activities with the same name, in a real browser",
  ["run", "-A", "tests/browser/same-name-activities.test.js", HARNESS]));

results.push(await run("Start Session screens: what they print",
  ["run", "-A", "tests/browser/session-screen-display.test.js", HARNESS]));

console.log(`\n${"=".repeat(60)}`);
let failed = 0;
for (const res of results) {
  if (res.code !== 0) failed++;
  console.log(`${res.code === 0 ? "  ok  " : "FAIL  "}${res.label}`);
}
console.log("=".repeat(60));

await Deno.remove(HARNESS, { recursive: true }).catch(() => {});

if (failed) {
  console.log(`\n${failed} suite${failed === 1 ? "" : "s"} failed. Do not deploy.\n`);
  Deno.exit(1);
}
console.log("\nEverything passed.\n");
