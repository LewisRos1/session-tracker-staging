// Tests for the bullet button in the details boxes.
//
// richToggleBullet is the piece that broke twice, and it is the one doing
// index arithmetic: it finds the caret's line in the text on SCREEN, then
// edits that same line in the MARKER text, where a bold run is longer by two
// stars. Off-by-one is the whole risk, so it gets checked line by line.
//
// Pulled out of app.js rather than copied. The browser pieces it leans on --
// a selection, innerText, innerHTML, a tree walker -- are stubbed just far
// enough to run it.

const src = await Deno.readTextFile("app.js");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} has no end`);
}

// ── fake nodes ─────────────────────────────────────────────────────────
const BULLET = "•";
const text = v => ({ nodeType: 3, nodeValue: v, childNodes: [] });
/** An empty line in a real box is <div><br></div>. */
const br = () => el("BR");

function el(nodeName, ...kids) {
  const node = { nodeType: 1, nodeName, childNodes: kids };
  node.contains = other => {
    if (other === node) return true;
    const walk = n => n.childNodes.some(c => c === other || walk(c));
    return walk(node);
  };
  // What the browser would show: DIV and P start new lines, BR is a line end.
  Object.defineProperty(node, "innerText", {
    get() {
      const read = n => {
        let out = "";
        for (const c of n.childNodes) {
          if (c.nodeType === 3) { out += c.nodeValue; continue; }
          if (c.nodeName === "BR") { out += "\n"; continue; }
          if (c.nodeName === "DIV" || c.nodeName === "P") {
            if (out && !out.endsWith("\n")) out += "\n";
            out += read(c); continue;
          }
          out += read(c);
        }
        return out;
      };
      return read(node);
    },
  });
  Object.defineProperty(node, "innerHTML", {
    set(html) { node.childNodes = parseSimple(html).childNodes; },
  });
  node.classList = { contains: c => c === "mn-rich" };
  node.focus = () => {};
  return node;
}

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

// ── fake browser ───────────────────────────────────────────────────────
const sel = { focusNode: null, focusOffset: 0, removeAllRanges() {}, addRange(r) { sel._placed = r; } };
globalThis.window = { getSelection: () => sel };
globalThis.NodeFilter = { SHOW_TEXT: 4 };
globalThis.Event = class { constructor(t) { this.type = t; } };
globalThis.document = {
  createRange: () => ({ _n: null, _o: 0, setStart(n, o) { this._n = n; this._o = o; }, collapse() {} }),
  createTreeWalker(root) {
    const out = [];
    (function walk(n) { for (const c of n.childNodes) { if (c.nodeType === 3) out.push(c); else walk(c); } })(root);
    let i = 0;
    return { nextNode: () => (i < out.length ? out[i++] : null) };
  },
};

const escHtml = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const names = ["markersToRichHtml", "richToMarkers", "richTextMap", "richCaretOffset",
  "refreshRichFromField", "placeRichCaret", "richToggleBullet"];
const api = new Function("escHtml",
  names.map(extract).join("\n") + `\n return { ${names.join(", ")} };`)(escHtml);
const { markersToRichHtml, richToMarkers, richToggleBullet } = api;

let failed = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}`);
  if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
};

/**
 * Build a box holding `stored`, put the caret on `lineNo` at `col` counted in
 * what is shown, press the bullet button, and give back the new marker text.
 *
 * This is the real path: the box is drawn from the stored markers exactly as
 * reopening the panel would draw it, which is where the bullet bug lived --
 * it only showed up on a box that had been saved and opened again.
 */
function pressBullet(stored, lineNo, col = 0) {
  const rich = el("DIV");
  const ta = { value: stored, dispatchEvent() {} };
  rich._richField = ta;
  rich.innerHTML = markersToRichHtml(stored);

  // Find the text node holding that line and column, as a click would.
  const nodes = [];
  (function walk(n) { for (const c of n.childNodes) { if (c.nodeType === 3) nodes.push(c); else walk(c); } })(rich);
  const shown = rich.innerText;
  let want = 0;
  for (let i = 0; i < lineNo; i++) want = shown.indexOf("\n", want) + 1;
  want += col;

  let seen = 0;
  sel.focusNode = nodes[0] || rich;
  sel.focusOffset = 0;
  for (const n of nodes) {
    if (seen + n.nodeValue.length >= want) { sel.focusNode = n; sel.focusOffset = want - seen; break; }
    seen += n.nodeValue.length;
  }

  richToggleBullet(rich);
  return ta.value;
}

console.log("\nthe bullet lands on the caret's line, not the first line\n");

check("line 1 of 3",
  pressBullet("alpha\nbeta\ngamma", 0), `${BULLET} alpha\nbeta\ngamma`);

check("line 2 of 3",
  pressBullet("alpha\nbeta\ngamma", 1), `alpha\n${BULLET} beta\ngamma`);

check("line 3 of 3",
  pressBullet("alpha\nbeta\ngamma", 2), `alpha\nbeta\n${BULLET} gamma`);

check("caret mid-word still bullets that line",
  pressBullet("alpha\nbeta\ngamma", 1, 2), `alpha\n${BULLET} beta\ngamma`);

check("single line",
  pressBullet("alpha", 0), `${BULLET} alpha`);

console.log("\npressing again takes it off\n");

check("bullet removed from line 1",
  pressBullet(`${BULLET} alpha\nbeta`, 0), "alpha\nbeta");

