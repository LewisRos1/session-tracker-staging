// Which session records belong to which activity.
//
// Rayhanah added an activity called "Antecedent" to Hayden Chan's Behaviour
// Chart, under a heading that already had one. When she tried to remove it
// again the app said it held data from 96 sessions and offered to delete it
// all. It would have: the count and the delete both matched records by the
// word "Antecedent", so a brand-new activity inherited another one's history.
//
// The real data, read off live with debugDuplicates, is used below: two
// Antecedents that are genuinely separate activities, 98 records against one
// and 9 against the other, plus 7 older records carrying no id at all.
//
//   deno run --allow-read tests/activity-identity.test.js

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
const names = ["remarkHasData", "rivalActivities", "recordIdsForActivity",
               "sessionHasActivityData"];
const fns = new Function(names.map(extract).join("\n") +
  `\nreturn { ${names.join(", ")} };`)();
const { remarkHasData, recordIdsForActivity, sessionHasActivityData } = fns;

let failed = 0;
const check = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log(`  ok  ${what}`);
  else { failed++; console.log(`FAIL  ${what}` + `\n        want ${w}\n        got  ${g}`); }
};

// The target as it really is: one heading per behaviour, the same three
// activity names under each.
const B1_ANT = { id: "amp83ynw4rfmn", title: "Antecedent", name: "" };
const B2_ANT = { id: "amsgyfyx3hnkh", title: "Antecedent", name: "", created: "2026-08-06" };
const NEW_ANT = { id: "anew00000000", title: "Antecedent", name: "", created: "2026-10-14" };
const ACTS = [
  { id: "hmr4rad8ai7ey", name: "Behaviour 1", isHeading: true },
  B1_ANT,
  { id: "hmsgyfgil5sef", name: "Behaviour 2", isHeading: true },
  B2_ANT, NEW_ANT,
];
const T = "Behaviour Chart";
const rec = (configId) => ({
  r1: { targetName: T, activityName: "Antecedent", ...(configId ? { configId } : {}) },
});

console.log("\na record that says which activity it belongs to");
check("the activity whose id it carries claims it",
  recordIdsForActivity(rec("amp83ynw4rfmn"), B1_ANT, ACTS, T, "2026-10-12"), ["r1"]);
check("the other Antecedent does not",
  recordIdsForActivity(rec("amp83ynw4rfmn"), B2_ANT, ACTS, T, "2026-10-12"), []);
// This is the bug. A new activity sharing the name was handed 96 sessions of
// another activity's data, with a Delete button under it.
check("and a newly added one claims nothing at all",
  recordIdsForActivity(rec("amp83ynw4rfmn"), NEW_ANT, ACTS, T, "2026-10-12"), []);
check("nor does it claim the second Antecedent's records",
  recordIdsForActivity(rec("amsgyfyx3hnkh"), NEW_ANT, ACTS, T, "2026-10-12"), []);

console.log("\nan older record with no id on it");
// Seven of Hayden's records predate ids, from June 2026. Behaviour 2's
// activities were created that August, so those records can only be the
// first Antecedent's.
check("the only activity that existed then claims it",
  recordIdsForActivity(rec(null), B1_ANT, ACTS, T, "2026-06-09"), ["r1"]);
check("one created afterwards does not",
  recordIdsForActivity(rec(null), B2_ANT, ACTS, T, "2026-06-09"), []);
check("and neither does one created yesterday",
  recordIdsForActivity(rec(null), NEW_ANT, ACTS, T, "2026-06-09"), []);
// Once both existed, a nameless record could be either. Left alone rather
// than handed to whichever was asked about first.
check("after both existed, nobody claims it",
  [recordIdsForActivity(rec(null), B1_ANT, ACTS, T, "2026-10-01"),
   recordIdsForActivity(rec(null), B2_ANT, ACTS, T, "2026-10-01")], [[], []]);

console.log("\nwhat counts as data worth warning about");
check("typed text", remarkHasData({ text: "<p>He sat down</p>" }), true);
check("an empty tag is not text", remarkHasData({ text: "<p></p>" }), false);
check("a trial score", remarkHasData({ trials: [null, 3] }), true);
check("a skipped trial is not a score", remarkHasData({ trials: [null, -1] }), false);
// These two were counted in the warning but left out of the trash copy, so a
// remark holding only one of them was deleted with no way back.
check("a select score", remarkHasData({ optionScore: 0 }), true);
check("a sentence starter note", remarkHasData({ masteryNote: "settled" }), true);
check("nothing at all", remarkHasData({}), false);

console.log("\na whole session");
const session = (configId, remark) => ({
  date: "2026-10-12",
  activities: { a1: { targetName: T, activityName: "Antecedent", ...(configId ? { configId } : {}) } },
  remarks: { m1: { activityId: "a1", ...remark } },
});
check("counted for the activity that owns the record",
  sessionHasActivityData(session("amp83ynw4rfmn", { text: "No Event" }), B1_ANT, ACTS, T), true);
check("not for the new activity beside it",
  sessionHasActivityData(session("amp83ynw4rfmn", { text: "No Event" }), NEW_ANT, ACTS, T), false);
check("an empty remark is not data",
  sessionHasActivityData(session("amp83ynw4rfmn", { text: "" }), B1_ANT, ACTS, T), false);

console.log(failed ? `\n${failed} failed.\n` : `\nAll good.\n`);
Deno.exit(failed ? 1 : 0);
