// Round-trip tests for the rich details boxes.
//
// The two conversion functions are pulled straight out of app.js rather than
// copied, so this cannot drift from what actually ships. They only ever touch
// childNodes, nodeType, nodeName and nodeValue, which plain objects can
// provide -- so the browser shapes that caused every bug so far can be built
// here and checked without a browser.

const src = await Deno.readTextFile("app.js");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  // Walk braces to the end of the function.
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}

const escHtml = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const richToMarkers    = new Function("escHtml", extract("richToMarkers")    + "; return richToMarkers;")(escHtml);
const markersToRichHtml = new Function("escHtml", extract("markersToRichHtml") + "; return markersToRichHtml;")(escHtml);

// ── the smallest possible stand-in for a DOM node ──────────────────────
const text = v => ({ nodeType: 3, nodeValue: v, childNodes: [] });
const el = (nodeName, ...kids) => ({ nodeType: 1, nodeName, childNodes: kids });
const br = () => el("BR");

let failed = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
};

console.log("\nrichToMarkers — what the box holds becomes what is stored\n");

check("plain text",
  richToMarkers(el("DIV", text("hello"))), "hello");

check("bold word",
  richToMarkers(el("DIV", el("B", text("yup")))), "*yup*");

check("underlined word",
  richToMarkers(el("DIV", el("U", text("yup")))), "_yup_");

check("bold and underlined",
  richToMarkers(el("DIV", el("B", el("U", text("x"))))), "*_x_*");

// Chrome wraps each line in its own DIV; Firefox tends to use BR.
check("two lines as divs",
  richToMarkers(el("DIV", el("DIV", text("a")), el("DIV", text("b")))), "a\nb");

check("two lines as br",
  richToMarkers(el("DIV", text("a"), br(), text("b"))), "a\nb");

// The bug the boss hit: two bold words, one per line.
check("bold on two separate lines",
  richToMarkers(el("DIV",
    el("DIV", el("B", text("yup"))),
    el("DIV", el("B", text("hello"))))), "*yup*\n*hello*");

check("two bold words on one line",
  richToMarkers(el("DIV", el("B", text("yup")), text(" "), el("B", text("hello")))),
  "*yup* *hello*");

// Taking bold off leaves the tag behind.
check("empty bold tag writes nothing",
  richToMarkers(el("DIV", text("a"), el("B"), text("b"))), "ab");

check("bold tag holding only a space",
  richToMarkers(el("DIV", text("a"), el("B", text(" ")), text("b"))), "a b");

check("empty bold wrapping an empty underline",
  richToMarkers(el("DIV", el("B", el("U", text(" "))))), " ");

check("a span's styling is ignored, its words are not",
  richToMarkers(el("DIV", el("SPAN", text("plain")))), "plain");

check("bold text leading into plain text",
  richToMarkers(el("DIV", el("B", text("a")), text(" and b"))), "*a* and b");

console.log("\nmarkersToRichHtml — what is stored becomes what is shown\n");

check("bold renders",
  markersToRichHtml("*yup*"), "<b>yup</b>");

check("two bold lines keep their break",
  markersToRichHtml("*yup*\n*hello*"), "<b>yup</b>\n<b>hello</b>");

check("two bold words keep their space",
  markersToRichHtml("*yup* *hello*"), "<b>yup</b> <b>hello</b>");

check("underline renders",
  markersToRichHtml("_yup_"), "<u>yup</u>");

check("angle brackets are escaped, not run",
  markersToRichHtml("<script>"), "&lt;script&gt;");

console.log("\nround trip — storing then showing then storing again is stable\n");

const roundTrips = [
  "hello",
  "*yup*",
  "*yup*\n*hello*",
  "*yup* *hello*",
  "a\nb\nc",
  "• bullet one\n• bullet two",
  "*_both_*",
  "plain *bold* plain",
];
for (const original of roundTrips) {
  // Shown, then read back by the same walk the browser's DOM would give.
  const shown = markersToRichHtml(original);
  const parsed = parseSimple(shown);
  check(`stable: ${JSON.stringify(original)}`, richToMarkers(parsed), original);
}

// A deliberately small HTML reader: enough for <b>, <u> and text, which is all
// markersToRichHtml ever produces.
function parseSimple(html) {
  const root = el("DIV");
  const stack = [root];
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      const tag = html.slice(i + 1, close);
      if (tag.startsWith("/")) stack.pop();
      else {
        const node = el(tag.toUpperCase());
        stack[stack.length - 1].childNodes.push(node);
        stack.push(node);
      }
      i = close + 1;
      continue;
    }
    const next = html.indexOf("<", i);
    const raw = html.slice(i, next === -1 ? html.length : next);
    stack[stack.length - 1].childNodes.push(text(
      raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
         .replace(/&#39;/g, "'").replace(/&amp;/g, "&")));
    i = next === -1 ? html.length : next;
  }
  return root;
}

console.log(failed ? `\n${failed} FAILED\n` : "\nall passed\n");
Deno.exit(failed ? 1 : 0);