check("bullet removed from line 2",
  pressBullet(`alpha\n${BULLET} beta`, 1), "alpha\nbeta");

check("removing one leaves its neighbours",
  pressBullet(`${BULLET} a\n${BULLET} b\n${BULLET} c`, 1), `${BULLET} a\nb\n${BULLET} c`);

console.log("\nmarkers shift the columns; lines still line up\n");

// The point of the line-index mapping: shown text is shorter than stored.
check("bold on line 1, bullet on line 2",
  pressBullet("*alpha*\nbeta", 1), "*alpha*\n" + BULLET + " beta");

check("bold on line 1 and 2, bullet on line 3",
  pressBullet("*alpha*\n*beta*\ngamma", 2), `*alpha*\n*beta*\n${BULLET} gamma`);

check("bullet on a bold line keeps the bold",
  pressBullet("*alpha*\nbeta", 0), `${BULLET} *alpha*\nbeta`);

check("bold and underline on earlier lines",
  pressBullet("*a*\n_b_\n*_c_*\nd", 3), `*a*\n_b_\n*_c_*\n${BULLET} d`);

check("taking a bullet off a bold line keeps the bold",
  pressBullet(`${BULLET} *alpha*\nbeta`, 0), "*alpha*\nbeta");

console.log("\nbullet survives a save and a reopen\n");

// What the boss did: bullet, close, open, press again to remove.
let stored = pressBullet("dddddddd", 0);
check("after reopen the bullet can come off", pressBullet(stored, 0), "dddddddd");

// And bold still works on a line that already has a bullet.
stored = `${BULLET} dddddddd`;
const reopened = el("DIV");
reopened._richField = { value: stored, dispatchEvent() {} };
reopened.innerHTML = markersToRichHtml(stored);
check("a reopened bullet line reads back unchanged", richToMarkers(reopened), stored);

console.log("\nblank lines in the box, which is what a real one has\n");

// A browser builds an empty line as <div><br></div>. That is the shape that
// broke the bullet button: it counted once one way and twice another, so the
// line number ran past the end of the stored text and nothing happened.
//
// Built here as the DOM, not from the stored text, because only the DOM shows
// what the browser actually does with a blank line.
function pressBulletOnDom(rich, stored, lineNo, col = 0) {
  const ta = { value: stored, dispatchEvent() {} };
  rich._richField = ta;

  const map = api.richTextMap(rich);
  const lines = map.text.split("\n");
  let want = 0;
  for (let i = 0; i < lineNo; i++) want += lines[i].length + 1;
  want += Math.min(col, (lines[lineNo] || "").length);

  // Put the caret in whichever text node holds that offset.
  sel.focusNode = rich;
  sel.focusOffset = 0;
  for (let i = map.spans.length - 1; i >= 0; i--) {
    const sp = map.spans[i];
    if (want >= sp.start) {
      sel.focusNode = sp.node;
      sel.focusOffset = Math.min(want - sp.start, sp.node.nodeValue.length);
      break;
    }
  }
  richToggleBullet(rich);
  return ta.value;
}

/** <div>alpha</div><div><br></div><div>beta</div> -- "alpha", blank, "beta". */
const withBlankLine = () => el("DIV",
  el("DIV", text("alpha")),
  el("DIV", br()),
  el("DIV", text("beta")));

check("the map counts a blank line once",
  api.richTextMap(withBlankLine()).text, "alpha\n\nbeta");

check("bullet on the line AFTER a blank line",
  pressBulletOnDom(withBlankLine(), "alpha\n\nbeta", 2),
  `alpha\n\n${BULLET} beta`);

check("bullet on the first line, blank line below",
  pressBulletOnDom(withBlankLine(), "alpha\n\nbeta", 0),
  `${BULLET} alpha\n\nbeta`);

check("caret at the END of the last line still bullets it",
  pressBulletOnDom(withBlankLine(), "alpha\n\nbeta", 2, 99),
  `alpha\n\n${BULLET} beta`);

// Two blank lines, the way the boss's box looked.
const twoBlanks = () => el("DIV",
  el("DIV", text("one")),
  el("DIV", br()),
  el("DIV", br()),
  el("DIV", text("four")));

check("two blank lines are counted once each",
  api.richTextMap(twoBlanks()).text, "one\n\n\nfour");

check("bullet after two blank lines",
  pressBulletOnDom(twoBlanks(), "one\n\n\nfour", 3, 99),
  `one\n\n\n${BULLET} four`);

// The box in the screenshot: a bulleted line, a blank, a block, a blank, a
// last line with the caret at its end.
const bossBox = () => el("DIV",
  el("DIV", text("• ddd")),
  el("DIV", br()),
  el("DIV", text("asdf")),
  el("DIV", br()),
  el("DIV", text("asdfadsfasf")));

check("bullet on the final line of a box with blanks above",
  pressBulletOnDom(bossBox(), "• ddd\n\nasdf\n\nasdfadsfasf", 4, 99),
  `${BULLET} ddd\n\nasdf\n\n${BULLET} asdfadsfasf`);

check("and pressing again takes it off",
  pressBulletOnDom(
    el("DIV",
      el("DIV", text("• ddd")),
      el("DIV", br()),
      el("DIV", text("• asdfadsfasf"))),
    "• ddd\n\n• asdfadsfasf", 2, 99),
  `${BULLET} ddd\n\nasdfadsfasf`);

console.log(failed ? `\n${failed} FAILED\n` : "\nall passed\n");
Deno.exit(failed ? 1 : 0);
