// Dark mode.
//
// Every colour in the app now resolves through a token in styles.css, so a
// theme is that block and nothing else. The things worth checking are the
// ones a token swap can quietly get wrong:
//
//   - the page actually goes dark, and the text stays readable against it
//   - nothing is left behind on a literal colour, which would show up as one
//     white card on a dark page
//   - the choice sticks on this device, and survives a reload without the
//     page flashing white first
//   - the charts DO NOT move. Every chart is drawn on a detached canvas and
//     written into Word and Excel, so a themed chart would walk straight
//     into the exports. Lewis asked for the exports not to change at all.
//
//   deno run -A tests/browser/dark-mode.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: dark-mode.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 500) => new Promise(res => setTimeout(res, ms));

const theme = () => page.eval(`document.documentElement.getAttribute("data-theme")`);
const stored = () => page.eval(`(() => { try { return localStorage.getItem("st-theme"); }
  catch (e) { return "THREW"; } })()`);

// What the page actually paints, resolved by the browser.
const painted = () => page.eval(`(() => {
  const cs = getComputedStyle(document.body);
  const rootCs = getComputedStyle(document.documentElement);
  return {
    bodyBg: cs.backgroundColor,
    bodyFg: cs.color,
    scheme: rootCs.colorScheme,
    token: rootCs.getPropertyValue("--c-374151").trim(),
    surface: rootCs.getPropertyValue("--c-ffffff").trim(),
  };
})()`);

// Rough brightness, 0 black to 255 white. This one runs in Deno, not in the
// page, so the escape is a plain regex literal -- doubled, it matched a
// backslash and never a digit.
const lum = rgb => {
  const m = String(rgb).match(/\d+/g);
  if (!m) return null;
  return Math.round(0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]);
};

