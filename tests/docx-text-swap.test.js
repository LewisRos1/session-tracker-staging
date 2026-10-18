// Swapping the text inside a .docx without disturbing anything else.
//
// A .docx is a zip of XML, and everything that makes the report look like
// the report -- tables, headings, the stamp, the charts, page breaks --
// lives in that XML beside the words. So the translator does not rebuild the
// document. It replaces the text nodes and leaves every byte around them
// alone. These tests hold that line: whatever goes in, the only thing that
// may differ on the way out is the text.
//
// The functions are pulled straight out of app.js rather than copied.
//
//   deno run --allow-read tests/docx-text-swap.test.js

const src = await Deno.readTextFile("app.js");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}

const names = ["xmlUnescape", "xmlEscape", "docxParagraphs", "markParagraph",
               "unmarkParagraph", "joinWrappedLines", "keepRunSpacing",
               "readChartDataTag", "findChartPictures", "chartPhrases",
               "stripMarkers", "translateTargetNames", "tieChineseDate",
               "pinnedTermZh",
               "addTranslatedNote", "firstPageBreakParagraph",
               "periodLabelZh", "chartTitleZh", "overviewTitleZh",
               "overviewChartTitle",
               "resizeDrawingToChart",
               "applyDocxText"];
const tagPrefix = src.match(/const CHART_TAG_PREFIX = "([^"]+)";/)[1];
const tagFn = src.match(/const chartDataTag = [^;]+;/)[0];
const consts = ["CHART_FIXED_ZH", "MONTHS_ZH"]
  .map(n => src.match(new RegExp(`const ${n} = \\{[\\s\\S]*?\\n};`))[0])
  .join("\n");
const cjk = src.match(/const isCjkChar = [^;]+;/)[0];
const pbConst = src.match(/const PAGE_BREAK_BEFORE = [^;]+;/)[0];
const noteConst = ["TRANSLATED_NOTE_ZH", "TRANSLATED_NOTE_EN"]
  .map(n => src.match(new RegExp(`const ${n} = "[^"]*";`))[0]).join("\n");
const chineseFns = [/const hasChinese = [^;]+;/, /const looksTranslated =[\s\S]*?;/]
  .map(re => src.match(re)[0]).join("\n");
const fns = new Function(`const CHART_TAG_PREFIX = ${JSON.stringify(tagPrefix)};`
  + tagFn + "\n" + consts + "\n" + cjk + "\n" + chineseFns + "\n" + noteConst + "\n" + pbConst + "\n"
  + names.map(extract).join("\n")
  + `\nreturn { chartDataTag, hasChinese, looksTranslated, ${names.join(", ")} };`)();
const { xmlUnescape, docxParagraphs, markParagraph, unmarkParagraph,
        joinWrappedLines, keepRunSpacing, readChartDataTag,
        findChartPictures, chartPhrases, periodLabelZh, chartTitleZh,
        resizeDrawingToChart, applyDocxText, stripMarkers,
        hasChinese, looksTranslated, overviewTitleZh, overviewChartTitle,
        translateTargetNames, tieChineseDate, addTranslatedNote,
        pinnedTermZh } = fns;

let failed = 0;
const check = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        want ${w}\n        got  ${g}`}`);
};

