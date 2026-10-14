// Redrawing an Activity Breakdown chart in Chinese.
//
// A chart is a picture, so the text swapping cannot touch it. Since v2243
// each chart carries the data that drew it, so the picture is thrown away
// and a new one drawn from the same numbers with Chinese labels.
//
// The pure parts of that are tested without a browser. This is the rest:
// drawing on a real canvas, finding the picture's file inside the zip,
// replacing its bytes and resizing the slot it sits in. None of it had ever
// actually run before this test existed.
//
//   deno run -A tests/browser/chart-redraw.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: chart-redraw.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

// A target with the long clinical names the real reports carry.
const SPEC = {
  target: "FEDC 2",
  title: "3) FEDC 2 - Progress (Jan 2026 - Jun 2026)",
  range: "Jan 2026 - Jun 2026",
  legend: ["Start of Term/Trendline", "End of Term/Trendline"],
  data: [
    { isSectionHeader: true, label: "Stage 2: Engagement & Relating" },
    { name: "Responds to your overtures", earliestAvg: 78, latestAvg: 89 },
    { name: "Responds to your overtures with curiosity and assertive interest",
      earliestAvg: 81, latestAvg: 91 },
    { name: "Recover from distress with 15mins with your help", earliestAvg: 100, latestAvg: 39 },
  ],
};

const ZH = {
  "FEDC 2": "学习目标二",
  "Stage 2: Engagement & Relating": "第二阶段：参与与关系建立",
  "Responds to your overtures": "回应你的主动接触",
  "Responds to your overtures with curiosity and assertive interest":
    "带着好奇和主动的兴趣回应你的接触",
  "Recover from distress with 15mins with your help":
    "在你的协助下于十五分钟内从情绪困扰中恢复",
};

