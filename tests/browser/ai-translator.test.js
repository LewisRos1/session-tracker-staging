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
  r.section("the button is there for everyone, and locked for most");
  await open("rayhanah");
  await page.eval(`window.__app.renderStudentDatabaseButton()`);
  await settle(200);
  // It used to be hidden from an assistant outright, while the AI Report
  // Generator next to it was shown and locked. Lewis asked why the two
  // behaved differently; they no longer do. The lock itself is what keeps
  // her out, and it is checked in assistant-readonly.test.js.
  r.check("an assistant can see it",
    await page.eval(`!!document.getElementById("btn-open-ai-translate")`), true);
  r.check("just as she sees the AI Report Generator",
    await page.eval(`!!document.getElementById("btn-open-ai-report")`), true);

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
  // "instructor" and "teacher" were unpinned, so one report called the same
  // person 指导员 and 老师 in different paragraphs.
  r.ok("one word for the adult, every time",
    /instructor = 老师/.test(ins) && /teacher = 老师/.test(ins)
    && /Never 指导员/.test(ins),
    "the adult is still free to be named two ways");
  r.ok("with Lewis's corrections in it",
    /Trial = 试次/.test(ins) && /transitions = 转换/.test(ins)
    && /occupational therapy = 职能治疗/.test(ins),
    "a corrected term did not make it");
  r.ok("and the rule about split lines", /SAME tags with the SAME numbers/.test(ins),
    "nothing tells it to keep the tags");

  // The prompt was rewritten to Lewis's spec in v2276. The machinery above
  // still has to be in it; these are the new style rules it brought in.
  r.ok("the worked examples teach the style, not just the rule",
    ins.includes("这说明他越来越能准确地找出相同的图片")
    && ins.includes("他可能正开始学习独立完成日常穿脱衣物的部分步骤")
    && ins.includes("他正慢慢学会在同伴加入时主动与对方击掌互动"),
    "a worked example is missing");
  r.ok("a hedge may not harden into a fact", /Keep hedges as hedges/.test(ins),
    "nothing protects \"suggests\" and \"may\"");
  // Lewis asked for short explanations of technical terms. Unfenced, that
  // is a licence to add claims the English never made.
  r.ok("explaining a term is allowed", /EXPLAINING A TECHNICAL TERM/.test(ins),
    "the section is missing");
  r.ok("but only where the English explained it too",
    /Mirror the English, exactly/.test(ins)
    && /do not explain it either/.test(ins)
    && /must say the same amount/.test(ins),
    "the explanation rule is not tied to the English");
  // Lewis asked for the opposite of the old rule here: a bracket the English
  // wrote is part of what the English says, so dropping it loses meaning.
  r.ok("a bracket the English wrote is kept, not dropped",
    /KEEP both and translate both naturally/.test(ins)
    && /Never drop the bracket just because it repeats/.test(ins),
    "nothing protects the English's own bracketed explanations");
  r.ok("and the closer rendering wins when both are good Chinese",
    /Stay as close to the English as you can/.test(ins)
    && /never introduce a new interpretation/.test(ins)
    && /choose the closer one/.test(ins),
    "the minimal-change rule is missing");

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

  // ── the English note, drawn ──────────────────────────────────────────
  // The XML builder is covered without a browser; this is the half that
  // needs a real canvas. If it ever returns null the translator quietly
  // falls back to text, and the text is what Word cuts in half.
  r.section("the English note is drawn as a picture");
  const png = await page.eval(`(() => {
    const img = window.__app.renderNoteImagePng(
      window.__app.TRANSLATED_NOTE_EN, window.__app.docTextWidthPx(
        '<w:pgSz w:w="11906"/><w:pgMar w:left="1440" w:right="1440"/>'));
    if (!img || !img.base64) return null;
    const b = atob(img.base64);
    return { lines: img.lines, width: img.width, height: img.height,
             bytes: b.length, png: b.charCodeAt(0) === 0x89 && b.slice(1, 4) === "PNG" };
  })()`);
  r.ok("something came back", !!png, "renderNoteImagePng returned null");
  r.ok("it really is a PNG", !!png && png.png, JSON.stringify(png));
  r.ok("the full width of the text column", !!png && png.width === 602,
    JSON.stringify(png));
  r.ok("wrapped onto a few lines, not one",
    !!png && png.lines >= 2 && png.lines <= 6, JSON.stringify(png));
  r.ok("tall enough to hold them",
    !!png && png.height > 20 && png.height < 160, JSON.stringify(png));
  r.ok("and has real pixels in it", !!png && png.bytes > 500, JSON.stringify(png));

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
