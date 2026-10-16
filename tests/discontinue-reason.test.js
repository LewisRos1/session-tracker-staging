// Why something was discontinued.
//
// Lewis: a parent seeing a graph stop in April asks what happened, so the
// reason has to be written down, shown under the target, and given to the
// report writer. Optional, because plenty were stopped long before there
// was a box to type one in.
//
//   deno run --allow-read tests/discontinue-reason.test.js

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
const names = ["setDiscontinuedReason", "discontinuedFactLine"];
const fns = new Function(
  "const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');"
  + "const fmtPeriodDate = (d) => ({ '2026-04-18': '18 Apr 2026' })[d] || d;"
  + names.map(extract).join("\n")
  + `\nreturn { ${names.join(", ")} };`)();
const { setDiscontinuedReason, discontinuedFactLine } = fns;

let failed = 0;
const check = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${what}`);
  else { failed++; console.log(`FAIL  ${what}` + `\n        want ${w}\n        got  ${g}`); }
};

console.log("\nwriting it down");
{
  const t = {};
  setDiscontinuedReason(t, "  met in daily routine  ");
  check("trimmed, and kept", t.discontinuedReason, "met in daily routine");
  // An empty box means none, not an empty line printed in a report.
  setDiscontinuedReason(t, "   ");
  check("an empty box takes it off again", "discontinuedReason" in t, false);
  setDiscontinuedReason(t, null);
  check("and so does nothing at all", "discontinuedReason" in t, false);
}

console.log("\ntelling the report writer");
check("nothing is said about something still running", discontinuedFactLine({}, "target"), "");
{
  const withWhy = discontinuedFactLine(
    { discontinuedOn: "2026-04-18", discontinuedReason: "met in daily routine" }, "target");
  check("it says when", withWhy.includes("18 Apr 2026"), true);
  check("and why", withWhy.includes("met in daily routine"), true);
  // Or the model fills the silence with something that sounds like failure.
  check("and that it is not a failure", /never a failure/i.test(withWhy), true);
  // A rule that says "mention this" gets followed every time, and the
  // reports would stop sounding like the ones already signed off.
  check("and that most reports should not raise it",
    /should not mention this at all/i.test(withWhy), true);
  check("it is marked as background",
    /BACKGROUND, not a topic/.test(withWhy), true);
}
{
  const noWhy = discontinuedFactLine({ discontinuedOn: "2026-04-18" }, "target");
  check("with no reason recorded, it says so", noWhy.includes("no reason recorded"), true);
  check("rather than leaving one to be invented", noWhy.includes("Reason given"), false);
}

console.log(failed ? `\n${failed} failed.\n` : `\nAll good.\n`);
Deno.exit(failed ? 1 : 0);
