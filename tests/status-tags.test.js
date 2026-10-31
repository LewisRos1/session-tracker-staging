// The status tags after an activity's name in the Excel and Word exports.
//
// An activity can be two things at once. "Maintained" says the skill is
// being checked over time; "Mastered" says it is finished. Mastering one
// that had been maintained for a year used to drop the maintained tag, so
// a column of "Maintain" remarks sat under a name that gave no hint why.
//
// Lewis asked for both, side by side, each with its own date. The order is
// maintained first, the way the website's badges already read.
//
//   deno run -A tests/status-tags.test.js

const src = await Deno.readTextFile("export.js");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in export.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}

const { statusTags } = new Function(
  extract("fmtDate") + "\n" + extract("statusTags") + "\nreturn { statusTags };")();

let failed = 0;
const check = (what, got, want) => {
  const ok = got === want;
  console.log(ok ? `  ok  ${what}`
    : `FAIL  ${what}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
  if (!ok) failed++;
};

console.log("\nthe one Lewis asked for");
check("maintained then mastered, both dated",
  statusTags({ maintained: true, maintainedAt: "2026-06-01", masteredOn: "2026-10-02" }),
  " (Maintained on 1 Jun 2026) (Mastered on 2 Oct 2026)");
check("maintained then discontinued",
  statusTags({ maintained: true, maintainedAt: "2026-06-01", discontinuedOn: "2026-10-02" }),
  " (Maintained on 1 Jun 2026) (Discontinued on 2 Oct 2026)");

console.log("\none tag on its own");
check("maintained and still running",
  statusTags({ maintained: true, maintainedAt: "2026-06-01" }),
  " (Maintained on 1 Jun 2026)");
check("mastered, never maintained",
  statusTags({ masteredOn: "2026-10-02" }), " (Mastered on 2 Oct 2026)");
check("discontinued, never maintained",
  statusTags({ discontinuedOn: "2026-10-02" }), " (Discontinued on 2 Oct 2026)");

console.log("\nnothing to say");
check("a plain activity", statusTags({ title: "Rolling a ball" }), "");
check("no activity at all", statusTags(null), "");

console.log("\nboth finish dates set");
// Switching one to the other leaves the old date behind on some paths, and
// an activity cannot be mastered AND discontinued. Discontinued wins, the
// way the Excel section split already decides it.
check("discontinued wins, and is said once",
  statusTags({ masteredOn: "2026-09-01", discontinuedOn: "2026-10-02" }),
  " (Discontinued on 2 Oct 2026)");

console.log("\nmaintained before the date was stored");
// Records from before maintainedAt existed fall back to the same date the
// rest of export.js uses for them, rather than printing "undefined".
check("falls back rather than printing nothing",
  statusTags({ maintained: true, masteredOn: "2026-10-02" }),
  " (Maintained on 21 Aug 2026) (Mastered on 2 Oct 2026)");

console.log(failed === 0 ? "\nAll good." : `\n${failed} failed.`);
Deno.exit(failed === 0 ? 0 : 1);
