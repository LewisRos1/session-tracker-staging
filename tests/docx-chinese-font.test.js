// Telling Word the text is Chinese.
//
// Lewis's first translations came back with the number alone on one line
// and the sentence underneath, and every character underlined in red:
//
//     3)
//     对环境和活动表现出兴趣，并平静地保持专注力
//
// The report is built in Times New Roman, and the docx library writes that
// into every font slot including w:eastAsia -- so the document says "use
// Times New Roman for East Asian text". Times New Roman has no Chinese in
// it. Word then treats the characters as Latin, and Latin breaks only at
// spaces. A Chinese sentence has none, so the whole thing is one
// unbreakable word: it will not fit after "3)", drops to the next line, and
// is force-broken in the middle. Short headings looked fine, which is why
// rows 1, 2 and 5 were right and the long ones were not.
//
// The fixtures are the real parts, taken out of a report the app built --
// not something written here to match the code.
//
//   deno run --allow-read tests/docx-chinese-font.test.js

const src = await Deno.readTextFile("app.js");
const realStyles = await Deno.readTextFile("tests/fixtures-real-styles.xml");
const realDoc = await Deno.readTextFile("tests/fixtures-real-document.xml");

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
const font = src.match(/const CHINESE_EASTASIA_FONT = "([^"]+)";/)[1];
const setChineseFonts = new Function(
  `const CHINESE_EASTASIA_FONT = ${JSON.stringify(font)};`
  + extract("setChineseFonts") + "; return setChineseFonts;")();

let failed = 0;
const check = (what, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${what}${ok ? "" : `\n        want ${w}\n        got  ${g}`}`);
};

console.log("\nwhat the app really writes today");
check("the East Asian font is a Latin one, which is the fault",
  /w:eastAsia="Times New Roman"/.test(realStyles), true);
check("and the numbered line is a single run, so there is no space to restore",
  /<w:t xml:space="preserve">1\) Showing interest[^<]*<\/w:t>/.test(realDoc), true);

console.log("\nafter the fix");
const fixed = setChineseFonts(realStyles);
check("no Latin font is left in an East Asian slot",
  /w:eastAsia="Times New Roman"/.test(fixed), false);
check("a real Chinese font is named instead",
  new RegExp(`w:eastAsia="${font}"`).test(fixed), true);
check("the font chosen is one every Windows Word has", font, "SimSun");
check("and the text is declared Chinese, so it is not proofed as English",
  /<w:lang w:eastAsia="zh-CN"\/>/.test(fixed), true);
check("the language sits inside the document defaults",
  /<w:rPrDefault><w:rPr>[\s\S]*<w:lang w:eastAsia="zh-CN"\/><\/w:rPr><\/w:rPrDefault>/.test(fixed), true);

console.log("\nand nothing else is disturbed");
check("the Latin font is untouched",
  /w:ascii="Times New Roman"/.test(fixed), true);
check("so is the complex-script one",
  /w:cs="Times New Roman"/.test(fixed), true);
check("the size is untouched", /<w:sz w:val="22"\/>/.test(fixed), true);
check("the line spacing is untouched", /<w:spacing w:line="360"/.test(fixed), true);
check("every other style survives",
  (fixed.match(/<w:style /g) || []).length,
  (realStyles.match(/<w:style /g) || []).length);
// The language tag is removed BEFORE the font slots are blanked, or it
// would already read <w:lang #/> and survive the comparison.
const bare = t => t.replace(/<w:lang w:eastAsia="zh-CN"\/>/g, "")
  .replace(/w:eastAsia="[^"]*"/g, "#");
check("nothing changed but the font slot and the language",
  bare(fixed), bare(realStyles));
check("the language tag is a language, not a font name",
  /<w:lang w:eastAsia="SimSun"/.test(fixed), false);

console.log("\nrunning it twice changes nothing the second time");
check("the language is not added again", setChineseFonts(fixed), fixed);

console.log("\nthe document body too, where a run sets its own font");
const withRunFont = realDoc.replace("<w:p>",
  `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="Times New Roman"/></w:rPr>`
  + `<w:t>x</w:t></w:r>`);
const fixedDoc = setChineseFonts(withRunFont);
check("a run's own East Asian font is corrected as well",
  /w:eastAsia="Times New Roman"/.test(fixedDoc), false);
check("but its Latin font is left alone", /w:ascii="Arial"/.test(fixedDoc), true);

console.log("\nwhich parts get the treatment");
{
  const re = new RegExp(src.match(/const DOCX_FONT_PARTS = \/(.+?)\/;/)[1]);
  // styles.xml holds no text at all, and is the one that matters most.
  for (const n of ["word/styles.xml", "word/document.xml", "word/header1.xml", "word/footer1.xml"]) {
    check(`${n} is corrected`, re.test(n), true);
  }
  for (const n of ["word/theme/theme1.xml", "word/numbering.xml", "[Content_Types].xml"]) {
    check(`${n} is left alone`, re.test(n), false);
  }
}

console.log(failed ? `\n${failed} failed.\n` : "\nAll good.\n");
Deno.exit(failed ? 1 : 0);
