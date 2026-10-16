// A target stopped part way through still belongs to the months it ran.
//
// Lewis: a target active from January to March and stopped in April has to
// be in the February report, in a January to June report, and in its charts.
// The sessions happened. Leaving it out tells a parent nothing was done, and
// showing a line that stops in April with no word of why invites the
// question anyway.
//
//   deno run --allow-read tests/report-period-targets.test.js

const src = await Deno.readTextFile("app.js");
function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in app.js`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}
const targetsCoveringPeriod = new Function(extract("targetsCoveringPeriod")
  + "; return targetsCoveringPeriod;")();

let failed = 0;
const check = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${what}`);
  else { failed++; console.log(`FAIL  ${what}` + `\n        want ${w}\n        got  ${g}`); }
};

const TARGETS = [
  { name: "Self-Regulation" },
  { name: "Handwriting", isStopped: true },
  { name: "Toilet Training", isArchived: true },
  { name: "Swimming", isArchived: true },
];
const names = (list) => list.map(t => t.name);

// February: Handwriting was still being worked on, Toilet Training was not.
const feb = [
  { date: "2026-02-03", activities: { a: { targetName: "Self-Regulation" },
                                      b: { targetName: "Handwriting" } } },
  { date: "2026-02-10", activities: { c: { targetName: "Handwriting" } } },
];

console.log("\na month when the stopped target was still running");
check("the live target is in", names(targetsCoveringPeriod(TARGETS, feb)).includes("Self-Regulation"), true);
check("and so is the one stopped later",
  names(targetsCoveringPeriod(TARGETS, feb)).includes("Handwriting"), true);
check("one with nothing that month stays out",
  names(targetsCoveringPeriod(TARGETS, feb)).includes("Toilet Training"), false);

console.log("\na month after it was stopped");
const jun = [
  { date: "2026-06-02", activities: { a: { targetName: "Self-Regulation" } } },
];
check("only what was actually worked on, plus what is still live",
  names(targetsCoveringPeriod(TARGETS, jun)), ["Self-Regulation"]);

console.log("\na target named only in the session snapshot");
// Some sessions record the targets they covered even where no activity
// under them was filled in.
const snap = [
  { date: "2026-03-01", activities: {}, targetsSnapshot: [{ name: "Swimming" }] },
];
check("that counts as having run", names(targetsCoveringPeriod(TARGETS, snap)).includes("Swimming"), true);

console.log("\nnothing to go on");
check("no sessions leaves the live targets", names(targetsCoveringPeriod(TARGETS, [])), ["Self-Regulation"]);
check("no targets is not an error", targetsCoveringPeriod(null, feb), []);

console.log(failed ? `\n${failed} failed.\n` : `\nAll good.\n`);
Deno.exit(failed ? 1 : 0);