try {
  await page.fixture({
    today: "2026-11-01", authUser: "daisy",
    students: [{ id: "s1", name: "TEST yas", order: 1,
      targets: [{ id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: [
        { id: "a1", title: "Antecedent", name: "", order: 0 },
      ] }] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // ── 1. it starts light ──────────────────────────────────────────────
  r.section("1. a browser that has never been told starts light");
  const light = await painted();
  r.check("the light token is the original colour", light.token, "#374151");
  r.check("and the surface token is white", light.surface, "#ffffff");
  const lightBg = lum(light.bodyBg);
  r.ok("the page is light", lightBg !== null && lightBg > 200,
    `${light.bodyBg} (brightness ${lightBg})`);

  // ── 2. the switch ───────────────────────────────────────────────────
  //
  // Both words on screen at once, Light beside Dark, with the one in use
  // filled in. A single button naming the other mode was smaller, but it
  // never showed which mode you were actually in.
  r.section("2. the switch in the header");
  const sw = await page.eval(`(() => {
    const box = document.getElementById("theme-switch");
    if (!box) return null;
    const user = document.getElementById("header-user");
    const out = document.getElementById("btn-logout");
    const cs = getComputedStyle(box), outCs = getComputedStyle(out);
    const opts = [...box.querySelectorAll(".theme-opt")];
    return {
      inHeader: !!box.closest(".app-header"),
      labels: opts.map(o => o.textContent.trim()),
      modes: opts.map(o => o.dataset.theme),
      pressed: opts.filter(o => o.getAttribute("aria-pressed") === "true")
        .map(o => o.dataset.theme),
      // Document order: Appearance, then the name, then Log Out.
      beforeUser: !!(box.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING),
      beforeLogout: !!(box.compareDocumentPosition(out) & Node.DOCUMENT_POSITION_FOLLOWING),
      // Same pill as Log Out: not the same class, so this is the only thing
      // keeping the two from drifting apart.
      sameFrame: cs.borderRadius === outCs.borderRadius
        && cs.backgroundColor === outCs.backgroundColor
        && cs.borderColor === outCs.borderColor
        && cs.borderTopWidth === outCs.borderTopWidth,
      sameFont: getComputedStyle(opts[0]).fontSize === outCs.fontSize
        && getComputedStyle(opts[0]).fontWeight === outCs.fontWeight,
      height: Math.round(box.getBoundingClientRect().height),
      outHeight: Math.round(out.getBoundingClientRect().height),
      width: Math.round(box.getBoundingClientRect().width),
    };
  })()`);
  r.ok("the switch is in the header", !!sw && sw.inHeader, JSON.stringify(sw));
  r.ok("to the left of the current user", !!sw && sw.beforeUser, JSON.stringify(sw));
  r.ok("and to the left of Log Out", !!sw && sw.beforeLogout, JSON.stringify(sw));
  r.check("both words are on it at once", sw && sw.labels,
    ["☀️ Light", "\u{1F319} Dark"]);
  r.check("in that order", sw && sw.modes, ["light", "dark"]);
  r.check("and exactly one is filled in", sw && sw.pressed, ["light"]);
  r.ok("it is built to the same pill as Log Out", !!sw && sw.sameFrame, JSON.stringify(sw));
  r.ok("with the same text size and weight", !!sw && sw.sameFont, JSON.stringify(sw));
  r.check("and is the same height", sw && sw.height, sw && sw.outHeight);
  r.ok("while staying small enough for a header",
    !!sw && sw.width < 190, `${sw && sw.width}px wide`);
  r.check("nothing is left on the home screen",
    await page.eval(`document.querySelectorAll(".home-main .theme-opt").length`), 0);

  await page.eval(`document.querySelector('.theme-opt[data-theme="dark"]').click()`);
  await settle();
  const dark = await painted();
  r.check("the attribute goes on the root", await theme(), "dark");
  r.check("the body-text token flips to a light grey", dark.token, "#d7dce3");
  r.check("and the surface token to a dark one", dark.surface, "#1b1f24");

  const darkBg = lum(dark.bodyBg), darkFg = lum(dark.bodyFg);
  r.ok("the page is actually dark", darkBg !== null && darkBg < 60,
    `${dark.bodyBg} (brightness ${darkBg})`);
  r.ok("and the text on it is light", darkFg !== null && darkFg > 150,
    `${dark.bodyFg} (brightness ${darkFg})`);
  r.ok("with enough contrast between them", darkFg - darkBg > 120,
    `text ${darkFg} on background ${darkBg}`);
  r.check("the browser is told to draw its own parts dark too", dark.scheme, "dark");

  r.section("3. the choice is remembered, on this device");
  r.check("it is written to the browser, not the account", await stored(), "dark");
  r.check("and the filled word moves to Dark", await page.eval(
    `[...document.querySelectorAll(".theme-opt")]
       .filter(o => o.getAttribute("aria-pressed") === "true")
       .map(o => o.dataset.theme)`), ["dark"]);
  r.check("the address-bar colour follows", await page.eval(
    `document.querySelector('meta[name="theme-color"]').getAttribute("content")`), "#15181b");

  // ── 4. a reload must not flash white ────────────────────────────────
  r.section("4. reloading");
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");
  r.check("it comes back dark", await theme(), "dark");
  const after = await painted();
  r.ok("and painted dark", lum(after.bodyBg) < 60, after.bodyBg);
  // The attribute has to be set by the inline script in the head, before the
  // stylesheet. If app.js were doing it, the page would paint white first.
  const inHead = await page.eval(`(() => {
    const s = [...document.head.querySelectorAll("script")].find(x => !x.src);
    const link = document.querySelector('link[rel="stylesheet"]');
    if (!s || !link) return null;
    return { setsTheme: /data-theme/.test(s.textContent),
      beforeStylesheet: !!(s.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING) };
  })()`);
  r.ok("the theme is set by an inline script in the head",
    !!inHead && inHead.setsTheme, JSON.stringify(inHead));
  r.ok("and it runs before the stylesheet, so there is no white flash",
    !!inHead && inHead.beforeStylesheet, JSON.stringify(inHead));

  // ── 5. nothing left behind on a literal colour ──────────────────────
  r.section("5. no card left white on a dark page");
  const strays = await page.eval(`(() => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll("#screen-home *")) {
      const cs = getComputedStyle(el);
      for (const prop of ["backgroundColor", "color"]) {
        const m = String(cs[prop]).match(/\\d+/g);
        if (!m || (m[3] !== undefined && Number(m[3]) === 0)) continue;
        const L = 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2];
        // A light background, or dark text, is wrong way round on a dark page.
        const wrong = prop === "backgroundColor" ? L > 215 : L < 70;
        if (!wrong) continue;
        const key = el.tagName + "." + (el.className || "") + prop;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 40),
          prop, value: cs[prop] });
      }
    }
    return out;
  })()`);
  r.ok("every visible element on the home screen flipped",
    strays.length === 0,
    strays.slice(0, 6).map(s => `${s.tag}.${s.cls} ${s.prop}=${s.value}`).join("\n        "));

  // ── 5b. the screens that hold the inline styles ─────────────────────
  //
  // Nearly all of this app's colour is written inline into HTML strings in
  // app.js, and almost none of that is on the home screen. Edit Target alone
  // holds hundreds of them, so a sweep that stops at the home screen would
  // pass while the screen Daisy spends her time in stayed white.
  const sweep = (sel) => page.eval(`(() => {
    const out = []; const seen = new Set();
    for (const el of document.querySelectorAll(${JSON.stringify(sel)} + " *")) {
      if (!el.offsetParent && el.tagName !== "BODY") continue;
      const cs = getComputedStyle(el);
      for (const prop of ["backgroundColor", "color"]) {
        const m = String(cs[prop]).match(/\\d+/g);
        if (!m || (m[3] !== undefined && Number(m[3]) === 0)) continue;
        const L = 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2];
        if (prop === "backgroundColor" ? L <= 215 : L >= 70) continue;
        const key = el.tagName + "." + (el.className || "") + prop;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(el.tagName + "." + String(el.className || "").slice(0, 36)
          + " " + prop + "=" + cs[prop]);
      }
    }
    return out;
  })()`);

  r.section("5b. Edit Target, where most of the inline colour lives");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "s1");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await settle(800);
  const modalStrays = await sweep("#manage-modal");
  r.ok("nothing in Edit Target is left light",
    modalStrays.length === 0, modalStrays.slice(0, 8).join("\n        "));
  await page.eval(`window.__app.closeManageModal()`);
  await settle(400);

  r.section("5c. the Start Session screen");
  const sessionStrays = await page.eval(`(async () => {
    const s = window.__app.state;
    s.currentStudent = s.students.find(x => x.id === "s1");
    s.selectedTargetName = "FEDC 1";
    s.currentSessionId = "sess1";
    s.sessionData = { date: "2026-11-01", studentId: "s1", activities: {}, remarks: {} };
    document.getElementById("screen-session")?.classList.remove("hidden");
    const host = document.createElement("div");
    host.innerHTML = String(window.__app.renderFedcTarget(s.currentStudent.targets[0]) ?? "");
    document.body.appendChild(host);
    await new Promise(r2 => setTimeout(r2, 300));
    const out = []; const seen = new Set();
    for (const el of host.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      for (const prop of ["backgroundColor", "color"]) {
        const m = String(cs[prop]).match(/\\d+/g);
        if (!m || (m[3] !== undefined && Number(m[3]) === 0)) continue;
        const L = 0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2];
        if (prop === "backgroundColor" ? L <= 215 : L >= 70) continue;
        const key = el.tagName + "." + (el.className || "") + prop;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(el.tagName + "." + String(el.className || "").slice(0, 36)
          + " " + prop + "=" + cs[prop]);
      }
    }
    host.remove();
    return out;
  })()`);
  r.ok("nothing on the session screen is left light",
    sessionStrays.length === 0, sessionStrays.slice(0, 8).join("\n        "));

  // ── 6. back to light ────────────────────────────────────────────────
  r.section("6. and back again");
  await page.eval(`document.querySelector('.theme-opt[data-theme="light"]').click()`);
  await settle();
  r.check("the attribute says light", await theme(), "light");
  r.check("it is remembered", await stored(), "light");
  const back = await painted();
  r.check("the token is the original colour again", back.token, "#374151");
  r.ok("and the page is light again", lum(back.bodyBg) > 200, back.bodyBg);

  // ── 7. the exports must not be able to drift ────────────────────────
  //
  // This one reads the source rather than the page, because it is guarding
  // something a running page cannot show. A canvas cannot resolve a CSS
  // variable: give ctx.fillStyle a "var(--c-16a34a)" and it silently keeps
  // the colour it had. Every chart in this app is drawn on a detached canvas
  // and written straight into Word and Excel, so one token reaching that code
  // changes the reports -- which is the one thing Lewis asked not to happen.
  //
  // It did happen while this was being built: the shared direction map was
  // tokenised and the green "Improving" label came out grey.
  r.section("7. no theme token can reach a chart");
  const src = await Deno.readTextFile(
    new URL("../../app.js", import.meta.url));
  const srcLines = src.split("\r\n");
  const DRAWS = /getContext\("2d"\)|ctx\.|\.fillStyle|\.strokeStyle/;
  const TOKEN = /var\(--c-[0-9a-f]{6}\)/;

  // Walk the top-level blocks by brace depth, then look inside the ones that
  // draw. A line-by-line check would miss a colour defined at the top of a
  // function and used forty lines further down.
  const blocks = [];
  let depth = 0, start = null;
  srcLines.forEach((line, i) => {
    if (depth === 0 && /^(function |const \w+ = |let \w+ = |window\.\w+ = )/.test(line)) start = i;
    depth += (line.split("{").length - 1) - (line.split("}").length - 1);
    if (start !== null && depth <= 0) { blocks.push([start, i]); start = null; depth = 0; }
  });
  const reach = [];
  for (const [a, b] of blocks) {
    const body = srcLines.slice(a, b + 1).join("\n");
    if (!DRAWS.test(body)) continue;
    for (let j = a; j <= b; j++) {
      if (TOKEN.test(srcLines[j])) reach.push(`app.js:${j + 1}  ${srcLines[j].trim().slice(0, 90)}`);
    }
  }
  r.ok("no chart-drawing function mentions a colour token",
    reach.length === 0, reach.slice(0, 6).join("\n        "));

  // export.js is export-only from top to bottom and must have none at all.
  const exp = await Deno.readTextFile(new URL("../../export.js", import.meta.url));
  r.check("and export.js has none anywhere",
    (exp.match(/var\(--c-/g) || []).length, 0);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

r.done("Dark mode");