// A paragraph the way Word actually writes one.
const para = (...runs) =>
  `<w:p w:rsidR="00A"><w:pPr><w:spacing w:after="0"/></w:pPr>`
  + runs.map(t => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`).join("")
  + `</w:p>`;

console.log("\nreading the text out");
{
  const xml = `<w:body>${para("Hello there")}</w:body>`;
  const ps = docxParagraphs(xml);
  check("one paragraph", ps.length, 1);
  check("one run", ps[0].runs.length, 1);
  check("its words", ps[0].runs[0].text, "Hello there");
}
{
  // The shape the reports are full of: a bold label, then the sentence.
  const xml = `<w:body>${para("Calming Himself", ": Caden needed support.")}</w:body>`;
  const ps = docxParagraphs(xml);
  check("a bold label and its sentence are two runs", ps[0].runs.length, 2);
  check("read in order",
    ps[0].runs.map(r => r.text), ["Calming Himself", ": Caden needed support."]);
}
{
  const xml = `<w:body>${para("  ")}${para("real")}</w:body>`;
  check("a blank paragraph is skipped", docxParagraphs(xml).length, 1);
}
{
  // Field codes are instructions to Word, not prose. PAGE must never reach a
  // translator, or the page number turns into a Chinese word.
  const xml = `<w:body><w:p><w:r><w:instrText>PAGE MERGEFORMAT</w:instrText></w:r>`
    + `<w:r><w:t>Page</w:t></w:r></w:p></w:body>`;
  check("field codes are left alone",
    docxParagraphs(xml)[0].runs.map(r => r.text), ["Page"]);
}
{
  const xml = `<w:body>${para("Tom &amp; Jerry &lt;3")}</w:body>`;
  check("escaped characters come back as characters",
    docxParagraphs(xml)[0].runs[0].text, "Tom & Jerry <3");
}

console.log("\nmarking a paragraph for the model");
check("one run goes as plain text", markParagraph([{ text: "Just a sentence." }]), "Just a sentence.");
check("two runs are marked",
  markParagraph([{ text: "Calming Himself" }, { text: ": he needed support." }]),
  "<s1>Calming Himself</s1><s2>: he needed support.</s2>");

console.log("\nreading the model's answer back");
check("plain text, one run", unmarkParagraph("一句话", 1), ["一句话"]);
check("marked, two runs",
  unmarkParagraph("<s1>自我平静</s1><s2>：需要协助</s2>", 2),
  ["自我平静", "：需要协助"]);
check("a dropped marker is refused, not guessed at",
  unmarkParagraph("<s1>自我平静</s1>：需要协助", 2), null);
check("markers in the wrong order still read correctly",
  unmarkParagraph("<s2>二</s2><s1>一</s1>", 2), ["一", "二"]);

console.log("\nputting it back");
{
  const xml = `<w:body>${para("Calming Himself", ": Caden needed support.")}</w:body>`;
  const ps = docxParagraphs(xml);
  const out = applyDocxText(xml, ps, [["自我平静", "：他需要协助"]]);
  check("the words changed", /自我平静/.test(out), true);
  check("no English left", /Calming|Caden/.test(out), false);
  check("the bold is still there", (out.match(/<w:b\/>/g) || []).length, 2);
  check("so is the spacing", /<w:spacing w:after="0"\/>/.test(out), true);
  check("and xml:space, or Word eats the space before the colon",
    (out.match(/xml:space="preserve"/g) || []).length, 2);
  check("the run count is unchanged", (out.match(/<w:r>/g) || []).length, 2);
}
{
  // Several at once: positions are measured before any edit, so they are
  // applied last-first or they would slide out from under each other.
  const xml = `<w:body>${para("One")}${para("Two")}${para("Three")}</w:body>`;
  const ps = docxParagraphs(xml);
  const out = applyDocxText(xml, ps, [["一一一一"], ["二"], ["三三三"]]);
  check("every paragraph lands in its own place",
    docxParagraphs(out).map(p => p.runs[0].text),
    ["一一一一", "二", "三三三"]);
}
{
  const xml = `<w:body>${para("A")}${para("B")}</w:body>`;
  const out = applyDocxText(xml, docxParagraphs(xml), [["甲"], null]);
  check("a paragraph with no translation is left exactly as it was",
    docxParagraphs(out).map(p => p.runs[0].text), ["甲", "B"]);
}
{
  const xml = `<w:body>${para("plain")}</w:body>`;
  const out = applyDocxText(xml, docxParagraphs(xml), [["Tom & Jerry <3"]]);
  check("characters that mean something in XML are escaped again",
    out.includes("Tom &amp; Jerry &lt;3"), true);
  check("and read back as themselves", docxParagraphs(out)[0].runs[0].text, "Tom & Jerry <3");
}
{
  const xml = `<w:body>${para("hello")}</w:body>`;
  check("translating to the same words changes nothing at all",
    applyDocxText(xml, docxParagraphs(xml), [["hello"]]), xml);
}

console.log("\na line break the model added is not a line break");
// Word writes a real break as its own <w:br/>, outside the text, so a
// newline inside a text node is an accident of how the model laid out its
// answer -- and Word renders it. This is what put "3)" alone on a line
// above the sentence it belonged to.
check("dropped between Chinese characters, where a space would be wrong",
  joinWrappedLines("对环境\n和活动"), "对环境和活动");
check("a space anywhere else, so English words do not run together",
  joinWrappedLines("ZORA\nBehavioural"), "ZORA Behavioural");
check("spaces around it are not doubled up",
  joinWrappedLines("3) \n对环境"), "3) 对环境");
check("several in a row count once", joinWrappedLines("a\n\n\nb"), "a b");
check("text with none is untouched", joinWrappedLines("对环境和活动"), "对环境和活动");

console.log("\nthe spacing around a run belongs to the layout, not the language");
// "3) " is a numbered-list prefix in a run of its own. The model has no
// reason to keep that trailing space -- there is nothing there to
// translate -- so it is put back from the original.
check("a trailing space is put back", keepRunSpacing("3) ", "3)"), "3) ");
check("even when the model wrapped the line too", keepRunSpacing("3) ", "3)\n"), "3) ");
check("a leading space is put back in front of English",
  keepRunSpacing(" and then", "and then"), " and then");
check("but not in front of Chinese, where it is a place to break the line",
  keepRunSpacing(" and then", "然后"), "然后");
check("a run that was only spacing is left exactly as it was",
  keepRunSpacing("   ", "什么"), "   ");
check("a run with no spacing to keep is just the translation",
  keepRunSpacing("Greeting", "问候"), "问候");

console.log("\nand the whole numbered line, end to end");
{
  const xml = `<w:body>${para("3) ", "Showing interest and calm attention")}</w:body>`;
  const ps = docxParagraphs(xml);
  // What came back from the model: the number unchanged but wrapped onto
  // its own line, and the sentence in Chinese.
  const out = applyDocxText(xml, ps, [["3)\n", "对环境表现出兴趣"]]);
  check("the number and the sentence read as one line",
    docxParagraphs(out)[0].runs.map(r => r.text).join(""), "3) 对环境表现出兴趣");
  const inside = (out.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) || []).join("");
  check("with no newline left anywhere in the text", /\n/.test(inside), false);
}


console.log("\nthe round trip, on something shaped like a real report");
{
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
    + para("Progress")
    + `<w:tbl><w:tr><w:tc>${para("Target")}</w:tc><w:tc>${para("Score")}</w:tc></w:tr></w:tbl>`
    + para("Strengths")
    + para("Calming Himself", ": Caden regulates well during movement play.")
    + `<w:p><w:r><w:drawing><wp:inline><a:blip r:embed="rId7"/></wp:inline></w:drawing></w:r></w:p>`
    + `</w:body></w:document>`;
  const ps = docxParagraphs(xml);
  check("the picture paragraph has nothing to translate", ps.length, 5);
  const zh = [["进展"], ["目标"], ["分数"], ["优势"],
              ["自我平静", "：他调节得很好"]];
  const out = applyDocxText(xml, ps, zh);
  check("the table is still a table", (out.match(/<w:tbl>|<w:tr>|<w:tc>/g) || []).length, 4);
  check("the picture is untouched", out.includes(`<a:blip r:embed="rId7"/>`), true);
  check("the xml declaration survived", out.startsWith(`<?xml version="1.0"`), true);
  check("the namespace survived", out.includes("xmlns:w=\"http://schemas.openxmlformats.org"), true);
  check("every paragraph reads back in Chinese",
    docxParagraphs(out).map(p => p.runs.map(r => r.text).join("")),
    ["进展", "目标", "分数", "优势",
     "自我平静：他调节得很好"]);
  // The strongest check here: blank out every text node on both sides and
  // the two documents must be identical, byte for byte.
  const skeleton = t => t.replace(/<w:t([^>]*)>[\s\S]*?<\/w:t>/g, "<w:t$1>#</w:t>");
  check("nothing outside the text nodes moved", skeleton(out), skeleton(xml));
}

console.log("\nthe chart's own data, carried in the picture");
// A chart is a picture, so a translator can do nothing with it. But a chart
// is also only its data -- so the data travels with it, and the translator
// draws the whole thing again in Chinese rather than trying to edit a
// picture. Carried rather than looked up again, so the chart that comes
// back is the chart that was generated even if the sessions behind it have
// changed since, and so nothing has to guess which picture is which.
const spec = {
  target: "FEDC 2",
  title: "3) FEDC 2 - Progress (Jan 2026 - Jun 2026)",
  range: "Jan 2026 - Jun 2026",
  legend: ["Start of Term/Trendline", "End of Term/Trendline"],
  data: [
    { isSectionHeader: true, label: "Stage 2: Engagement & Relating" },
    { name: "Responds to your overtures", earliestAvg: 78, latestAvg: 89, monthCount: 6 },
    { name: "Recover from distress with 15mins with your help", earliestAvg: 100, latestAvg: 39 },
  ],
};
const tagged = fns.chartDataTag ? fns.chartDataTag(spec) : null;
check("a tag is produced", typeof tagged, "string");
check("it says what it is up front", tagged.startsWith("zora-chart-v1:"), true);
check("and reads back as exactly what went in", readChartDataTag(tagged), spec);

console.log("\nit is read strictly, so nothing else is mistaken for one");
check("a description somebody typed is not a chart", readChartDataTag("A bar chart of progress"), null);
check("nor is an empty one", readChartDataTag(""), null);
check("nor a missing one", readChartDataTag(undefined), null);
check("a damaged tag is refused rather than half-read",
  readChartDataTag("zora-chart-v1:{not json"), null);
check("and a version we do not know is left alone",
  readChartDataTag("zora-chart-v2:{}"), null);

console.log("\nthrough the XML and back, which is how it really travels");
// Word stores it as an attribute, so every quote in the JSON comes back as
// &quot;. A tag that cannot survive that is no use.
const asAttribute = `<wp:docPr id="1" name="Activity Breakdown" descr="${xmlEscapeAttr(tagged)}" title=""/>`;
const pulled = /descr="([^"]*)"/.exec(asAttribute)[1];
check("the quotes really are escaped in the attribute", /&quot;/.test(pulled), true);
check("and it survives being unescaped again",
  readChartDataTag(xmlUnescape(pulled)), spec);

function xmlEscapeAttr(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}


console.log("\nfinding the charts in a document");
// The real shape: a drawing holds the description, the size and the id of
// the file it shows.
const drawing = (descr, rid, cx, cy) =>
  `<w:p><w:r><w:drawing><wp:inline distT="0">`
  + `<wp:extent cx="${cx}" cy="${cy}"/>`
  + `<wp:docPr id="1" name="Activity Breakdown" descr="${attr(descr)}" title=""/>`
  + `<a:graphic><a:graphicData><pic:pic><pic:blipFill>`
  + `<a:blip r:embed="${rid}"/></pic:blipFill>`
  + `<pic:spPr><a:xfrm><a:ext cx="${cx}" cy="${cy}"/></a:xfrm></pic:spPr>`
  + `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
function attr(t) {
  return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const chartSpec = {
  target: "FEDC 2",
  title: "3) FEDC 2 - Progress (Jan 2026 - Jun 2026)",
  range: "Jan 2026 - Jun 2026",
  legend: ["Start of Term/Trendline", "End of Term/Trendline"],
  data: [
    { isSectionHeader: true, label: "Stage 2: Engagement & Relating" },
    { name: "Responds to your overtures", earliestAvg: 78, latestAvg: 89 },
    { name: "Protest and grows angry when frustrated", earliestAvg: 100, latestAvg: 38 },
  ],
};
{
  const xml = `<w:body>${para("3) FEDC 2")}`
    + drawing(fns.chartDataTag(chartSpec), "rId7", 5486400, 3200400)
    + `${drawing("just a photo", "rId8", 100, 100)}</w:body>`;
  const found = findChartPictures(xml);
  check("one chart, and the ordinary picture is left alone", found.length, 1);
  check("it knows which target", found[0].spec.target, "FEDC 2");
  check("and which file it shows", found[0].rid, "rId7");
  check("and where it sits in the document",
    xml.slice(found[0].start, found[0].end).startsWith("<w:drawing>"), true);
}

console.log("\nthe words a chart needs");
check("the target, the stage heading and every activity",
  chartPhrases(chartSpec),
  ["FEDC 2", "Stage 2: Engagement & Relating",
   "Responds to your overtures", "Protest and grows angry when frustrated"]);
check("a chart with nothing on it asks for nothing", chartPhrases({}), []);

console.log("\na built-in term that is also the name of a target");
// On the chart every bar read 模仿（Imitation）, 命名（Label） and so on, except
// 自我调节, which has no brackets. "self-regulation" is in the built-in word
// list as a plain term, and the built-in list wins over what the model
// produced, so that one bar came out bare.
{
  const pinned = { "Activity": "活动" };
  const pinnedLower = { "self-regulation": "自我调节", "activity": "活动" };
  const targets = new Set(["Self-Regulation", "Imitation"]);
  check("a target name gets the English after it",
    pinnedTermZh("Self-Regulation", pinned, pinnedLower, targets),
    "自我调节（Self-Regulation）");
  // In a sentence it should read as a term, not as a heading.
  check("the same word elsewhere is left plain",
    pinnedTermZh("Activity", pinned, pinnedLower, targets), "活动");
  check("a term nobody pinned is not invented",
    pinnedTermZh("Attending", pinned, pinnedLower, targets), null);
  // Pinning the bracketed form by hand should not double it up.
  check("a pinned term that already names the English is left alone",
    pinnedTermZh("Imitation", { "Imitation": "模仿（Imitation）" }, {}, targets),
    "模仿（Imitation）");
  check("no target list at all is not an error",
    pinnedTermZh("Self-Regulation", pinned, pinnedLower, null), "自我调节");
}

console.log("\nthe target names the model is told to translate");
// A target stopped in April is still in a January to June report, so its
// name has to be translated the same way as a live one. The list is taken
// from every target, with no filter for stopped or archived.
{
  const student = { targets: [
    { name: "Self-Regulation" },
    { name: "Handwriting", isStopped: true },
    { name: "Toilet Training", isArchived: true },
    { name: "Swimming", discontinuedOn: "2026-04-18" },
    { name: "*_Play_*" },
  ] };
  check("every target, however it ended",
    translateTargetNames(student),
    ["Self-Regulation", "Handwriting", "Toilet Training", "Swimming", "Play"]);
}
check("no targets is not an error", translateTargetNames({}), []);

console.log("\nnames with bold and underline markers on them");
// An activity can be written bold or underlined, and that is kept in the name
// itself. Sent out as "*_Self-Regulation:_*" the model could not tell what was
// being asked and handed the English back, which was then remembered as that
// name's Chinese.
check("bold and underline together", stripMarkers("*_Self-Regulation:_*"), "Self-Regulation:");
check("the other way round", stripMarkers("_*Play*_"), "Play");
check("bold on its own", stripMarkers("*Imitation*"), "Imitation");
check("underline on its own", stripMarkers("_Label_"), "Label");
check("a plain name is left alone", stripMarkers("FEDC 2"), "FEDC 2");
check("a name with an underscore inside it survives",
  stripMarkers("Pre_School Skills"), "Pre_School Skills");
check("nothing at all", stripMarkers(null), "");
check("the chart asks for the clean name",
  chartPhrases({ target: "*_Self-Regulation:_*",
                 rows: [{ name: "*Imitation*" }, { name: "Play" }] }),
  ["Self-Regulation:", "Imitation", "Play"]);

console.log("\ntelling a translation from the English handed back");
// Three shapes of leftover, all from when target names were kept in English.
check("the English straight back", looksTranslated("Imitation"), false);
check("English wedged into the Chinese", looksTranslated("社交行为与社交Play"), false);
check("and the other way round", looksTranslated("动作Imitation"), false);
check("a bracketed number inside it is fine",
  looksTranslated("独立完成游戏（0-18个月）"), true);
// The clinical name is kept on purpose, in full-width brackets.
check("the name we actually want", looksTranslated("模仿（Imitation）"), true);
check("plain Chinese", looksTranslated("自我调节"), true);
check("nothing", looksTranslated(""), false);
check("a number beside Chinese is not English", looksTranslated("共5次"), true);

console.log("\nthe note saying this is a translation");
// A parent who reads a phrase that sounds odd should know why before they
// read it, so it goes at the top rather than the end.
{
  const doc = `<w:document><w:body><w:p><w:r><w:t>First thing</w:t></w:r></w:p></w:body></w:document>`;
  const out = addTranslatedNote(doc);
  check("the note is there", /翻译而成/.test(out), true);
  check("before anything else in the body",
    out.indexOf("本报告") < out.indexOf("First thing"), true);
  check("and the report itself is untouched", out.includes("First thing"), true);
  // Both languages: the parent reads the Chinese, and the boss checking it
  // against the English report should see the same note she signed off.
  check("the English half is there too",
    /translated from the original English/.test(out), true);
  check("with the Chinese first", out.indexOf("本报告") < out.indexOf("This report"), true);
  // Someone translating a file twice should not stack two notes.
  check("translating twice does not add it again", addTranslatedNote(out), out);
}
check("a part with no body is left alone",
  addTranslatedNote("<w:hdr><w:p/></w:hdr>"), "<w:hdr><w:p/></w:hdr>");

// The half-year and assessment reports open on a full cover page. Two more
// lines at the very top pushed the company details onto a second page, so on
// those the note starts page 2 instead.
{
  const cover = `<w:document><w:body>`
    + `<w:p><w:r><w:t>ZORA</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t>Half-Year Progress Report</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:pageBreakBefore/><w:spacing w:after="200"/></w:pPr>`
    + `<w:r><w:t>Section 1: Overview</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t>body text</w:t></w:r></w:p>`
    + `</w:body></w:document>`;
  const out = addTranslatedNote(cover);
  check("the cover page still comes first",
    out.indexOf("Half-Year Progress Report") < out.indexOf("本报告"), true);
  check("the note comes before the first heading",
    out.indexOf("本报告") < out.indexOf("Section 1: Overview"), true);
  // If the note did not take the break over it would sit at the bottom of the
  // cover page and push it over, which is the bug being fixed.
  check("the note is what starts the new page",
    out.indexOf("<w:pageBreakBefore/>") < out.indexOf("本报告"), true);
  check("and the heading no longer breaks a page of its own",
    (out.match(/<w:pageBreakBefore\/>/g) || []).length, 1);
  check("the cover page is not touched otherwise", out.includes("ZORA"), true);
  check("twice is still once", addTranslatedNote(out), out);
}
// The monthly report has no cover page and no page break, so nothing moves.
{
  const flat = `<w:document><w:body><w:p><w:r><w:t>First thing</w:t></w:r></w:p></w:body></w:document>`;
  const out = addTranslatedNote(flat);
  check("a report with no cover page keeps the note at the very top",
    out.indexOf("本报告") < out.indexOf("First thing"), true);
  check("and gains no page break", /<w:pageBreakBefore/.test(out), false);
}

console.log("\nclosing a Chinese date up");
// "2026年 1月" on a justified line left a gap half the width of the page:
// that one space was the only thing Word could stretch. Chinese writes a
// date with nothing between its parts anyway.
check("the parts of a date are closed up",
  tieChineseDate("2026年 8月 18日"), "2026年8月18日");
check("a month and year too",
  tieChineseDate("2026年 8月"), "2026年8月");
check("a range loses both gaps",
  tieChineseDate("2026年 1月至2026年 6月"), "2026年1月至2026年6月");
// The non-breaking space the old version put in, so an already translated
// report tidies up rather than keeping the gap.
check("a non-breaking space goes too",
  tieChineseDate("2026年\u00A08月\u00A018日"), "2026年8月18日");
check("a date already closed up is left alone",
  tieChineseDate("2026年8月18日"), "2026年8月18日");
check("running it twice changes nothing",
  tieChineseDate(tieChineseDate("2026年 8月 18日")), "2026年8月18日");
check("the words around it keep their spaces",
  tieChineseDate("掌握于 2026年 8月 18日。"), "掌握于 2026年8月18日。");
check("text with no date at all", tieChineseDate("没有日期"), "没有日期");

console.log("\nspaces where Chinese meets the run beside it");
// "Strength:" is written as a bold run followed by a run that starts with a
// space. In Chinese that space is somewhere Word may break the line, and it
// did: the label sat alone on one line with the whole sentence beneath it.
check("the space before Chinese goes",
  keepRunSpacing(" Qi Pei is improving.", "祁培有所进步。"), "祁培有所进步。");
check("and so does the one after it",
  keepRunSpacing("Strengths ", "优势"), "优势");
check("a space between two English words stays",
  keepRunSpacing(" ZORA ", "ZORA"), " ZORA ");
check("a run that is only a space is untouched", keepRunSpacing("  ", "x"), "  ");

console.log("\nthe months, which are the app's own words");
// Written the way a date is written in Chinese: the year first, then the
// month, and an en dash with no spaces around it.
check("a range becomes Chinese months",
  periodLabelZh("Jan 2026 - Jun 2026"), "2026年1月 – 2026年6月");
check("a single month too", periodLabelZh("Jul 2026"), "2026年7月");
check("a month with no year beside it is still translated",
  periodLabelZh("Jan - Jun"), "1月 – 6月");
check("something with no month in it is untouched", periodLabelZh("Term 1"), "Term 1");

console.log("\nthe title, which is built rather than translated");
// Every piece of it is already known, so translating it would only risk it
// coming back different from the heading printed above the chart. The colon
// is the Chinese one, and so is the bracket after the number: a half-width
// ")" beside Chinese text is what put the number on a line of its own.
{
  const zh = (en) => ({ "FEDC 2": "学习目标二" })[en] || null;
  check("number, Chinese target, Progress, Chinese months",
    chartTitleZh(chartSpec, zh), "3）学习目标二：进展（2026年1月 – 2026年6月）");
  check("a page marker is carried over",
    chartTitleZh({ ...chartSpec, title: "3) FEDC 2 - Progress (x) [Page 2 of 3]" }, zh),
    "3）学习目标二：进展（2026年1月 – 2026年6月）［第2页，共3页］");
  check("an unknown target keeps its English rather than vanishing",
    chartTitleZh({ ...chartSpec, target: "FEDC 9" }, zh),
    "3）FEDC 9：进展（2026年1月 – 2026年6月）");
  check("a title with no number in front of it loses nothing",
    chartTitleZh({ ...chartSpec, title: "FEDC 2 - Progress (Jan 2026 - Jun 2026)" }, zh),
    "学习目标二：进展（2026年1月 – 2026年6月）");
}

console.log("\nthe overall progress chart's own title");
// The chart is drawn by the app rather than translated, so the Chinese name
// has to be put on it here. Nothing further down would ever turn the English
// one into Chinese, and it sat there in English on a page of Chinese.
check("his Chinese name and the months",
  overviewTitleZh({ name: "Zhang Qi Pei", nameZh: "张祺培" }, "Jan 2026 - Jun 2026"),
  "张祺培（2026年1月 – 2026年6月）");
check("no Chinese name typed in, so the English one stands",
  overviewTitleZh({ name: "Ryan Lee" }, "Jan 2026 - Jun 2026"),
  "Ryan Lee（2026年1月 – 2026年6月）");
check("an empty box counts as none",
  overviewTitleZh({ name: "Ryan Lee", nameZh: "   " }, "Jul 2026"),
  "Ryan Lee（2026年7月）");

console.log("\nthe progress chart title is built when the report is translated");
// It used to be written into the English file when the report was generated,
// so changing the wording meant paying to generate every report again. The
// student is known at translation time -- she picks them on the screen -- so
// the Chinese name comes from there.
const qipei = { name: "Zhang Qi Pei", nameZh: "张祺培" };
check("a report that carries its range",
  overviewChartTitle({ title: "Zhang Qi Pei (Jan 2026 - Jun 2026 Progress)",
                       range: "Jan 2026 - Jun 2026" }, qipei),
  "张祺培（2026年1月 – 2026年6月）");
// An older report has no range in it, only a Chinese title frozen in the
// wording of the day it was made. The range is read back out of the English
// title so it comes out in today's wording all the same.
check("and an older one that does not",
  overviewChartTitle({ title: "Zhang Qi Pei (Jan 2026 - Jun 2026 Progress)",
                       titleZh: "Zhang Qi Pei（2026年1月–2026年6月）" }, qipei),
  "张祺培（2026年1月 – 2026年6月）");
check("with no student to hand, the English name is taken from the title",
  overviewChartTitle({ title: "Ryan Lee (Jul 2026 - Dec 2026 Progress)" }, null),
  "Ryan Lee（2026年7月 – 2026年12月）");
// Nothing to work from: what the file already said, rather than a blank.
check("a title in a shape this does not know is left alone",
  overviewChartTitle({ title: "Something else", titleZh: "其他" }, qipei), "其他");
check("and with not even that, the English one",
  overviewChartTitle({ title: "Something else" }, qipei), "Something else");

console.log("\nresizing the slot the picture sits in");
// Chinese is more compact, so the chart is usually shorter. Left alone,
// Word stretches the new picture to fill the old one's space.
{
  const block = `<wp:extent cx="5486400" cy="3200400"/>`
    + `<a:ext cx="5486400" cy="3200400"/>`;
  const out = resizeDrawingToChart(block, 380);     // 380px tall, 760px wide
  const cys = [...out.matchAll(/cy="(\d+)"/g)].map(m => Number(m[1]));
  check("both heights are updated together", cys.length, 2);
  check("and they agree", cys[0], cys[1]);
  check("half as tall as it is wide, because the chart is",
    cys[0], Math.round(5486400 * 380 / 760));
  check("the width is untouched, so it still fits the page",
    [...out.matchAll(/cx="(\d+)"/g)].map(m => m[1]), ["5486400", "5486400"]);
}
check("a block with no width is left alone rather than guessed at",
  resizeDrawingToChart(`<a:ext cy="100"/>`, 380), `<a:ext cy="100"/>`);
check("and so is a chart with no height",
  resizeDrawingToChart(`<wp:extent cx="10" cy="20"/>`, 0), `<wp:extent cx="10" cy="20"/>`);


console.log("\nwhich files inside the zip hold words");
{
  const re = new RegExp(src.match(/const DOCX_TEXT_PARTS = \/(.+?)\/;/)[1]);
  for (const name of ["word/document.xml", "word/header1.xml", "word/footer2.xml",
                      "word/footnotes.xml", "word/endnotes.xml"]) {
    check(`${name} is translated`, re.test(name), true);
  }
  for (const name of ["word/styles.xml", "word/numbering.xml", "word/theme/theme1.xml",
                      "word/charts/chart1.xml", "[Content_Types].xml", "word/media/image1.png"]) {
    check(`${name} is left alone`, re.test(name), false);
  }
}

console.log(failed ? `\n${failed} failed.\n` : "\nAll good.\n");
Deno.exit(failed ? 1 : 0);
