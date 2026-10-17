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
const realSettings = await Deno.readTextFile("tests/fixtures-real-settings.xml");

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
const lists = ["CHINESE_NO_BREAK_AFTER", "CHINESE_NO_BREAK_BEFORE"]
  .map(n => src.match(new RegExp(`const ${n} = "[^"]*";`))[0]).join("\n");
const setChineseLineBreaks = new Function(
  lists + extract("setChineseLineBreaks") + "; return setChineseLineBreaks;")();

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
  /<w:lang w:val="zh-CN" w:eastAsia="zh-CN"\/>/.test(fixed), true);
check("the language sits inside the document defaults",
  /<w:rPrDefault><w:rPr>[\s\S]*<w:lang[^>]*\/><\/w:rPr><\/w:rPrDefault>/.test(fixed), true);

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
// Everything this function is meant to add, taken back out again: whatever
// is left over is something it changed that it had no business changing.
const bare = t => t.replace(/<w:lang[^>]*zh-CN[^>]*\/>/g, "")
  .replace(/<w:kinsoku\/><w:overflowPunct\/><w:autoSpaceDE\/><w:autoSpaceDN\/>/g, "")
  .replace(/ w:hint="eastAsia"/g, "")
  .replace(/w:eastAsia="[^"]*"/g, "#");
check("nothing changed but the font slot and the language",
  bare(fixed), bare(realStyles));
check("the language tag is a language, not a font name",
  /<w:lang[^>]*"SimSun"/.test(fixed), false);
// Word spell checked every Chinese sentence as English and underlined the
// lot in red. w:eastAsia fills only the East Asian slot; the main one was
// left unset, so Word used whatever the reader has set -- English
// (Malaysia) on the boss's machine.
check("the main language slot says Chinese too",
  /<w:lang[^>]*w:val="zh-CN"/.test(fixed), true);
check("and so does the East Asian one",
  /<w:lang[^>]*w:eastAsia="zh-CN"/.test(fixed), true);
check("one language tag, not two",
  (fixed.match(/<w:lang/g) || []).length, 1);

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

console.log("\nthe rules that stop a line starting with a comma");
// A report written by the app carries none of these, so Word was left to its
// own defaults: it broke the Chinese wherever the margin fell and put "，" at
// the start of a line.
check("every run says which characters are the East Asian ones",
  /<w:rFonts[^>]*w:hint="eastAsia"/.test(fixed), true);
check("the four line-breaking rules are set",
  ["kinsoku", "overflowPunct", "autoSpaceDE", "autoSpaceDN"]
    .every(r => fixed.includes(`<w:${r}/>`)), true);
// The order of these elements is fixed by the format, and all four belong
// before <w:spacing>, which the app already writes.
check("and they come before the spacing that was already there",
  fixed.indexOf("<w:kinsoku/>") < fixed.indexOf("<w:spacing"), true);
check("they sit in the paragraph defaults, not loose in the file",
  /<w:pPrDefault><w:pPr><w:kinsoku\/>/.test(fixed), true);
check("running it twice does not add them again",
  (setChineseFonts(fixed).match(/<w:kinsoku\/>/g) || []).length, 1);
check("nor a second hint on one run",
  (setChineseFonts(fixed).match(/w:hint="eastAsia"/g) || []).length,
  (fixed.match(/w:hint="eastAsia"/g) || []).length);

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

console.log("\nwhere Word may not break a Chinese line");
// <w:kinsoku/> says to apply the rules. It does not say what they are: those
// are two character lists, and a file the app builds has none, so a line was
// free to start with "，" or to hold nothing but "。". This fixture is the real
// settings.xml, read out of a report the app built.
const settings = setChineseLineBreaks(realSettings);
check("the lists were not there to begin with",
  /noLineBreaks/.test(realSettings), false);
check("a line may not start with a comma",
  /<w:noLineBreaksBefore[^>]*w:val="[^"]*，/.test(settings), true);
// "2026年 9月 4日" in a narrow cell broke between the 9 and the 月: Chinese
// may break between any two characters, so tying the day to its month only
// moved the break one character earlier.
for (const [ch, what] of [["年", "a year"], ["月", "a month"], ["日", "a day"]]) {
  check(`nor with ${what}`,
    new RegExp(`<w:noLineBreaksBefore[^>]*w:val="[^"]*${ch}`).test(settings), true);
}
check("nor with a full stop",
  /<w:noLineBreaksBefore[^>]*w:val="[^"]*。/.test(settings), true);
check("nor end with an opening bracket",
  /<w:noLineBreaksAfter[^>]*w:val="[^"]*（/.test(settings), true);
check("they say which language they are for",
  (settings.match(/w:lang="zh-CN"/g) || []).length, 2);
// They are part of the compatibility block, which the file already has.
check("they sit inside w:compat",
  /<w:compat><w:noLineBreaksAfter/.test(settings), true);
check("the compatibility setting that was there is kept",
  settings.includes('w:name="compatibilityMode"'), true);
check("running it twice does not add them again",
  setChineseLineBreaks(settings), settings);
check("nothing else in the file changed",
  settings.replace(/<w:noLineBreaks(After|Before)[^>]*\/>/g, ""), realSettings);

// A settings file with no compatibility block at all still gets them.
{
  const bare = `<?xml version="1.0"?><w:settings xmlns:w="x"><w:zoom/></w:settings>`;
  const out = setChineseLineBreaks(bare);
  check("a file with no compat block gets one",
    /<w:compat><w:noLineBreaksAfter[\s\S]*<\/w:compat><\/w:settings>$/.test(out), true);
  check("and what was already in it survives", out.includes("<w:zoom/>"), true);
}

console.log(failed ? `\n${failed} failed.\n` : "\nAll good.\n");
Deno.exit(failed ? 1 : 0);
