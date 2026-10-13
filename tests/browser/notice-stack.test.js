// Two notices in the corner, one above the other.
//
// The report generator's pill and the translator's were both fixed to the
// bottom-right corner, and the report's sat higher. So finishing a
// translation while an old "Done!" was still on screen looked like nothing
// had happened: the new notice was behind the old one.
//
// They share one stack now, and one component -- the translator used to
// show a line of text saying "batch 4 of 10", which means nothing to
// anybody who has not read the code.
//
//   deno run -A tests/browser/notice-stack.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: notice-stack.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 300) => new Promise(res => setTimeout(res, ms));

const box = (sel) => page.eval(`(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const b = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width),
           h: Math.round(b.height), display: cs.display,
           text: el.textContent.replace(/\\s+/g, " ").trim() };
})()`);

try {
  await page.fixture({
    today: "2026-10-13", authUser: "daisy",
    students: [{ id: "qipei", name: "Zhang Qi Pei", order: 1, preferredName: "QiPei",
                 nameZh: "张其佩", targets: [] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  r.section("the report's notice, finished and still on screen");
  await page.eval(`window.__app.aiPillShow("Done! → QiPei (Monthly Report)", "done", 100)`);
  await settle();
  const report = await box("#ai-report-pill");
  r.ok("it is showing", report && report.display !== "none", JSON.stringify(report));

  r.section("a translation starts while it is still there");
  await page.eval(`window.__app.trPill("Translating into Chinese…", null, 40)`);
  await settle();
  const trans = await box("#tr-pill");
  r.ok("the second notice is showing too", trans && trans.display !== "none", JSON.stringify(trans));
  r.ok("and it has a real size, so it is not hidden behind the first",
    trans && trans.w > 100 && trans.h > 20, JSON.stringify(trans));

  r.section("they stack rather than overlap");
  // Measured again, both of them. Adding the second notice pushes the first
  // one up, so the position taken before it existed is already out of date.
  const [a, b] = [await box("#ai-report-pill"), await box("#tr-pill")];
  const report2 = a, trans2 = b;
  const overlap = report2.y < trans2.y + trans2.h && trans2.y < report2.y + report2.h;
  r.ok("no overlap", !overlap,
    `report at y=${report2.y}..${report2.y + report2.h}, `
    + `translation at y=${trans2.y}..${trans2.y + trans2.h}`);
  r.ok("the newer one is nearer the corner", trans2.y > report2.y,
    `report y=${report2.y}, translation y=${trans2.y}`);
  r.ok("both are in the corner together",
    Math.abs((report2.x + report2.w) - (trans2.x + trans2.w)) < 4,
    `right edges ${report2.x + report2.w} and ${trans2.x + trans2.w}`);

  r.section("the translator shows a percentage, not a batch count");
  r.ok("no batch wording anywhere in it", !/batch/i.test(trans.text), `reads "${trans.text}"`);
  const ring = await page.eval(`(() => {
    const el = document.querySelector("#tr-pill .ai-pill-ring");
    if (!el) return null;
    return { pct: el.style.getPropertyValue("--pct"),
             label: el.textContent.trim(),
             shown: getComputedStyle(el).display !== "none" };
  })()`);
  r.ok("there is a ring", !!ring && ring.shown, JSON.stringify(ring));
  r.check("it is filled to the right place", ring.pct, "40%");
  r.check("and says so in the middle", ring.label, "40%");

  r.section("when it finishes");
  await page.eval(`window.__app.trPill("Done! → QiPei (Chinese)", "done", 100)`);
  await settle();
  const done = await box("#tr-pill");
  r.ok("it says which report and in what", /QiPei/.test(done.text) && /Chinese/.test(done.text),
    `reads "${done.text}"`);
  r.ok("the report's notice is still there beside it",
    (await box("#ai-report-pill"))?.display !== "none", "the first notice vanished");
  r.check("the ring is gone once there is nothing left to count",
    await page.eval(`getComputedStyle(document.querySelector("#tr-pill .ai-pill-ring")).display`),
    "none");

  r.section("the corner does not swallow clicks when it is empty");
  await page.eval(`window.__app.trPillHide(); window.__app.aiPillHide();`);
  await settle();
  r.check("the stack itself ignores the mouse",
    await page.eval(`getComputedStyle(document.getElementById("notice-stack")).pointerEvents`),
    "none");

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("notice-stack-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
