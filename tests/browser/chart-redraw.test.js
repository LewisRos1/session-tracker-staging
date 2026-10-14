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

  // ── the other three kinds of chart ───────────────────────────────────
  // The report has four. Only the Activity Breakdown was handled at first,
  // and saying "the last English thing" about it was wrong.
  r.section("every kind of chart can be drawn again");
  const kinds = await page.eval(`(() => {
    const zh = { "FEDC 2": "学习目标二", "Self-Regulation": "自我调节" };
    const lookup = (k) => zh[k] || null;
    const out = {};
    const draw = (name, spec) => {
      try {
        const en = window.__app.redrawChartZh(spec, () => null);
        const cn = window.__app.redrawChartZh(spec, lookup);
        out[name] = { drew: !!(en?.base64 && cn?.base64), differs: en?.base64 !== cn?.base64,
                      height: cn?.height || 0, fixedSize: !!cn?.fixedSize };
      } catch (e) { out[name] = { error: e.message }; }
    };
    draw("overview", { kind: "overview", baseW: 700, title: "Caden (Jan 2026 - Jun 2026 Progress)",
      titleZh: "Caden（Jan 2026 - Jun 2026）",
      rows: [{ name: "FEDC 2", delta: 12, tStart: 70, tEnd: 82 },
             { name: "Self-Regulation", delta: -10, tStart: 80, tEnd: 70 }] });
    draw("line", { kind: "line", target: "FEDC 2", labels: ["Jan", "Feb", "Mar"],
      values: [70, 75, 82], period: "h1", year: 2026, tStart: 70, tEnd: 82,
      delta: 12, direction: "Improving" });
    draw("monthlyBars", { kind: "monthlyBars", baseW: 700,
      rows: [{ name: "FEDC 2", score: 82 }, { name: "Self-Regulation", score: 64 }] });
    draw("unknown", { kind: "something-added-later" });
    return out;
  })()`, 90000);

  for (const k of ["overview", "line", "monthlyBars"]) {
    r.ok(`${k}: drew in both languages`, kinds[k]?.drew === true, JSON.stringify(kinds[k]));
    r.ok(`${k}: the Chinese one is a different picture`, kinds[k]?.differs === true,
      JSON.stringify(kinds[k]));
  }
  r.ok("a line chart is marked fixed size, so its slot is left alone",
    kinds.line?.fixedSize === true, JSON.stringify(kinds.line));
  r.ok("a kind this code does not know is refused, not guessed at",
    kinds.unknown?.drew === false || !!kinds.unknown?.error === false,
    JSON.stringify(kinds.unknown));

  r.section("the words those charts carry");
  const phrases = await page.eval(`(() => ({
    overview: window.__app.chartPhrases({ kind: "overview",
      rows: [{ name: "FEDC 2" }, { name: "Self-Regulation" }] }),
    monthly: window.__app.chartPhrases({ kind: "monthlyBars", rows: [{ name: "FEDC 2" }] }),
    line: window.__app.chartPhrases({ kind: "line", target: "FEDC 2" }),
  }))()`);
  r.check("the overview asks for every target on it", phrases.overview, ["FEDC 2", "Self-Regulation"]);
  r.check("so does the monthly chart", phrases.monthly, ["FEDC 2"]);
  r.check("and a line chart asks for its own target", phrases.line, ["FEDC 2"]);

  // ── the direction words ──────────────────────────────────────────────
  // The overview chart coloured these and the line charts drew the same
  // three words in flat grey, so the same fact was green on one page and
  // grey on the next.
  r.section("Improving, Declining and Stable look the same wherever they appear");
  const dirs = await page.eval(`(() => {
    const m = window.__app.HYR_DIRECTION;
    const of = window.__app.hyrDirectionOf;
    return { map: m, up: of(20), down: of(-20), flat: of(0), edgeUp: of(8), edgeDown: of(-8) };
  })()`);
  r.check("improving is green", dirs.map?.Improving?.color, "#16a34a");
  r.check("declining is red", dirs.map?.Declining?.color, "#dc2626");
  r.check("stable is grey", dirs.map?.Stable?.color, "#6b7280");
  r.check("and the arrows match the words",
    [dirs.map?.Improving?.icon, dirs.map?.Declining?.icon, dirs.map?.Stable?.icon],
    ["↑", "↓", "→"]);
  r.section("and the line between them");
  r.check("a clear rise is improving", dirs.up, "Improving");
  r.check("a clear fall is declining", dirs.down, "Declining");
  r.check("no real movement is stable", dirs.flat, "Stable");
  r.check("exactly 8 is still stable, not improving", dirs.edgeUp, "Stable");
  r.check("and minus 8 is still stable", dirs.edgeDown, "Stable");

  // The overview chart's colours were only half the job: the line chart
  // picked its colour from the same map but was handed an already-translated
  // word, so the lookup missed and every Chinese line chart came out grey.
  // Asking whether the picture "differs" never caught that, so this watches
  // what is actually painted onto the canvas.
  r.section("what a Chinese line chart actually paints");
  const painted = await page.eval(`(() => {
    const spec = { kind: "line", target: "FEDC 2", labels: ["Jan", "Feb", "Mar"],
      values: [70, 75, 82], period: "h1", year: 2026, tStart: 70, tEnd: 82,
      delta: 12, direction: "Improving" };
    const zh = (k) => ({ "FEDC 2": "学习目标二" })[k] || null;
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    const grab = (draw) => {
      const calls = [];
      proto.fillText = function (t) { calls.push({ text: String(t), fill: String(this.fillStyle) }); return orig.apply(this, arguments); };
      try { draw(); } finally { proto.fillText = orig; }
      return calls;
    };
    // The Chinese chart, and the ordinary English one drawn the way a normal
    // report draws it -- not through the translator.
    const cn = grab(() => window.__app.redrawChartZh(spec, zh));
    const en = grab(() => window.__app.hyrDrawLineChart(spec.target, spec.labels,
      spec.values, spec.period, spec.year, spec.tStart, spec.tEnd, spec.delta, spec.direction));
    // The overview chart is the one whose colours the boss pointed at.
    const ov = grab(() => window.__app.redrawChartZh({ kind: "overview", baseW: 700,
      title: "Caden", titleZh: "Caden",
      rows: [{ name: "FEDC 2", delta: 12, tStart: 70, tEnd: 82 }] }, zh));
    const find = (calls, needle) => calls.find(c => c.text.indexOf(needle) >= 0) || null;
    const months = (calls) => calls
      .filter(c => ["Jan", "Feb", "Mar", "Jun", "Dec"].some(m => c.text.indexOf(m) >= 0))
      .map(c => c.text);
    return {
      cnStatus: find(cn, "进步中"),
      ovStatus: find(ov, "进步中"),
      enStatus: find(en, "Improving"),
      cnTitle: (find(cn, "学习目标二") || {}).text || "",
      cnMonths: months(cn),
      ovLegend: ov.filter(c => /趋势线|Trendline/.test(c.text)).map(c => c.text),
      enTitle: (find(en, "FEDC 2") || {}).text || "",
      enMonths: months(en),
    };
  })()`, 90000);

  r.ok("the Chinese chart says the Chinese word for Improving",
    !!painted.cnStatus, JSON.stringify(painted.cnStatus));
  r.check("and paints it green, not grey", painted.cnStatus?.fill, "#16a34a");
  r.check("the same green the overview chart paints the same word",
    painted.ovStatus?.fill, painted.cnStatus?.fill);
  r.check("and the English chart was always that green", painted.enStatus?.fill, "#16a34a");
  r.ok("the title carries Chinese months, not English ones",
    painted.cnTitle.indexOf("2026年 1月") >= 0, painted.cnTitle);
  r.check("and no English month is left anywhere on it", painted.cnMonths, []);
  r.ok("while the English chart still reads in English",
    painted.enTitle.indexOf("Jan 2026") >= 0, painted.enTitle);
  r.ok("with its own month labels intact", painted.enMonths.length >= 3,
    JSON.stringify(painted.enMonths));

  // The legend was written straight onto the canvas rather than going through
  // the word list, so it stayed English under a chart whose every heading had
  // been swapped.
  r.ok("the overview chart's legend is Chinese too",
    painted.ovLegend.length === 2 && painted.ovLegend.every(t => /[一-鿿]/.test(t)),
    JSON.stringify(painted.ovLegend));

  // A Chinese target name is longer than its English one and has no spaces in
  // it, so the old wrap kept it on one line and it ran off the left edge of
  // the chart: 功能性情绪发展能力第3阶段（FEDC 3）arrived with its first four
  // characters missing. This asks the canvas where the text actually landed.
  r.section("a long Chinese name stays inside the chart");
  const fitted = await page.eval(`(() => {
    const long = "功能性情绪发展能力第3阶段（FEDC 3）";
    const proto = CanvasRenderingContext2D.prototype;
    const origText = proto.fillText, origMeasure = proto.measureText;
    const drawn = [];
    proto.fillText = function (t, x) {
      // Right-aligned, so the left edge is x minus the width of the text.
      drawn.push({ text: String(t), right: x, width: origMeasure.call(this, String(t)).width, font: this.font });
      return origText.apply(this, arguments);
    };
    try {
      window.__app.redrawChartZh({ kind: "overview", baseW: 700, title: "T", titleZh: "T",
        rows: [{ name: long, delta: 12, tStart: 70, tEnd: 82 }] }, () => null);
    } finally { proto.fillText = origText; }
    const parts = drawn.filter(d => long.indexOf(d.text) >= 0 && d.text.length > 1);
    return {
      pieces: parts.map(p => p.text),
      leftMost: Math.min(...parts.map(p => p.right - p.width)),
      rightMost: Math.max(...parts.map(p => p.right)),
    };
  })()`, 90000);

  r.ok("the name was broken into more than one line",
    fitted.pieces.length > 1, JSON.stringify(fitted.pieces));
  r.ok("with nothing lost off the end of it",
    fitted.pieces.join("").replace(/\s/g, "")
      === "\u529f\u80fd\u6027\u60c5\u7eea\u53d1\u5c55\u80fd\u529b\u7b2c3\u9636\u6bb5\uff08FEDC3\uff09",
    JSON.stringify(fitted.pieces));
  // The boss asked for white space between the words and the border.
  r.ok("it does not touch the left border", fitted.leftMost >= 10,
    `nearest edge was ${Math.round(fitted.leftMost)}px from it`);
  r.ok("nor the bars on its right", fitted.rightMost <= 195 - 8,
    `reached ${Math.round(fitted.rightMost)}px`);

  r.section("a student's note follows them onto the file");
  const labels = await page.eval(`(() => {
    const s = { name: "Zhang Qi Pei", note: "EIP" };
    return {
      plain:   window.__app.studentLabel(s),
      file:    window.__app.studentFileLabel(s),
      none:    window.__app.studentFileLabel({ name: "Ryan Lee", note: "" }),
      wrapped: window.__app.studentLabel({ name: "Hiew Cheng Yu", note: "(Assessment)" }),
      nasty:   window.__app.studentFileLabel({ name: "Mon/Wed", note: "a:b?c" }),
    };
  })()`);
  r.check("on screen", labels.plain, "Zhang Qi Pei (EIP)");
  r.check("and on the file", labels.file, "Zhang Qi Pei (EIP)");
  r.check("no note, no brackets", labels.none, "Ryan Lee");
  r.check("a note typed with its own brackets is not doubled",
    labels.wrapped, "Hiew Cheng Yu (Assessment)");
  // A note is free text, and Windows refuses these in a file name: a download
  // carrying one just quietly fails.
  r.check("characters Windows will not accept are taken out",
    labels.nasty, "Mon Wed (a b c)");

  r.section("the fixed chart words only turn Chinese while a Chinese chart is drawn");
  const words = await page.eval(`(() => {
    const before = window.__app.chartWord("Status");
    let during = null;
    window.__app.redrawChartZh({ kind: "monthlyBars", baseW: 700,
      rows: [{ name: "x", score: 50 }] }, () => { during = window.__app.chartWord("Status"); return null; });
    return { before, during, after: window.__app.chartWord("Status") };
  })()`);
  r.check("English before", words.before, "Status");
  r.check("English again afterwards, so a normal report is unaffected", words.after, "Status");

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
