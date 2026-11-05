// An activity with nothing recorded this month says which kind of nothing.
//
// The monthly report sends a bullet for every activity that appeared on a
// session screen, whether or not anybody wrote in it:
//
//   • Pointing to colours
//     Monthly: Aug no data, Sep no data, Oct no data, Nov no data
//
// A named skill with four months of "no data" beside it is exactly the
// shape that invites "we have not yet seen him do this" into a parent's
// report. The prompt said to ignore such an activity, but only in a
// sentence tacked onto the In Progress note, while the strongly worded
// rule ("never say has not yet been observed") was written for activities
// that are not in the data at all.
//
// Two situations hide behind an empty month, and counting that month
// cannot tell them apart:
//
//   never worked on          -> not started yet
//   worked on before, not now -> started, not covered this period
//
// Counting every session the student has had separates them. The
// half-year and assessment reports need none of this: neither emits a
// line at all for an activity with no data, which is stronger than any
// label.
//
//   deno run --allow-read tests/empty-activity-tags.test.js

const src = await Deno.readTextFile("app.js");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}

const activityEverHadData = new Function(
  extract("activityEverHadData") + "; return activityEverHadData;")();

let failed = 0;
const check = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}`);
  if (!ok) console.log(`        want ${w}\n        got  ${g}`);
};

const T = "Toilet Training";
/** A session holding one activity row, with whatever remark is given. */
const sess = (remark, { name = "Attempt 1", target = T, actId = "r1" } = {}) => ({
  date: "2026-09-01",
  activities: { [actId]: { id: actId, activityName: name, targetName: target } },
  remarks: remark ? { m1: { activityId: actId, ...remark } } : {},
});

console.log("\nwhat counts as having been worked on");
check("a typed remark", activityEverHadData([sess({ text: "did well" })], T, "Attempt 1"), true);
check("a mastery note",  activityEverHadData([sess({ masteryNote: "Maintain" })], T, "Attempt 1"), true);
check("trials",          activityEverHadData([sess({ trials: [2, 3] })], T, "Attempt 1"), true);
check("a picked option", activityEverHadData([sess({ optionScore: 0 })], T, "Attempt 1"), true);
check("a tickbox",       activityEverHadData([sess({ selectedOptions: ["a"] })], T, "Attempt 1"), true);

console.log("\nwhat does not");
check("no remark at all",   activityEverHadData([sess(null)], T, "Attempt 1"), false);
check("an empty remark",    activityEverHadData([sess({ text: "" })], T, "Attempt 1"), false);
check("empty HTML",         activityEverHadData([sess({ text: "<p></p>" })], T, "Attempt 1"), false);
check("only skipped trials", activityEverHadData([sess({ trials: [-1, -1] })], T, "Attempt 1"), false);
check("no sessions at all", activityEverHadData([], T, "Attempt 1"), false);

console.log("\nit has to be THIS activity, in THIS target");
check("another activity's remark does not count",
  activityEverHadData([sess({ text: "did well" }, { name: "Attempt 2" })], T, "Attempt 1"), false);
check("the same name under another target does not count",
  activityEverHadData([sess({ text: "did well" }, { target: "Behaviour" })], T, "Attempt 1"), false);
check("a remark pointing at a different row does not count",
  activityEverHadData([{ date: "2026-09-01",
    activities: { r1: { id: "r1", activityName: "Attempt 1", targetName: T } },
    remarks: { m1: { activityId: "SOMETHING-ELSE", text: "did well" } } }], T, "Attempt 1"), false);

console.log("\na renamed activity is still the same activity");
check("found through an alias",
  activityEverHadData([sess({ text: "did well" }, { name: "Old name" })], T, "Attempt 1", ["Old name"]), true);
check("found through the config id",
  activityEverHadData([{ date: "2026-09-01",
    activities: { r1: { id: "r1", activityName: "Totally different", targetName: T, configId: "cfg9" } },
    remarks: { m1: { activityId: "r1", text: "did well" } } }], T, "Attempt 1", [], "cfg9"), true);

console.log("\none session with data anywhere in the student's history is enough");
check("quiet month, busy history",
  activityEverHadData([sess(null), sess(null), sess({ text: "did well" })], T, "Attempt 1"), true);
check("quiet all the way back",
  activityEverHadData([sess(null), sess(null), sess(null)], T, "Attempt 1"), false);

console.log("\nthe two labels, and the rule that explains them");
check("never worked on",
  /const EMPTY_ACT_NEW  = "not started yet";/.test(src), true);
check("worked on before, not this period",
  /const EMPTY_ACT_IDLE = "started, not covered this period";/.test(src), true);
check("the monthly bullet picks between them on the whole history",
  /activityEverHadData\(allSessions, tName, actName, aliases, configId, _filterGroupSess\)\s*\r?\n\s*\? EMPTY_ACT_IDLE : EMPTY_ACT_NEW;/
    .test(src), true);
check("and only when the month is empty",
  /if \(!allRemarks\.length\) \{\s*\r?\n\s*_mEmptyTag =/.test(src), true);
check("it sits alongside the started/mastered label, not instead of it",
  /\[paKeyToStatusM\[actName\], _mEmptyTag\]\.filter\(Boolean\)\.join\(", "\)/.test(src), true);

// A label the model is not told to ignore is just a new phrase for it to
// write into a report.
check("the rules say neither label is a weakness",
  /NEITHER is a weakness, a difficulty, a decline or anything to write about/.test(src), true);
check("and name both of them",
  /"not started yet" means[\s\S]{0,200}"started, not covered this period" means/.test(src), true);
check("and forbid the sentence they would otherwise invite",
  /never write that something "has not yet been observed" or "remains untested"/.test(src), true);

console.log("\nthe other two reports drop an empty activity instead");
check("the half-year report omits it entirely",
  /if \(allRemarks\.length === 0\) \{\s*\r?\n\s*\/\/ Completely omit from prompt/.test(src), true);
check("and the assessment report writes no line for it",
  /if \(!said && !tr\.length\) return;/.test(src), true);

console.log(failed ? `\n${failed} failed.\n` : "\nAll good.\n");
Deno.exit(failed ? 1 : 0);