try {
  await page.fixture({ today: "2026-10-14", authUser: "daisy", students: [], groups: [], sessions: [] });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  r.section("the chart draws at all, in both languages");
  const drawn = await page.eval(`(() => {
    const spec = ${JSON.stringify(SPEC)};
    const zh = ${JSON.stringify(ZH)};
    const en = window.__app.redrawChartZh(spec, () => null);        // nothing translated
    const cn = window.__app.redrawChartZh(spec, (k) => zh[k] || null);
    return {
      enH: en?.height || 0, cnH: cn?.height || 0,
      enLen: (en?.base64 || "").length, cnLen: (cn?.base64 || "").length,
      same: en?.base64 === cn?.base64,
    };
  })()`, 60000);
  r.ok("an English chart is produced", drawn.enH > 0 && drawn.enLen > 500, JSON.stringify(drawn));
  r.ok("a Chinese one is too", drawn.cnH > 0 && drawn.cnLen > 500, JSON.stringify(drawn));
  r.ok("and they are not the same picture", !drawn.same, "the Chinese chart came out identical");

  r.section("a long Chinese label wraps instead of running over the bars");
  // Chinese has no spaces. Wrapping on spaces alone left a whole sentence on
  // one line however wide it was, straight over the bars beside it. A label
  // too wide for its column must make the chart taller, because it has to
  // take a second line.
  const wrapped = await page.eval(`(() => {
    const spec = ${JSON.stringify(SPEC)};
    const short = "回应";
    const long = "回应".repeat(40);
    const chart = (label) => window.__app.redrawChartZh(
      { ...spec, data: [{ name: "x", earliestAvg: 50, latestAvg: 60 }] },
      (k) => (k === "x" ? label : null));
    const c = document.createElement("canvas").getContext("2d");
    c.font = "13px sans-serif";
    return {
      shortH: chart(short)?.height || 0,
      longH: chart(long)?.height || 0,
      longWidth: Math.round(c.measureText(long).width),
    };
  })()`, 60000);
  r.ok("the long label is far wider than its column",
    wrapped.longWidth > 349, `it measures ${wrapped.longWidth}px, the column is 349px`);
  r.ok("so it takes more than one line and the chart grows",
    wrapped.longH > wrapped.shortH,
    `short label ${wrapped.shortH}px tall, long label ${wrapped.longH}px -- `
    + `the same height means it never wrapped`);

  r.section("the Chinese renders as characters, not empty boxes");
  // If the browser had no font with Chinese in it the labels would come out
  // as tofu, and it would be baked into the picture where nobody could fix
  // it. A character that draws nothing measures nothing.
  const glyphs = await page.eval(`(() => {
    const c = document.createElement("canvas").getContext("2d");
    c.font = "13px sans-serif";
    return { zh: Math.round(c.measureText("回应").width),
             en: Math.round(c.measureText("ab").width) };
  })()`);
  r.ok("Chinese characters have real width", glyphs.zh > 0, JSON.stringify(glyphs));
  r.ok("and are wider than two latin letters, as they should be",
    glyphs.zh > glyphs.en, JSON.stringify(glyphs));

  r.section("swapping the picture inside a real .docx");
  const swap = await page.eval(`(async () => {
    const { Document, Packer, Paragraph, ImageRun } = window.docx;
    const spec = ${JSON.stringify(SPEC)};
    const zh = ${JSON.stringify(ZH)};

    const original = window.__app.redrawChartZh(spec, () => null);
    const bytes = Uint8Array.from(atob(original.base64), c => c.charCodeAt(0));
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [
      new ImageRun({ data: bytes, transformation: { width: 600, height: Math.round(600 * original.height / 760) },
        type: "png", altText: { name: "Activity Breakdown", title: "",
          description: window.__app.chartDataTag(spec) } })
    ] })] }] });
    const zip = await JSZip.loadAsync(await (await Packer.toBlob(doc)).arrayBuffer());

    let xml = await zip.file("word/document.xml").async("string");
    const pics = window.__app.findChartPictures(xml);
    if (!pics.length) return { error: "no chart found in the document" };

    const pic = pics[0];
    const media = await window.__app.chartMediaPath(zip, "word/document.xml", pic.rid);
    if (!media) return { error: "could not find the picture's file" };
    const before = (await zip.file(media).async("uint8array")).length;

    const cn = window.__app.redrawChartZh(spec, (k) => zh[k] || null);
    zip.file(media, cn.base64, { base64: true });
    const after = (await zip.file(media).async("uint8array")).length;

    const cxBefore = Number(/<wp:extent[^>]*cx="(\\d+)"/.exec(pic.block)[1]);
    const cyBefore = Number(/<wp:extent[^>]*cy="(\\d+)"/.exec(pic.block)[1]);
    const resized = window.__app.resizeDrawingToChart(pic.block, cn.height);
    const cxAfter = Number(/<wp:extent[^>]*cx="(\\d+)"/.exec(resized)[1]);
    const cyAfter = Number(/<wp:extent[^>]*cy="(\\d+)"/.exec(resized)[1]);

    xml = xml.slice(0, pic.start) + resized + xml.slice(pic.end);
    zip.file("word/document.xml", xml);
    const out = await zip.generateAsync({ type: "uint8array" });
    const reread = await JSZip.loadAsync(out);
    const stillThere = window.__app.findChartPictures(
      await reread.file("word/document.xml").async("string")).length;

    return { media, before, after, cxBefore, cxAfter, cyBefore, cyAfter,
             stillThere, cnHeight: cn.height,
             // Folder entries are listed too, so only real files are counted.
             mediaCount: Object.values(reread.files)
               .filter(f => !f.dir && f.name.startsWith("word/media/")).length,
             mediaNames: Object.values(reread.files)
               .filter(f => f.name.startsWith("word/media/")).map(f => f.name + (f.dir ? "/" : "")) };
  })()`, 90000);

  r.ok("no error", !swap.error, String(swap.error));
  r.ok("the picture's file was found", /^word\/media\//.test(swap.media || ""), String(swap.media));
  r.ok("its bytes really changed", swap.before !== swap.after,
    `${swap.before} bytes before, ${swap.after} after`);
  r.check("and there is still exactly one picture", swap.mediaCount, 1);
  if (swap.mediaCount !== 1) console.log("        entries:", swap.mediaNames);
  r.check("the chart is still findable afterwards", swap.stillThere, 1);

  r.section("the slot is resized, not stretched");
  r.check("the width is untouched, so it still fits the page", swap.cxAfter, swap.cxBefore);
  r.ok("the height changed to match the new chart", swap.cyAfter !== swap.cyBefore,
    `${swap.cyBefore} then ${swap.cyAfter}`);
  r.ok("and it is in proportion with the picture",
    Math.abs(swap.cyAfter - Math.round(swap.cxAfter * swap.cnHeight / 760)) <= 1,
    `height ${swap.cyAfter}, expected ${Math.round(swap.cxAfter * swap.cnHeight / 760)}`);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 160)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
