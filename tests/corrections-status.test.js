// The List of Corrections: one box that says whose turn it is.
//
// It used to be Undone / Corrected / Still Wrong, settable by anyone. Lewis
// asked for Ms. Daisy to sign work off, and for the note to say who is
// holding each row. The two rules that matter:
//
//   1. Nobody signs off their own work. The person being corrected must not
//      be offered Approved.
//   2. "fixed" still means finished. Every phase in the workflow asks whether
//      a row is "fixed", and a session completed last month must not reopen
//      because the words on screen changed.
//
// The list is pulled straight out of app.js rather than copied.
//
//   deno run --allow-read tests/corrections-status.test.js

const src = await Deno.readTextFile("app.js");

const m = src.match(/const CORRECTION_STATUSES = (\[[\s\S]*?\n\]);/);
if (!m) { console.error("CORRECTION_STATUSES not found in app.js"); Deno.exit(2); }
const STATES = new Function(`return ${m[1]};`)();

let failed = 0;
const check = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        want ${w}\n        got  ${g}`}`);
};

const stored = STATES.map(s => s.value);
const pickable = who => STATES.filter(s => s.setBy === who).map(s => s.value);
const turnOf = v => (STATES.find(s => s.value === v) || {}).turn;

console.log("\nthe four states, and the values Firestore already holds");
check("every stored value is one already in use, plus the new middle one",
  stored.sort(), ["", "done", "fixed", "rejected"]);

console.log("\nnobody signs off their own work");
check("the person being corrected cannot pick Approved",
  pickable("them").includes("fixed"), false);
check("nor can they overrule Ms. Daisy with Still wrong",
  pickable("them").includes("rejected"), false);
check("they can say it needs fixing, or that they have fixed it",
  pickable("them").sort(), ["", "done"]);
check("Ms. Daisy approves or sends it back",
  pickable("daisy").sort(), ["fixed", "rejected"]);

console.log("\nwhose turn each state is");
check("nothing done yet -> the person being corrected", turnOf(""), "them");
check("sent back -> the person being corrected",       turnOf("rejected"), "them");
check("they say it is fixed -> Ms. Daisy",             turnOf("done"), "daisy");
check("approved -> nobody, it is finished",            turnOf("fixed"), null);

console.log("\na finished session must not reopen");
// Phase 3 and 4 ask this question, and a row written months ago says "fixed".
check("the finished state is still the one already stored as fixed",
  STATES.find(s => s.turn === null).value, "fixed");
check("the workflow still asks for exactly that value",
  /getCmtStatus\(c\) === "fixed"/.test(src), true);
check("and a change away from it still reopens the phases",
  /if \(next !== "fixed"\)/.test(src), true);

console.log("\nonly one state can be the finished one");
check("exactly one", STATES.filter(s => s.turn === null).length, 1);

console.log("\nLewis can sign off too, so he can unstick the team");
const signers = src.match(/canSignOffCorrections = \(\) => (\[[^\]]*\])/)?.[1];
check("Ms. Daisy and Lewis", new Function(`return ${signers};`)().sort(), ["daisy", "lewis"]);
check("not Nigel or Rayhanah",
  new Function(`return ${signers};`)().some(id => ["nigel", "ray"].includes(id)), false);

console.log(failed ? `\n${failed} failed.\n` : "\nAll good.\n");
Deno.exit(failed ? 1 : 0);
