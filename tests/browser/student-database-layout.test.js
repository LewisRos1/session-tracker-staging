// The Student Database: a list of names, then one student at a time.
//
// It was one table eleven columns wide. This suite used to check it did not
// crush itself at half a screen -- every column shrank together, so the name
// boxes came out four characters wide and "Short Name (Used in AI Reports)"
// wrapped one letter to a line. The answer then was to let it scroll
// sideways.
//
// Lewis asked for something simpler, and the table is gone. A list of names,
// then a page per student with each field on its own line and a sentence
// under it saying where the value shows up -- which is also what settled
// Note and Program sounding like the same thing.
//
// The old suite's point survives: at half a screen nothing should be
// crushed, and now nothing should scroll sideways either.
//
//   deno run -A tests/browser/student-database-layout.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: student-database-layout.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

// Three records of one child plus one of another: the shape that makes a
// list of bare full names useless.
const STUDENTS = [
  { id: "c1", name: "Caden Tan", order: 1, preferredName: "Caden", gender: "male", targets: [] },
  { id: "c2", name: "Caden Tan", order: 2, preferredName: "Caden", gender: "male",
    note: "School Readiness", targets: [] },
  { id: "c3", name: "Caden Tan", order: 3, preferredName: "Caden", gender: "male",
    note: "School Readiness 2", targets: [] },
  { id: "k1", name: "Kayden Koh", order: 4, preferredName: "Kayden", gender: "male",
    dob: "2018-10-18", program: "Personal Care", targets: [] },
];

const rows = () => page.eval(`(() => [...document.querySelectorAll(".reg-list-row")]
  .map(b => b.querySelector(".reg-list-name").textContent.trim()))()`);

const openRow = async (label) => {
  await page.eval(`(() => {
    const b = [...document.querySelectorAll(".reg-list-row")]
      .find(x => x.querySelector(".reg-list-name").textContent.trim() === ${JSON.stringify(label)});
    if (!b) throw new Error("no row called " + ${JSON.stringify(label)});
    b.click();
  })()`);
  await settle(300);
};

/**
 * Every field on the open student's page.
 *
 * The explanation is no longer printed under the label -- it is behind the
 * ? at the end of the row, so the hint comes off that button's data-tip.
 * A trailing * on the label is the required marker, not part of the name.
 */
const fields = () => page.eval(`(() => {
  const out = {};
  document.querySelectorAll(".reg-field").forEach(f => {
    const raw = (f.querySelector(".reg-field-label")?.textContent || "").trim();
    const required = raw.endsWith("*");
    const label = (required ? raw.slice(0, -1) : raw).trim();
    const ctl = f.querySelector("input, select");
    out[label] = {
      value: ctl ? ctl.value : null,
      placeholder: ctl ? (ctl.placeholder || "") : "",
      required,
      hint: f.querySelector(".reg-help")?.getAttribute("data-tip") || "",
    };
  });
  return out;
})()`);

