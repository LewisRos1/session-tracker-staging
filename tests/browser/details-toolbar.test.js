// The B / U / bullet buttons above a Details box, in a real browser.
//
// The plain tests use stand-in DOM nodes, which cannot show what a browser
// really does with Enter, with a blank line, or with the selection when a
// toolbar button is pressed. Those are exactly where this has gone wrong, so
// this file uses real key presses and real clicks on the real toolbar.
//
//   deno run -A tests/browser/details-toolbar.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: details-toolbar.test.js <harness-dir>"); Deno.exit(2); }

const BULLET = "•";
const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

const fixture = () => ({
  today: "2026-10-08",
  authUser: "daisy",
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [{
      id: "t1", name: "FEDC 1", scale: 3,
      predefinedActivities: [
        { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
      ],
    }],
  }],
  groups: [], sessions: [],
});

const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

async function openDetails() {
  await page.fixture(fixture());
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 1`, "the activity list");
  await settle();

  const hit = await page.eval(`(() => {
    const t = document.querySelector(".mn-act-card .mn-act-compact-title");
    t.scrollIntoView({ block: "center" });
    const b = t.getBoundingClientRect();
    return { x: b.left + 40, y: b.top + b.height / 2 };
  })()`);
  await page.clickAt(hit.x, hit.y);
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-rich")`, "the Details box");
  await settle();

  await page.eval(`(() => {
    const box = document.querySelector("#mn-act-panel-overlay .mn-rich");
    box.focus();
    const sel = window.getSelection(), rg = document.createRange();
    rg.selectNodeContents(box); rg.collapse(false);
    sel.removeAllRanges(); sel.addRange(rg);
  })()`);
}

/** Type lines, pressing real Enter between them. */
async function typeLines(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (i) await page.key("Enter");
    if (lines[i]) await page.type(lines[i]);
  }
  await settle(250);
}

/** Put the caret at the very end of the box, as clicking at the end would. */
async function caretToEnd() {
  await page.eval(`(() => {
    const box = document.querySelector("#mn-act-panel-overlay .mn-rich");
    box.focus();
    const sel = window.getSelection(), rg = document.createRange();
    rg.selectNodeContents(box); rg.collapse(false);
    sel.removeAllRanges(); sel.addRange(rg);
  })()`);
  await settle(120);
}

const clickBullet = async () => {
  await page.click("#mn-act-panel-overlay .btn-fmt-bullet");
  await settle(350);
};

/** What is stored behind the box. */
const stored = () => page.eval(`(() => {
  const p = document.querySelector("#mn-act-panel-overlay");
  const ta = p.querySelector(".mn-act-details-input");
  return ta ? ta.value : "(no field)";
})()`);

const shown = () => page.eval(`(() => {
  const box = document.querySelector("#mn-act-panel-overlay .mn-rich");
  return box ? box.innerText : "(no box)";
})()`);

try {
  // ══ 1. a single line ═════════════════════════════════════════════════
  r.section("1. one line, caret at the end");

  await openDetails();
  await typeLines(["hello"]);
  await caretToEnd();
  await clickBullet();
  r.check("the line gets a bullet", await stored(), `${BULLET} hello`);

  await clickBullet();
  r.check("pressing again takes it off", await stored(), "hello");

  // ══ 2. several lines, no blanks ══════════════════════════════════════
  r.section("2. three lines, caret at the end of the last");

  await openDetails();
  await typeLines(["one", "two", "three"]);
  await caretToEnd();
  await clickBullet();
  r.check("only the last line is bulleted", await stored(), `one\ntwo\n${BULLET} three`);

  // ══ 3. blank lines, which is what the real box had ═══════════════════
  r.section("3. blank lines between the text");

  await openDetails();
  await typeLines(["ddd", "", "asdf", "", "asdfadsfasf"]);
  const before = await stored();
  console.log(`        stored before: ${JSON.stringify(before)}`);
  console.log(`        shown  before: ${JSON.stringify(await shown())}`);

  await caretToEnd();
  await clickBullet();
  const after = await stored();
  r.ok("the bullet button did something", after !== before,
    `nothing changed. stored is still ${JSON.stringify(after)}`);
  r.ok("the bullet landed on the LAST line",
    after.split("\n").pop().startsWith(BULLET),
    `stored is ${JSON.stringify(after)}`);
  r.ok("no other line was touched",
    after.split("\n").slice(0, -1).every(l => !l.startsWith(BULLET)),
    `stored is ${JSON.stringify(after)}`);

  await clickBullet();
  r.check("and it comes off again", await stored(), before);

  // ══ 4. the caret in the middle of a line below blanks ════════════════
  r.section("4. caret inside a line that sits below blank lines");

  await openDetails();
  await typeLines(["aaa", "", "bbb", "", "ccc"]);
  // Put the caret in the middle of "bbb".
  await page.eval(`(() => {
    const box = document.querySelector("#mn-act-panel-overlay .mn-rich");
    const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let n; while ((n = walk.nextNode())) {
      if (n.nodeValue.includes("bbb")) {
        const rg = document.createRange();
        rg.setStart(n, 2); rg.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
        box.focus();
        return;
      }
    }
  })()`);
  await settle(150);
  await clickBullet();
  const mid = await stored();
  r.ok("the middle line is the one that changed",
    mid.split("\n").filter(l => l.startsWith(BULLET)).length === 1
      && mid.includes(`${BULLET} bbb`),
    `stored is ${JSON.stringify(mid)}`);

  // ══ 5. bold still works alongside ════════════════════════════════════
  r.section("5. bold on a selection");

  await openDetails();
  await typeLines(["make me bold"]);
  await page.eval(`(() => {
    const box = document.querySelector("#mn-act-panel-overlay .mn-rich");
    const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    const n = walk.nextNode();
    const rg = document.createRange();
    rg.setStart(n, 8); rg.setEnd(n, 12);      // "bold"
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg);
    box.focus();
  })()`);
  await settle(150);
  await page.click("#mn-act-panel-overlay .btn-fmt-bold");
  await settle(350);
  r.check("only the selected word is marked", await stored(), "make me *bold*");

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors during the run", noise.length === 0,
    noise.slice(0, 5).map(n => n.text.slice(0, 160)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("details-toolbar-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
