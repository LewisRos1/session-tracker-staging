// Runs every test, building the browser harness first.
//
//   deno run -A tests/run-all.js
//
// Exits non-zero if anything fails, so it can gate a deploy.

const HARNESS = ".harness";   // throwaway; rebuilt on every run

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

results.push(await run("the app starts in a real browser",
  ["run", "-A", "tests/browser/smoke.test.js", HARNESS]));

results.push(await run("Details: saving, in a real browser",
  ["run", "-A", "tests/browser/details-saving.test.js", HARNESS]));

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
