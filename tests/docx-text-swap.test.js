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
               "unmarkParagraph", "applyDocxText"];
const fns = new Function(names.map(extract).join("\n") + `\nreturn { ${names.join(", ")} };`)();
const { docxParagraphs, markParagraph, unmarkParagraph, applyDocxText } = fns;

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