try {
  await page.fixture({
    today: "2026-11-05", authUser: "daisy",
    students: STUDENTS, groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // Half of a 1400-wide screen, which is how Lewis had it when he found the
  // original problem.
  await page.resize(700, 1000);
  await settle(200);
  await page.eval(`window.__app.openStudentRegistryScreen()`);
  await page.until(`!!document.querySelector(".reg-list-row")`, "the student list");
  await settle(300);

  // ── 1. the list ─────────────────────────────────────────────────────
  r.section("1. one row per student, told apart by its note");
  const listed = await rows();
  r.check("every record is listed", listed.length, 4);
  // Three records called Caden Tan. Without the note in brackets there is
  // no way to tell which row is which, or to click the right one.
  r.check("the note is what separates them", listed, [
    "Caden Tan",
    "Caden Tan (School Readiness)",
    "Caden Tan (School Readiness 2)",
    "Kayden Koh",
  ]);
  r.check("a student with no note is just the name",
    listed.filter(x => x === "Caden Tan").length, 1);

  // Date of birth was not asked for until v2342, so the records made before
  // it have none. They keep working -- the list just says which ones still
  // need one, rather than blocking anybody's work until they are filled in.
  const flags = await page.eval(`(() => [...document.querySelectorAll(".reg-list-row")]
    .map(b => ({ name: b.querySelector(".reg-list-name").textContent.trim(),
                 flag: b.querySelector(".reg-list-flag")?.textContent.trim() || "" })))()`);
  r.check("the three with no date of birth are marked", flags.filter(x => x.flag).length, 3);
  r.check("the mark says what is missing", flags.find(x => x.flag)?.flag, "No date of birth");
  r.check("and the one that has a date of birth is left alone",
    flags.find(x => x.name === "Kayden Koh")?.flag, "");

  // The No. column. It is the position in the list, so it doubles as the
  // count -- nobody has to run a finger down the rows to total them.
  r.check("every row is numbered, in order",
    await page.eval(`(() => [...document.querySelectorAll(".reg-list-no")]
      .map(n => n.textContent.trim()))()`), ["1", "2", "3", "4"]);
  r.check("and the total is spelled out once",
    (await page.eval(`document.querySelector(".reg-count")?.textContent.trim()`)), "4 students");

  // A to Z, the way a phone's contact list works.
  r.section("1b. the A to Z headings and the rail");
  const az = await page.eval(`(() => ({
    heads: [...document.querySelectorAll(".reg-letter")].map(h => h.textContent.trim()),
    sticky: getComputedStyle(document.querySelector(".reg-letter")).position,
    rail: [...document.querySelectorAll(".reg-rail-btn")].map(b => b.textContent.trim()),
    live: [...document.querySelectorAll(".reg-rail-btn:not([disabled])")].map(b => b.textContent.trim()),
  }))()`);
  // Three Caden Tans under one C, one Kayden Koh under K.
  r.check("one heading each time the first letter changes", az.heads, ["C", "K"]);
  r.check("and it sticks to the top as you scroll", az.sticky, "sticky");
  r.check("the rail runs # then A to Z", az.rail.length, 27);
  r.check("only the letters that have somebody are live", az.live, ["C", "K"]);

  // Tapping a letter is checked at the end of this file, on a list long
  // enough to scroll. Four rows do not fill the window, so nothing moves.

  r.section("2. nothing is crushed, and nothing scrolls sideways");
  const fit = await page.eval(`(() => {
    const el = document.getElementById("student-registry-body");
    const row = document.querySelector(".reg-list-row");
    return {
      overflow: el.scrollWidth - el.clientWidth,
      rowH: Math.round(row.getBoundingClientRect().height),
      nameW: Math.round(row.querySelector(".reg-list-name").getBoundingClientRect().width),
    };
  })()`);
  r.ok("the list fits the window", fit.overflow <= 1, `overflows by ${fit.overflow}px`);
  r.ok("a row is one line tall, not a wrapped block", fit.rowH < 70, `${fit.rowH}px`);
  r.ok("and the name has room", fit.nameW > 200, `${fit.nameW}px`);

  // ── 3. one student ──────────────────────────────────────────────────
  r.section("3. a student's own page holds every field");
  await openRow("Kayden Koh");
  const f = await fields();
  r.check("the list is gone", await rows(), []);
  r.check("Full Name",            f["Full Name"]?.value, "Kayden Koh");
  r.check("Short Name",           f["Short Name"]?.value, "Kayden");
  r.check("Date of Birth",        f["Date of Birth"]?.value, "2018-10-18");
  r.check("Program",              f["Program"]?.value, "Personal Care");
  r.check("Report Type is there", !!f["Report Type"], true);
  r.check("and the Chinese ones have not been dropped",
    !!f["Full Name (Chinese)"] && !!f["Short Name (Chinese)"], true);

  // Nine fields in one unbroken column gave no clue which of them the
  // reports read, which is the question anybody opening this page has.
  const groups = await page.eval(`(() => [...document.querySelectorAll(".reg-card")].map(c => ({
    title: c.querySelector(".reg-card-title")?.textContent.trim() || "",
    fields: [...c.querySelectorAll(".reg-field")].map(f => {
      const raw = (f.querySelector(".reg-field-label")?.textContent || "").trim();
      return raw.endsWith("*") ? raw.slice(0, -1).trim() : raw;
    }),
  })))()`);
  r.check("the page is three titled cards", groups.map(g => g.title),
    ["Student Details", "Report Details", "Chinese Report"]);
  r.check("who the student is", groups[0]?.fields,
    ["Full Name", "Gender", "Date of Birth", "Note (Optional)"]);
  r.check("what the reports read", groups[1]?.fields,
    ["Short Name", "Program", "Report Type", "Sessions Recorded"]);
  r.check("the two only a Chinese report needs", groups[2]?.fields,
    ["Full Name (Chinese)", "Short Name (Chinese)"]);
  r.check("every field is inside a card",
    groups.reduce((n, g) => n + g.fields.length, 0),
    await page.eval(`document.querySelectorAll(".reg-field").length`));
  // The paragraph under each heading was the thing Lewis asked to go.
  r.check("and no card explains itself in a paragraph",
    await page.eval(`document.querySelectorAll(".reg-card p").length`), 0);

  // Label, box and ? sit on one line. At half a screen that still has to
  // fit, which is the whole point this suite was written for.
  const page3 = await page.eval(`(() => {
    const el  = document.getElementById("student-registry-body");
    const fld = document.querySelector(".reg-field");
    const lab = fld.querySelector(".reg-field-label");
    const ctl = fld.querySelector(".reg-field-ctl");
    const g = document.querySelector(".db-gender-select").getBoundingClientRect();
    const d = document.querySelector(".db-dob-input").getBoundingClientRect();
    return {
      overflow: el.scrollWidth - el.clientWidth,
      labelAbove: ctl.getBoundingClientRect().top >= lab.getBoundingClientRect().bottom,
      ctlW: Math.round(ctl.getBoundingClientRect().width),
      paired: Math.abs(g.top - d.top) < 12 && d.left > g.right - 4,
    };
  })()`);
  r.ok("the page fits the window", page3.overflow <= 1, `overflows by ${page3.overflow}px`);
  // The label moved above its box so that two fields can share a row.
  r.ok("the label sits above its box", page3.labelAbove, "it is still beside it");
  r.ok("Gender and Date of Birth share a row", page3.paired, "they are stacked");
  r.ok("and the box is not squeezed", page3.ctlW > 200, `${page3.ctlW}px`);

  // The whole reason for the rewrite: a field can now say what it is for.
  // It says it on hover, out of a ? at the end of the row, instead of
  // printing a sentence under every one of nine labels.
  r.section("4. the ? says where the field shows up");
  r.ok("Note says it appears after the name",
    /brackets after the name/i.test(f["Note (Optional)"]?.hint || ""), f["Note (Optional)"]?.hint);
  r.ok("Note says it is what tells two records apart",
    /tells two records of the same student apart/i.test(f["Note (Optional)"]?.hint || ""), f["Note (Optional)"]?.hint);
  r.ok("Program says it appears on the report cover",
    /report cover/i.test(f["Program"]?.hint || ""), f["Program"]?.hint);
  r.ok("Date of Birth says it fills the age too",
    /Date of Birth and Age/i.test(f["Date of Birth"]?.hint || ""), f["Date of Birth"]?.hint);

  // Every field has one, and it is reachable by keyboard as well as hover,
  // which is also what makes it work on a tablet.
  const help = await page.eval(`(() => {
    const btns = [...document.querySelectorAll(".reg-field .reg-help")];
    return {
      count: btns.length,
      fields: document.querySelectorAll(".reg-field").length,
      allButtons: btns.every(b => b.tagName === "BUTTON"),
      allLabelled: btns.every(b => (b.getAttribute("aria-label") || "").length > 20),
      allTipped: btns.every(b => (b.getAttribute("data-tip") || "").length > 10),
      text: btns[0]?.textContent.trim(),
    };
  })()`);
  r.check("every field has a ?", help.count, help.fields);
  r.ok("it is a real button, so tab and tap reach it", help.allButtons, "not all buttons");
  r.ok("and a screen reader gets the sentence", help.allLabelled, "an aria-label is missing or too short");
  r.ok("every ? carries its explanation", help.allTipped, "a data-tip is missing or too short");
  r.check("it reads as a question mark", help.text, "?");

  // A blank box should show what belongs in it. "Full name" was the old
  // placeholder, which says nothing the label had not already said.
  r.section("5. the boxes show an example, and required fields are marked");
  r.ok("Full Name shows a whole name",
    /^e\.g\. \w+ \w+/.test(f["Full Name"]?.placeholder || ""), f["Full Name"]?.placeholder);
  r.ok("the Chinese box shows Chinese",
    /[一-鿿]/.test(f["Full Name (Chinese)"]?.placeholder || ""), f["Full Name (Chinese)"]?.placeholder);
  r.ok("Short Name shows one name only",
    /^e\.g\. \w+$/.test(f["Short Name"]?.placeholder || ""), f["Short Name"]?.placeholder);
  r.ok("Note shows a note", /^e\.g\. /.test(f["Note (Optional)"]?.placeholder || ""), f["Note (Optional)"]?.placeholder);
  r.ok("Program shows a programme", /^e\.g\. /.test(f["Program"]?.placeholder || ""), f["Program"]?.placeholder);
  r.check("the four that cannot be blank are starred",
    ["Full Name", "Gender", "Short Name", "Date of Birth"].map(k => !!f[k]?.required),
    [true, true, true, true]);
  r.check("and nothing else is",
    ["Full Name (Chinese)", "Short Name (Chinese)", "Note (Optional)", "Program", "Report Type"]
      .filter(k => f[k]?.required), []);

  // ── 6. saving ───────────────────────────────────────────────────────
  //
  // Every box used to write to the database the moment you clicked out of
  // it, so there was nothing a Save button could have done and no way to
  // change your mind. Nothing is written now until Save is pressed.
  r.section("6. nothing is written until Save is pressed");
  const setBox = (cls, val) => page.eval(`(() => {
    const el = document.querySelector(".${cls}");
    el.value = ${JSON.stringify(val)};
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur",   { bubbles: true }));
  })()`);
  const stored = key => page.eval(
    `window.__app.state.students.find(s => s.id === "k1")[${JSON.stringify(key)}] ?? null`);

  await setBox("db-program-input", "Speech and Language");
  await settle(200);
  r.ok("typing marks the page as unsaved", await page.eval(`window.__app.regIsDirty()`), "not dirty");
  r.ok("and the page says so",
    await page.eval(`document.getElementById("student-registry-body").classList.contains("reg-dirty")`),
    "no mark on screen");
  r.check("in words, beside the buttons",
    await page.eval(`document.getElementById("reg-status").textContent.trim()`), "Not saved yet");
  r.check("clicking out of the box writes nothing", await stored("program"), "Personal Care");

  // Walking away has to ask, and "no" has to mean stay.
  await page.eval(`window.__regAsked = 0; window.confirm = () => { window.__regAsked++; return false; };`);
  await page.eval(`document.getElementById("btn-reg-back").click()`);
  await settle(300);
  r.check("going back asks first", await page.eval(`window.__regAsked`), 1);
  r.ok("and saying no keeps you on the page",
    await page.eval(`!!document.getElementById("btn-save-student")`), "it left anyway");

  // The arrow out of the Student Database had two listeners on it, both
  // calling the same function. That was invisible while leaving was silent.
  // Once leaving asked a question, one click put the question up twice and
  // Cancel had to be pressed twice to stay on the page.
  await page.eval(`window.__regAsked = 0;`);
  await page.eval(`document.getElementById("btn-student-registry-back").click()`);
  await settle(300);
  r.check("the arrow out of the screen asks once, not twice",
    await page.eval(`window.__regAsked`), 1);
  r.ok("and that no keeps you here too",
    await page.eval(`!!document.getElementById("btn-save-student")`), "it left anyway");

  await page.eval(`document.getElementById("btn-save-student").click()`);
  await settle(800);
  r.check("Save writes it", await stored("program"), "Speech and Language");
  // It stays on the student's page. The button is what says the write went
  // through, and it says so for long enough to read.
  r.check("it stays on the student's page", (await rows()).length, 0);
  r.check("the page says so", await page.eval(
    `document.getElementById("reg-status").textContent.trim()`),
    "Saved! Feel free to go back to home page");
  r.check("and the Save button keeps its own name", await page.eval(
    `document.getElementById("btn-save-student").textContent.trim()`), "Save Changes");
  r.ok("and the unsaved mark is gone",
    !(await page.eval(`document.getElementById("student-registry-body").classList.contains("reg-dirty")`)),
    "still marked unsaved");
  r.ok("the button is usable again, not left disabled",
    !(await page.eval(`document.getElementById("btn-save-student").disabled`)), "still disabled");
  r.ok("leaving no longer asks",
    (await page.eval(`window.__regAsked`)) === 1, "it asked again");

  await setBox("db-program-input", "Something to throw away");
  await settle(200);
  await page.eval(`window.__regAsked = 0;`);
  await page.eval(`document.getElementById("btn-reg-cancel").click()`);
  await settle(300);
  r.check("Cancel asks once", await page.eval(`window.__regAsked`), 1);
  r.ok("and no keeps you on the page",
    await page.eval(`!!document.getElementById("btn-save-student")`), "it left anyway");
  r.check("nothing was written", await stored("program"), "Speech and Language");

  await page.eval(`window.confirm = () => { window.__regAsked++; return true; };`);
  await page.eval(`document.getElementById("btn-reg-cancel").click()`);
  await settle(300);
  r.check("yes throws the typing away and goes back", (await rows()).length, 4);
  r.check("and still nothing was written", await stored("program"), "Speech and Language");
  await page.eval(`window.confirm = () => { window.__regAsked++; return false; };`);
  await openRow("Kayden Koh");

  // Typing again makes the last save old news, so the message goes.
  await setBox("db-program-input", "Something else");
  await settle(200);
  r.check("typing again replaces it with the warning", await page.eval(
    `document.getElementById("reg-status").textContent.trim()`), "Not saved yet");
  await setBox("db-program-input", "Speech and Language");
  await settle(200);

  // The number used to be the button: an 8 with a dotted underline.
  r.section("7. Sessions Recorded has a button of its own");
  const sess = await page.eval(`(() => {
    const b = document.querySelector(".reg-sessnum-btn");
    const n = document.querySelector(".reg-indiv-num");
    return {
      label: b?.textContent.trim() || "",
      isButton: b?.tagName === "BUTTON",
      numberStillShown: !!n,
      numberUnderlined: /underline/.test(n?.getAttribute("style") || ""),
    };
  })()`);
  r.check("the button says what it does", sess.label, "Change Session Number");
  r.ok("and it is a button", sess.isButton, "not a button");
  r.ok("the number is still shown", sess.numberStillShown, "the count went missing");
  r.ok("but is no longer pretending to be a link", !sess.numberUnderlined, "still underlined");

  r.section("8. back to the list");
  await page.eval(`document.getElementById("btn-reg-back").click()`);
  await settle(300);
  r.check("every student is listed again", (await rows()).length, 4);

  // The add form is the same four rows in the same shape, not a second
  // design that drifts away from the student's page.
  await page.eval(`document.getElementById("btn-add-student-row").click()`);
  await settle(300);
  const nf = await fields();
  r.check("the add form asks for the four that cannot be blank, and the note",
    Object.keys(nf).sort(),
    ["Date of Birth", "Full Name", "Gender", "Note (Optional)", "Short Name"]);
  r.check("starred the same way there",
    ["Full Name", "Gender", "Short Name", "Date of Birth"].map(k => !!nf[k]?.required),
    [true, true, true, true]);
  r.ok("and the examples came with it",
    /^e\.g\. /.test(nf["Full Name"]?.placeholder || ""), nf["Full Name"]?.placeholder);
  r.ok("the ? says the same thing as on the student's page",
    nf["Note (Optional)"]?.hint === f["Note (Optional)"]?.hint,
    `${nf["Note (Optional)"]?.hint} vs ${f["Note (Optional)"]?.hint}`);
  r.check("and it is a card like the rest",
    await page.eval(`document.querySelectorAll("#new-student-form .reg-card").length`), 1);
  await page.eval(`document.getElementById("btn-cancel-new-student").click()`);
  await settle(300);

  // ── 9. the age maths ────────────────────────────────────────────────
  //
  // "7 years, 9 months" on the report's Student Details. Counted the way a
  // person counts: the day of the month has to come round again before the
  // month is over.
  r.section("9. age, counted the way a person counts it");
  const age = (dob, on) => page.eval(
    `window.__app.ageOn({ dob: ${JSON.stringify(dob)} }, new Date(${JSON.stringify(on)} + "T00:00:00"))`);
  r.check("the report's own example",   await age("2018-10-18", "2026-08-01"), "7 years, 9 months");
  r.check("the day before a birthday",  await age("2018-10-18", "2026-10-17"), "7 years, 11 months");
  r.check("the birthday itself",        await age("2018-10-18", "2026-10-18"), "8 years, 0 months");
  r.check("under one year old",         await age("2026-08-18", "2026-11-05"), "2 months");
  r.check("one year exactly",           await age("2025-11-05", "2026-11-05"), "1 year, 0 months");
  r.check("no date of birth, no age",   await age("", "2026-11-05"), "");
  r.check("a date in the future",       await age("2030-01-01", "2026-11-05"), "");
  r.check("something that is not a date", await age("not a date", "2026-11-05"), "");

  const dobText = d => page.eval(`window.__app.dobOn({ dob: ${JSON.stringify(d)} })`);
  r.check("the date of birth reads as a date", await dobText("2018-10-18"), "18th October 2018");
  r.check("and blank when there is none", await dobText(""), "");

  // The reports have always been typed with an ordinal. en-GB's own long
  // format has none, so the two generated rows were the odd pair in their
  // own table.
  r.section("9b. the ordinal, which the reports write by hand");
  const ord = n => page.eval(`window.__app.ordinalDay(${n})`);
  r.check("1st",  await ord(1),  "1st");
  r.check("2nd",  await ord(2),  "2nd");
  r.check("3rd",  await ord(3),  "3rd");
  r.check("4th",  await ord(4),  "4th");
  // The three that break the pattern: 11th, not 11st.
  r.check("11th", await ord(11), "11th");
  r.check("12th", await ord(12), "12th");
  r.check("13th", await ord(13), "13th");
  r.check("21st", await ord(21), "21st");
  r.check("22nd", await ord(22), "22nd");
  r.check("31st", await ord(31), "31st");
  const long = d => page.eval(`window.__app.longDateText(${JSON.stringify(d)})`);
  r.check("the report's own Date of Report", await long("2026-08-01"), "1st August 2026");
  r.check("nothing from a date that is not one", await long("31 Feb"), "");

  // ── 10. the reports read these two ───────────────────────────────────
  r.section("10. the reports read Program and Date of Birth");
  const src = await Deno.readTextFile("app.js");
  r.check("the cover page prints the programme",
    /mkCoverShaded\(\(student\?\.program \|\| ""\)\.trim\(\), 28\)/.test(src), true);
  r.check("both Student Details tables print the date of birth",
    (src.match(/mkDetailRow\("Date of Birth:", mkLongDateRuns\(student\?\.dob\)\)/g) || []).length, 2);
  r.check("and the age beside it",
    (src.match(/mkDetailRow\("Age:", ageOn\(student\)\)/g) || []).length, 2);
  // Both Date of Report rows and the cover box, so no date in that table
  // is left in the old format while the one above it changed.
  r.check("both Date of Report rows use the same builder",
    (src.match(/mkDetailRow\("Date of Report:", mkLongDateRuns\(new Date\(\)\)\)/g) || []).length, 2);
  r.check("and the cover box with it",
    /mkCoverShaded\(mkLongDateRuns\(new Date\(\), 28, TNR\)\)/.test(src), true);
  r.check("the ordinal letters are raised, as the typed reports have them",
    /text: suffix, superScript: true/.test(src), true);
  r.check("and the old en-GB long date is gone from the documents",
    (src.match(/const reportDate = /g) || []).length, 0);

  // ── 11. the rail, on a list long enough to need one ─────────────────
  //
  // Four students do not fill the window, so there is nothing for a jump
  // to do. This reloads with one student per letter, which is the shape
  // the rail was asked for.
  r.section("11. tapping a rail letter on a long list");
  const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  await page.fixture({
    today: "2026-11-05", authUser: "daisy", groups: [], sessions: [],
    students: AZ.map((L, i) => ({
      id: "x" + L, name: `${L}aniel ${L}ee`, order: i,
      preferredName: L + "an", gender: "male", dob: "2018-10-18", targets: [],
    })),
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home again");
  await page.eval(`window.__app.openStudentRegistryScreen()`);
  await page.until(`!!document.querySelector(".reg-list-row")`, "the long list");
  await settle(400);

  r.check("every letter has somebody now",
    await page.eval(`document.querySelectorAll(".reg-rail-btn:not([disabled])").length`), 26);
  r.check("and the count says so",
    await page.eval(`document.querySelector(".reg-count").textContent.trim()`), "26 students");
  r.check("the last row is numbered 26",
    await page.eval(`[...document.querySelectorAll(".reg-list-no")].pop().textContent.trim()`), "26");
  r.ok("the list is long enough to scroll", await page.eval(`(() => {
    const b = document.getElementById("student-registry-body");
    return b.scrollHeight - b.clientHeight > 200;
  })()`), "it still fits the window, so the jump proves nothing");

  await page.eval(`(() => [...document.querySelectorAll(".reg-rail-btn")]
    .find(x => x.textContent.trim() === "H").click())()`);
  await settle(800);
  const landed = await page.eval(`(() => {
    const body = document.getElementById("student-registry-body");
    const head = document.getElementById("reg-letter-H");
    return Math.round(head.getBoundingClientRect().top - body.getBoundingClientRect().top);
  })()`);
  r.ok("tapping H brings H to the top", Math.abs(landed) < 40, `${landed}px off`);

  // The rail itself must not scroll away with the list.
  r.ok("and the rail stays put", await page.eval(`(() => {
    const body = document.getElementById("student-registry-body");
    const rail = document.querySelector(".reg-rail");
    return rail.getBoundingClientRect().top - body.getBoundingClientRect().top < 40;
  })()`), "the rail scrolled off the top");

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join(" | "));
} finally {
  await page.close?.();
}

r.done("The Student Database");
