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
const names = ["setDiscontinuedReason", "discontinuedReasonHtml", "discontinuedFactLine"];
const fns = new Function(
  "const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');"
  + "const fmtPeriodDate = (d) => ({ '2026-04-18': '18 Apr 2026' })[d] || d;"
  + names.map(extract).join("\n")
  + `\nreturn { ${names.join(", ")} };`)();
const { setDiscontinuedReason, discontinuedReasonHtml, discontinuedFactLine } = fns;

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

console.log("\nshowing it under the item");
check("nothing to show when none was given", discontinuedReasonHtml({}), "");
check("nor for an empty one", discontinuedReasonHtml({ discontinuedReason: "  " }), "");
{
  const html = discontinuedReasonHtml({ discontinuedReason: "moved into another target" });
  check("the text is there", html.includes("moved into another target"), true);
  check("and it says what it is", html.includes("Why"), true);
}
// Typed by a person, so it cannot be trusted as markup.
check("a reason cannot smuggle in markup",
  discontinuedReasonHtml({ discontinuedReason: "<img src=x onerror=alert(1)>" }).includes("<img"), false);

console.log("\ntelling the report writer");
check("nothing is said about something still running", discontinuedFactLine({}, "target"), "");
{
  const withWhy = discontinuedFactLine(
    { discontinuedOn: "2026-04-18", discontinuedReason: "met in daily routine" }, "target");
  check("it says when", withWhy.includes("18 Apr 2026"), true);
  check("and why", withWhy.includes("met in daily routine"), true);
  // Or the model fills the silence with something that sounds like failure.
  check("and that it is not a failure", /not.*failure|not a failure/i.test(withWhy), true);
}
{
  const noWhy = discontinuedFactLine({ discontinuedOn: "2026-04-18" }, "target");
  check("with no reason recorded, it says so", noWhy.includes("No reason was recorded"), true);
  check("rather than leaving one to be invented", noWhy.includes("Reason given"), false);
}

console.log(failed ? `\n${failed} failed.\n` : `\nAll good.\n`);
Deno.exit(failed ? 1 : 0);
