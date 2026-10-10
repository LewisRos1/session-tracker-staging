// Everyone signs in again at the start of each week.
//
// Lewis asked for a weekly sign-out so that nobody forgets their own
// password. It works by putting the current week into SESSION_EPOCH: the
// string changes by itself every Monday, and each browser signs itself out
// once when it next opens.
//
// The function is pulled straight out of app.js rather than copied, so this
// cannot drift from what ships.
//
//   deno run --allow-read tests/week-signout.test.js

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

const weekStartStamp = new Function(extract("weekStartStamp") + "; return weekStartStamp;")();

let failed = 0;
const check = (what, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        want ${want}\n        got  ${got}`}`);
};

// Local time on purpose: everyone rolls over at their own midnight.
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm);

console.log("\nevery day of one week gives that week's Monday");
// Mon 5th to Sun 11th January 2026.
for (const [day, date] of [["Monday", 5], ["Tuesday", 6], ["Wednesday", 7],
                           ["Thursday", 8], ["Friday", 9], ["Saturday", 10],
                           ["Sunday", 11]]) {
  check(`${day} the ${date}th`, weekStartStamp(at(2026, 1, date)), "2026-01-05");
}

console.log("\nthe rollover is midnight on Monday, not any earlier");
check("Sunday 23:59 still belongs to the week before",
  weekStartStamp(at(2026, 1, 11, 23, 59)), "2026-01-05");
check("Monday 00:00 starts the new week",
  weekStartStamp(at(2026, 1, 12, 0, 0)), "2026-01-12");

console.log("\nmonths and years do not break it");
check("a week running across the end of a month",
  weekStartStamp(at(2026, 4, 1)), "2026-03-30");
check("a week running across the end of a year",
  weekStartStamp(at(2027, 1, 1)), "2026-12-28");
check("the 29th of February in a leap year",
  weekStartStamp(at(2028, 2, 29)), "2028-02-28");

console.log("\nthe shape of the stamp");
const today = weekStartStamp();
check("ten characters, YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(today), true);
check("padded, not 2026-1-5",
  weekStartStamp(at(2026, 1, 5)).length, 10);

console.log("\nit is actually wired into the sign-out");
const epoch = src.match(/const SESSION_EPOCH = ([^;]+);/)?.[1] || "";
check("SESSION_EPOCH is built from the week", epoch.includes("weekStartStamp()"), true);
check("and still carries the named-accounts sign-out",
  epoch.includes("named-accounts"), true);

console.log(failed ? `\n${failed} failed.\n` : "\nAll good.\n");
Deno.exit(failed ? 1 : 0);
