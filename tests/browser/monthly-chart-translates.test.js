// The monthly report's score chart can be turned into Chinese.
//
// Lewis kept getting an English chart in a Chinese report. The cause was
// that his English report predated chart tagging, so there was nothing in
// the file to redraw from -- but saying so took three rounds of guessing.
// This builds a real monthly report with the app's own code and walks the
// whole path: the chart carries its data, the data is found, it redraws in
// Chinese, and the picture it replaces can be located in the zip.
//
//   deno run -A tests/browser/monthly-chart-translates.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: monthly-chart-translates.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

try {
  await page.fixture({
    today: "2026-10-17", authUser: "daisy",
    students: [{ id: "st1", name: "Test Child", order: 1, preferredName: "Test",
      gender: "male",
      targets: [
        { id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: [
          { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" }] },
        { id: "t2", name: "Self Help Skills", scale: 3, predefinedActivities: [
          { id: "a2", title: "Take off Shoes", name: "", order: 0, createdOn: "2026-01-01" }] },
      ] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");

  const out = await page.eval(`(async () => {
    const s = window.__app.state;
    s.currentStudent = s.students.find(x => x.id === "st1");
    const threeMonthData = {
      "FEDC 1": { labels: ["Jun","Jul","Aug"], avgs: [70, 80, 84], trend: "up" },
      "Self Help Skills": { labels: ["Jun","Jul","Aug"], avgs: [60, 70, 86], trend: "up" },
    };
    const miniData = {
      "FEDC 1": { lastMonthLabel: "Jul", lastMonthAvg: 80, thisMonthLabel: "Aug", thisMonthAvg: 84 },
      "Self Help Skills": { lastMonthLabel: "Jul", lastMonthAvg: 70, thisMonthLabel: "Aug", thisMonthAvg: 86 },
    };
    const parsed = { highlights: ["Something good"], stillWorking: ["Something else"],
      comparison: "Steady.", nextSteps: ["More of the same"] };
    let blob = null;
    const real = URL.createObjectURL;
    URL.createObjectURL = (b) => { blob = b; return real.call(URL, b); };
    try {
      await window.__app.monthlyDownloadWord(s.currentStudent, 2026, 8, "August", 7,
        threeMonthData, miniData, parsed,
        [{ target: "Self Help Skills", activity: "Take off Shoes", date: "2026-08-18" }],
        "Compared with last month");
    } catch (e) { return { error: e.message }; }
    finally { URL.createObjectURL = real; }
    if (!blob) return { error: "no report was produced" };
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
    const xml = await zip.file("word/document.xml").async("string");
    window.__lastMonthlyXml = xml;
    const pics = window.__app.findChartPictures(xml);
    const pic = pics[0];
    const zhNames = { "FEDC 1": "功能性情绪发展能力（FEDC 1）",
                      "Self Help Skills": "自理技能（Self Help Skills）" };
    const drawn = pic ? window.__app.redrawChartZh(pic.spec, (k) => zhNames[k] || null) : null;
    const en = pic ? window.__app.redrawChartZh(pic.spec, () => null) : null;
    const media = drawn && drawn.base64
      ? await window.__app.chartMediaPath(zip, "word/document.xml", pic.rid) : null;
    return {
      tagged: pics.length,
      kind: pic && pic.spec && pic.spec.kind,
      rowNames: pic ? (pic.spec.rows || []).map(x => x.name) : [],
      redrew: !!(drawn && drawn.base64),
      differs: !!(drawn && en && drawn.base64 !== en.base64),
      media,
    };
  })()`, 120000);

  r.ok("the report was built", !out.error, String(out.error));

  r.section("the chart carries what it is made of");
  r.check("exactly one chart in the report is tagged", out.tagged, 1);
  r.check("and it says what kind it is", out.kind, "monthlyBars");
  // Without these the redraw has no names to put on the bars.
  r.check("with every target on it", (out.rowNames || []).slice().sort(),
    ["FEDC 1", "Self Help Skills"]);

  r.section("and it can be drawn again in Chinese");
  r.ok("it redrew", out.redrew === true, JSON.stringify(out));
  r.ok("and the Chinese one is a different picture", out.differs === true, JSON.stringify(out));
  // Without this the new picture has nowhere to go and the chart stays English.
  r.ok("the picture it replaces was found in the file",
    /^word\/media\//.test(out.media || ""), String(out.media));

  // The Target column was the only one left-aligned, in the English report as
  // well as the Chinese. Read out of the real file rather than from the code.
  r.section("the mastered-activities table");

  const table = await page.eval(`(() => {
    const xml = window.__lastMonthlyXml || "";
    // The cell holding the target name is the one that spans its group.
    const i = xml.lastIndexOf("Self Help Skills");
    if (i < 0) return { missing: true };
    const cell = xml.slice(xml.lastIndexOf("<w:tc", i), i);
    return { centred: cell.includes('<w:jc w:val="center"/>'), len: cell.length };
  })()`);
  r.ok("the target name is centred", table.centred === true, JSON.stringify(table));

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
