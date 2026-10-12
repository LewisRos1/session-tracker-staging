// The List of Corrections: three states, and only Ms. Daisy may approve.
//
// It used to be Undone / Corrected / Still Wrong, settable by anyone. Lewis
// asked for Ms. Daisy to sign work off. The two rules that matter:
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

const stored  = STATES.map(s => s.value);
const labelOf = v => (STATES.find(s => s.value === v) || {}).label;
const turnOf  = v => (STATES.find(s => s.value === v) || {}).turn;

console.log("\nthree states, and the values Firestore already holds");
check("Needs Revision, Done, Approved", [...stored].sort(), ["", "done", "fixed"]);
check("the words Lewis asked for",
  stored.map(labelOf), ["Needs Revision", "Done", "Approved"]);

console.log("\neach person sees their own two choices");
// Pull the real rule out of app.js rather than restating it here.
const mayPick = new Function("o", "canSignOffCorrections",
  // Bracketed: the rule starts on the line AFTER the arrow, and a bare
  // `return` followed by a newline returns undefined.
  `return (${src.match(/const mayPickCorrection = o =>([\s\S]*?);\r?\n/)[1]});`);
const choicesFor = isDaisy =>
  STATES.filter(o => mayPick(o, () => isDaisy)).map(o => o.value).sort();

check("Nigel and Rayhanah: Needs Revision and Done", choicesFor(false), ["", "done"]);
check("Ms. Daisy: Needs Revision and Approved",      choicesFor(true),  ["", "fixed"]);
check("she is not offered Done -- that is theirs to say",
  choicesFor(true).includes("done"), false);
check("they are not offered Approved -- nobody signs off their own work",
  choicesFor(false).includes("fixed"), false);
check("Needs Revision belongs to both, so she can send a row back",
  choicesFor(true).includes("") && choicesFor(false).includes(""), true);

console.log("\nthe state a row is in shows even when it is not yours to pick");
check("such an option is greyed out rather than hidden",
  /mayPickCorrection\(o\) \|\| o\.value === st/.test(src)
  && /mayPickCorrection\(o\) \? "" : " disabled"/.test(src), true);

console.log("\nwhose turn each state is (what the button outside counts)");
check("nothing done yet -> the person being corrected", turnOf(""), "them");
check("they say it is done -> Ms. Daisy",               turnOf("done"), "daisy");
check("approved -> nobody, it is finished",             turnOf("fixed"), null);
check("exactly one finished state", STATES.filter(s => s.turn === null).length, 1);

console.log("\nthe retired state still reads correctly");
// "Still wrong, fix again" is gone, but rows written before this still say it.
const normalise = new Function(
  `return ${src.match(/const normaliseCorrection = ([^;]+);/)[1]};`)();
check("an old 'rejected' row reads as Needs Revision", normalise("rejected"), "");
check("it is not offered as a choice any more", stored.includes("rejected"), false);
check("nothing else is changed",
  ["", "done", "fixed", null, undefined].map(normalise), ["", "done", "fixed", "", ""]);

console.log("\na finished session must not reopen");
check("the finished state is still the one already stored as fixed",
  STATES.find(s => s.turn === null).value, "fixed");
check("the workflow still asks for exactly that value",
  /getCmtStatus\(c\) === "fixed"/.test(src), true);
check("and a change away from it still reopens the phases",
  /if \(next !== "fixed"\)/.test(src), true);

console.log("\nLewis can approve too, so he can unstick the team");
const signers = src.match(/canSignOffCorrections = \(\) => (\[[^\]]*\])/)?.[1];
check("Ms. Daisy and Lewis", new Function(`return ${signers};`)().sort(), ["daisy", "lewis"]);
check("not Nigel or Rayhanah",
  new Function(`return ${signers};`)().some(id => ["nigel", "ray"].includes(id)), false);

console.log("\neach phase asks its own question");
// Rayhanah could mark her whole list Done, see "0 to fix" on her own button,
// and still not tick Phase 3 -- because it waited on Ms. Daisy. Phase 4, the
// one that IS hers, did not look at the list at all.
check("Phase 3 asks whether the instructor is done",
  /if \(newDone && !ws\.allDoneFor\(id\)\)/.test(src), true);
check("Phase 4 asks whether Ms. Daisy has approved",
  /if \(!ws\.p4CheckDone\(id\) && !ws\.allFixedFor\(id\)\)/.test(src), true);
check("Phase 3 no longer demands Approved",
  /if \(newDone && !ws\.allFixedFor\(id\)\)/.test(src), false);

console.log("\nthe warnings use the words that are on the dropdown");
check("Phase 3 names Needs Revision and Done",
  /still Needs Revision[\s\S]{0,90}to Done to complete this phase/.test(src), true);
check("Phase 4 names Approved",
  /not Approved yet[\s\S]{0,60}Approve /.test(src), true);
check("nothing still says 'Tick it'", /Tick \$\{/.test(src), false);
check("Phase 4 has its own warning box, not Phase 3's",
  /_phase4Error \? `<div class="wf-error-msg">/.test(src), true);

console.log("\nthe '-> you' line under the dropdown is gone");
check("no turn label in the row", /snote-turn/.test(src), false);
check("nor any styling left behind for it",
  /snote-turn/.test(await Deno.readTextFile("styles.css")), false);

console.log(failed ? `\n${failed} failed.\n` : "\nAll good.\n");
Deno.exit(failed ? 1 : 0);
