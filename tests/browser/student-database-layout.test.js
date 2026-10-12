// The Student Database at half a screen.
//
// It is ten columns wide. On a percentage layout every column shrank
// together, so at half a screen the name boxes came out four characters
// wide and "Short Name (Used in AI Reports)" wrapped one letter to a line.
// A table that is wider than the window should say so by scrolling, not by
// crushing itself.
//
// Measured at the width Lewis actually works at, because a test at 1400
// pixels will never see any of this.
//
//   deno run -A tests/browser/student-database-layout.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: student-database-layout.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

const student = (i) => ({
  id: "s" + i, name: "Student Number " + i, order: i,
  preferredName: "Stu" + i, targets: [],
});

try {
  await page.fixture({
    today: "2026-10-12", authUser: "daisy",
    students: [1, 2, 3].map(student), groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // Half of a 1400-wide screen, which is how Lewis had it when he found this.
  await page.resize(700, 1000);
  await settle(200);
  await page.eval(`window.__app.openStudentRegistryScreen()`);
  await page.until(`!!document.querySelector(".registry-table")`, "the table");
  await settle(300);

  r.section("at half a screen, the table keeps its shape");
  const cols = await page.eval(`(() => {
    const ths = [...document.querySelectorAll(".registry-table thead th")];
    return ths.map(th => ({
      text: th.textContent.replace(/\\s+/g, " ").trim().slice(0, 28),
      w: Math.round(th.getBoundingClientRect().width),
      h: Math.round(th.getBoundingClientRect().height),
    }));
  })()`);

  r.check("all ten columns are there", cols.length, 10);
  const named = cols.filter(c => c.text);
  r.ok("no header is squeezed to a sliver",
    named.every(c => c.w >= 40),
    "narrowest: " + JSON.stringify(named.slice().sort((a, b) => a.w - b.w)[0]));

  // The giveaway is the height of the header ROW. A narrow column is fine --
  // "No." is always narrow -- but when the wording wraps a letter at a time
  // the whole row grows to fit it. Broken, this was over 140 tall.
  const headHeight = await page.eval(`
    Math.round(document.querySelector(".registry-table thead").getBoundingClientRect().height)`);
  r.ok("the header row has not grown into a tower", headHeight < 110,
    `the header row is ${headHeight}px tall`);

  r.section("the name boxes are usable");
  const inputs = await page.eval(`(() => {
    const pick = cls => {
      const el = document.querySelector("." + cls);
      return el ? Math.round(el.getBoundingClientRect().width) : null;
    };
    return {
      full: pick("db-fullname-input"), fullZh: pick("db-fullname-zh-input"),
      short: pick("db-shortname-input"), shortZh: pick("db-shortname-zh-input"),
    };
  })()`);
  for (const [what, w] of Object.entries(inputs)) {
    r.ok(`${what} is wide enough to read`, w !== null && w >= 80, `measured ${w}px`);
  }

  r.section("it scrolls sideways instead");
  const scroll = await page.eval(`(() => {
    const body = document.getElementById("student-registry-body");
    const tbl = document.querySelector(".registry-table");
    return {
      tableWider: Math.round(tbl.getBoundingClientRect().width) > body.clientWidth,
      canScroll: body.scrollWidth > body.clientWidth,
      overflowX: getComputedStyle(body).overflowX,
    };
  })()`);
  r.ok("the table is wider than the window", scroll.tableWider, JSON.stringify(scroll));
  r.ok("and the screen scrolls to reach it",
    scroll.canScroll && scroll.overflowX !== "hidden", JSON.stringify(scroll));

  r.section("and it still looks right on a full screen");
  await page.resize(1400, 1000);
  await settle(200);
  await page.eval(`window.__app.openStudentRegistryScreen()`);
  await settle(300);
  const wideHead = await page.eval(`
    Math.round(document.querySelector(".registry-table thead").getBoundingClientRect().height)`);
  r.ok("the header row is still a sensible height", wideHead < 110,
    `the header row is ${wideHead}px tall`);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("student-database-layout-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
