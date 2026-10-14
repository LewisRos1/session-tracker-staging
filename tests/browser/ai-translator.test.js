// The AI Translator screen.
//
// The boss writes a report in English, edits it in Word, and drops the
// edited file in here to get it back in Chinese. Nothing is previewed before
// it downloads, so two things have to hold: the right student, and a Chinese
// name to put on it. Both are checked before the drop zone appears at all.
//
// Sizes are measured rather than inferred. A dead CSS rule once left a
// button on screen at 0 by 0 pixels, present and correct and invisible, and
// the tests that read the stylesheet as text were happy with it.
//
//   deno run -A tests/browser/ai-translator.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: ai-translator.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

const FIX = (who) => ({
  today: "2026-10-12", authUser: who,
  students: [
    { id: "caden", name: "Caden Tan", order: 1, preferredName: "Caden",
      nameZh: "陈嘉登", shortNameZh: "嘉登",
      targets: [{ id: "t1", name: "FEDC (1) – 学习目标一", predefinedActivities: [] }] },
    { id: "amy", name: "Amy Lim", order: 2, preferredName: "Amy", targets: [] },
  ],
  groups: [], sessions: [],
});

const size = (sel) => page.eval(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { w: Math.round(b.width), h: Math.round(b.height), display: cs.display };
})()`);

const open = async (who) => {
  await page.fixture(FIX(who));
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, `home for ${who}`);
};

try {
  // ── who may see it ───────────────────────────────────────────────────
  r.section("the button is for the people who send reports out");
  await open("rayhanah");
  await page.eval(`window.__app.renderStudentDatabaseButton()`);
  await settle(200);
  r.check("an assistant does not get one",
    await page.eval(`!!document.getElementById("btn-open-ai-translate")`), false);

  await open("daisy");
  await page.eval(`window.__app.renderStudentDatabaseButton()`);
  await settle(200);
  r.check("Ms. Daisy does",
    await page.eval(`!!document.getElementById("btn-open-ai-translate")`), true);

  // ── no Chinese name, no drop zone ────────────────────────────────────
  r.section("a student with no Chinese name cannot be translated");
  await page.eval(`window.__app.openAiTranslateScreen()`);
  await page.until(`!!document.getElementById("tr-student")`, "the student picker");
  r.check("nothing to drop on before a student is picked",
    await page.eval(`!!document.getElementById("tr-drop")`), false);

  await page.eval(`(() => {
    const sel = document.getElementById("tr-student");
    sel.value = "amy";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await settle(300);
  r.check("it says so instead of failing later",
    await page.eval(`!!document.querySelector(".tr-blocked")`), true);
  r.check("and still offers nothing to drop on",
    await page.eval(`!!document.getElementById("tr-drop")`), false);
  r.ok("it names the student",
    await page.eval(`/Amy Lim/.test(document.querySelector(".tr-blocked")?.textContent || "")`),
    "the message does not say who");
  r.check("with a way to go and fix it",
    await page.eval(`!!document.getElementById("tr-goto-db")`), true);

  // ── with a Chinese name ──────────────────────────────────────────────
  r.section("a student who has one gets the drop zone");
  await page.eval(`(() => {
    const sel = document.getElementById("tr-student");
    sel.value = "caden";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await page.until(`!!document.getElementById("tr-drop")`, "the drop zone");
  r.check("no blocking message", await page.eval(`!!document.querySelector(".tr-blocked")`), false);

  const drop = await size("#tr-drop");
  r.ok("the drop zone is actually on screen",
    drop && drop.w > 200 && drop.h > 60 && drop.display !== "none",
    `measured ${JSON.stringify(drop)}`);
  r.ok("it says what to do",
    await page.eval(`/Drop the edited Word report here/.test(document.getElementById("tr-drop").textContent)`),
    "the wording is missing");
  r.ok("and that this is for individual sessions only",
    await page.eval(`/[Ii]ndividual sessions only/.test(document.getElementById("ai-translate-body").textContent)`),
    "the disclaimer is missing");

  // ── what the model is told ───────────────────────────────────────────
  r.section("what the model is told about this student");
  const ins = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "caden");
    return window.__app.translateInstructions(s);
  })()`);
  r.ok("Simplified, never Traditional", /Simplified Chinese only/.test(ins), "not stated");
  r.ok("the child's Chinese name", ins.includes("陈嘉登"), "the full name is missing");
  r.ok("and the short one", ins.includes("嘉登"), "the short name is missing");
  r.ok("ZORA is left in English", /ZORA/.test(ins), "ZORA is not protected");
  // Target names used to be on the leave-in-English list. That kept them in
  // English on every chart, and because a target is called "Play" it also
  // protected that word everywhere else in the report.
  r.ok("target names are listed to be translated, not protected",
    ins.includes("FEDC (1) – 学习目标一")
    && /names of the therapy targets/.test(ins),
    "the target name is not in the list to translate");
  r.ok("with the clinical name kept in brackets after it",
    /模仿（Imitation）/.test(ins), "the bracketed form is not shown");

  // "18 Aug 2026" sat in English in a table on a page of Chinese, because
  // the rule protecting scores and percentages said "dates" as well.
  r.ok("a date is written the Chinese way",
    /2026年8月18日/.test(ins), "no worked example of a date");
  r.ok("and a month and year without a day",
    /2026年8月/.test(ins), "no example of a month and year");
  r.ok("but a figure is still never changed",
    /Never change a figure/.test(ins), "nothing protects the scores");
  r.ok("and dates are no longer told to stay as written",
    !/dates, percentages/.test(ins), "the old rule is still in there");
  r.ok("the word list is sent", /self-regulation = 自我调节/.test(ins), "the glossary is missing");
  r.ok("with Lewis's corrections in it",
    /Trial = 试次/.test(ins) && /transitions = 转换/.test(ins)
    && /occupational therapy = 职能治疗/.test(ins),
    "a corrected term did not make it");
  r.ok("and the rule about split lines", /SAME tags with the SAME numbers/.test(ins),
    "nothing tells it to keep the tags");

  // ── batching and reading the answer ──────────────────────────────────
  r.section("batching, and reading the answer back");
  const batched = await page.eval(`(() => {
    const items = Array.from({ length: 95 }, (_, i) => ({ text: "line " + i }));
    return window.__app.translateChunks(items).map(c => c.length);
  })()`);
  r.ok("long reports are split into batches",
    batched.length > 1 && batched.every(n => n <= 40) && batched.reduce((a, b) => a + b, 0) === 95,
    `batches were ${JSON.stringify(batched)}`);

  r.check("the answer is read by its numbers, not by line order",
    await page.eval(`window.__app.translateParseReply("[2] 二\\n[1] 一\\n[3] 三", 3)`),
    ["一", "二", "三"]);
  r.check("a translation that runs onto a second line is kept whole",
    await page.eval(`window.__app.translateParseReply("[1] 一\\n继续\\n[2] 二", 2)`),
    ["一\n继续", "二"]);
  r.check("a missing line comes back as missing, not as something else",
    await page.eval(`window.__app.translateParseReply("[1] 一", 2)`), ["一", null]);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("ai-translator-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
