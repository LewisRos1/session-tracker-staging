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

  // Label, box and ? sit on one line. At half a screen that still has to
  // fit, which is the whole point this suite was written for.
  const page3 = await page.eval(`(() => {
    const el  = document.getElementById("student-registry-body");
    const row = document.querySelector(".reg-field-row");
    const lab = row.querySelector(".reg-field-label");
    const ctl = row.querySelector(".reg-field-ctl");
    return {
      overflow: el.scrollWidth - el.clientWidth,
      sameLine: Math.abs(lab.getBoundingClientRect().top - ctl.getBoundingClientRect().top) < 12,
      ctlW: Math.round(ctl.getBoundingClientRect().width),
    };
  })()`);
  r.ok("the page fits the window", page3.overflow <= 1, `overflows by ${page3.overflow}px`);
  r.ok("the label and the box are on one line", page3.sameLine, "they wrapped");
  r.ok("and the box is not squeezed", page3.ctlW > 200, `${page3.ctlW}px`);

  // The whole reason for the rewrite: a field can now say what it is for.
  // It says it on hover, out of a ? at the end of the row, instead of
  // printing a sentence under every one of nine labels.
  r.section("4. the ? says where the field shows up");
  r.ok("Note says it appears after the name",
    /brackets after the name/i.test(f["Note"]?.hint || ""), f["Note"]?.hint);
  r.ok("Note says it is what tells two records apart",
    /tells two records of the same student apart/i.test(f["Note"]?.hint || ""), f["Note"]?.hint);
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
  r.ok("Note shows a note", /^e\.g\. /.test(f["Note"]?.placeholder || ""), f["Note"]?.placeholder);
  r.ok("Program shows a programme", /^e\.g\. /.test(f["Program"]?.placeholder || ""), f["Program"]?.placeholder);
  r.check("the three that cannot be blank are starred",
    ["Full Name", "Gender", "Short Name"].map(k => !!f[k]?.required), [true, true, true]);
  r.check("and nothing else is",
    ["Full Name (Chinese)", "Short Name (Chinese)", "Date of Birth", "Note", "Program", "Report Type"]
      .filter(k => f[k]?.required), []);

  r.section("6. back to the list");
  await page.eval(`document.getElementById("btn-reg-back").click()`);
  await settle(300);
  r.check("every student is listed again", (await rows()).length, 4);

  // The add form is the same four rows in the same shape, not a second
  // design that drifts away from the student's page.
  await page.eval(`document.getElementById("btn-add-student-row").click()`);
  await settle(300);
  const nf = await fields();
  r.check("the add form asks for the three that cannot be blank, and the note",
    Object.keys(nf).sort(), ["Full Name", "Gender", "Note", "Short Name"]);
  r.check("starred the same way there",
    ["Full Name", "Gender", "Short Name"].map(k => !!nf[k]?.required), [true, true, true]);
  r.ok("and the examples came with it",
    /^e\.g\. /.test(nf["Full Name"]?.placeholder || ""), nf["Full Name"]?.placeholder);
  r.ok("the ? says the same thing as on the student's page",
    nf["Note"]?.hint === f["Note"]?.hint, `${nf["Note"]?.hint} vs ${f["Note"]?.hint}`);
  await page.eval(`document.getElementById("btn-cancel-new-student").click()`);
  await settle(300);

  // ── 7. the age maths ────────────────────────────────────────────────
  //
  // "7 years, 9 months" on the report's Student Details. Counted the way a
  // person counts: the day of the month has to come round again before the
  // month is over.
  r.section("7. age, counted the way a person counts it");
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
  r.check("the date of birth reads as a date", await dobText("2018-10-18"), "18 October 2018");
  r.check("and blank when there is none", await dobText(""), "");

  // ── 8. the reports read these two ───────────────────────────────────
  r.section("8. the reports read Program and Date of Birth");
  const src = await Deno.readTextFile("app.js");
  r.check("the cover page prints the programme",
    /mkCoverShaded\(\(student\?\.program \|\| ""\)\.trim\(\), 28\)/.test(src), true);
  r.check("both Student Details tables print the date of birth",
    (src.match(/mkDetailRow\("Date of Birth:", dobOn\(student\)\)/g) || []).length, 2);
  r.check("and the age beside it",
    (src.match(/mkDetailRow\("Age:", ageOn\(student\)\)/g) || []).length, 2);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join(" | "));
} finally {
  await page.close?.();
}

r.done("The Student Database");
