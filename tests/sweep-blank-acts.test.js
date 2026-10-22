// The blank-row sweep, and the activity it used to eat.
//
// "Add sub-activity" turns the activity it is pressed on into a parent by
// setting noRemark. The sweep deleted any parent with no real sub-activity
// under it, so an activity that had been in the target for months was
// destroyed by one stray click followed by closing the window.
//
// A blank sub-activity under a parent that HAS a name is now given the name
// "[Unnamed Subactivity]" instead of being thrown away, so nothing is lost
// to a misclick. A parent with no name of its own is "+ Add Parent Activity
// with Sub-activities" pressed and abandoned outright, and that still goes.
//
//   deno run -A tests/sweep-blank-acts.test.js

const src = await Deno.readTextFile("app.js");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}

const UNNAMED = src.match(/const UNNAMED_SUB = "([^"]*)";/)[1];
const { sweepBlankActs } = new Function(
  `const UNNAMED_SUB = ${JSON.stringify(UNNAMED)};`
  + extract("isEmptyActItem") + "\n" + extract("sweepBlankActs")
  + "\nreturn { sweepBlankActs };")();

let failed = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(ok ? `  ok  ${what}` : `FAIL  ${what}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
  if (!ok) failed++;
};
const names = acts => acts.map(a => (a.title || a.name || "(blank)"));

console.log(`\nthe name used is ${UNNAMED}`);
check("it is the one Lewis asked for", UNNAMED, "[Unnamed Subactivity]");

console.log("\nan activity turned into a parent, then abandoned");
{
  // Exactly what "Add sub-activity" leaves behind: noRemark set on a row
  // that already had a name, and a blank sub under it. No _linkKey.
  const acts = [
    { id: "a1", name: "skrrrrr", order: 0, activeFrom: "2026-01-01" },
    { id: "a2", name: "what the sigma", order: 1, activeFrom: "2026-01-01", noRemark: true },
    { id: "a3", name: "", title: "", parentActivity: "what the sigma", order: 2 },
  ];
  const changed = sweepBlankActs(acts);
  check("nothing is deleted", names(acts),
    ["skrrrrr", "what the sigma", UNNAMED]);
  check("the activity is still there", acts.length, 3);
  check("and is still a parent", acts[1].noRemark, true);
  check("the caller is told something changed", changed, true);
}

console.log("\na parent somebody named, with its sub left blank");
{
  const acts = [
    { id: "p1", _linkKey: "pk1", title: "Behaviours", name: "", noRemark: true, order: 0 },
    { id: "s1", title: "", name: "", parentActivity: "pk1", order: 1 },
  ];
  sweepBlankActs(acts);
  check("both stay, the sub gets a name", names(acts), ["Behaviours", UNNAMED]);
}

console.log("\na parent with no name at all, never filled in");
{
  const acts = [
    { id: "a1", name: "skrrrrr", order: 0 },
    { id: "p1", _linkKey: "pk1", title: "", name: "", noRemark: true, order: 1 },
    { id: "s1", title: "", name: "", parentActivity: "pk1", order: 2 },
  ];
  sweepBlankActs(acts);
  check("that one still deserves to go", names(acts), ["skrrrrr"]);
}

console.log("\ntwo blank sub-activities under one named parent");
{
  const acts = [
    { id: "p1", name: "what the sigma", noRemark: true, order: 0 },
    { id: "s1", title: "", name: "", parentActivity: "what the sigma", order: 1 },
    { id: "s2", title: "", name: "", parentActivity: "what the sigma", order: 2 },
  ];
  sweepBlankActs(acts);
  // Two sub-activities sharing one name is its own family of bugs, so the
  // second is numbered.
  check("one is rescued, the spare is tidied", names(acts),
    ["what the sigma", UNNAMED]);
}

console.log("\na blank one beside a sub that is already called that");
{
  const acts = [
    { id: "p1", name: "what the sigma", noRemark: true, order: 0 },
    { id: "s1", title: UNNAMED, parentActivity: "what the sigma", order: 1 },
    { id: "s2", title: "", name: "", parentActivity: "what the sigma", order: 2 },
  ];
  sweepBlankActs(acts);
  // The existing one is a real sub-activity, so nothing is at risk and the
  // blank is tidied away.
  check("no second one is created", names(acts),
    ["what the sigma", UNNAMED]);
}

console.log("\na parent with a real sub-activity");
{
  const acts = [
    { id: "a2", name: "what the sigma", order: 0, noRemark: true },
    { id: "s1", name: "bruh lol", parentActivity: "what the sigma", order: 1 },
    { id: "s2", name: "", title: "", parentActivity: "what the sigma", order: 2 },
  ];
  const changed = sweepBlankActs(acts);
  // Nothing is at risk here, so the stray blank is tidied away as it always
  // was. Naming it would leave a row to delete by hand after every misclick.
  check("the blank one is tidied away, not named",
    names(acts), ["what the sigma", "bruh lol"]);
  check("and that counts as a change", changed, true);
}

console.log("\nnothing to do");
{
  const acts = [
    { id: "a1", name: "skrrrrr", order: 0 },
    { id: "a2", name: "what the sigma", order: 1, noRemark: true },
    { id: "s1", name: "bruh lol", parentActivity: "what the sigma", order: 2 },
  ];
  check("a tidy list is left alone", sweepBlankActs(acts), false);
  check("with everything still in it", names(acts),
    ["skrrrrr", "what the sigma", "bruh lol"]);
}

console.log("\na blank row that was never anything");
{
  const acts = [
    { id: "a1", name: "skrrrrr", order: 0 },
    { id: "a2", name: "", title: "", order: 1 },
  ];
  sweepBlankActs(acts);
  check("goes, as before", names(acts), ["skrrrrr"]);
}

console.log("\na blank sub whose parent is not in the list");
{
  const acts = [
    { id: "s1", title: "", name: "", parentActivity: "gone", order: 0 },
  ];
  sweepBlankActs(acts);
  check("nothing to keep it for", names(acts), []);
}

console.log(failed === 0 ? "\nAll good." : `\n${failed} failed.`);
Deno.exit(failed === 0 ? 0 : 1);
