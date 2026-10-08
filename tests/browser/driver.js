// Serves the harness and drives a real headless Edge over the DevTools
// protocol. Edge is Chromium, so this is the same engine the boss uses.
//
// Exported for the test files; not run directly.

const EDGE = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

function findBrowser() {
  for (const p of EDGE) { try { Deno.statSync(p); return p; } catch { /* next */ } }
  throw new Error("no Chromium browser found");
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".map": "application/json",
};

/** Static file server over the built harness. */
function serve(dir) {
  // One shared store for every browser this server feeds, standing in for the
  // one Firestore that two people on two machines are both writing to. Without
  // it each page has its own data and a test can never show one person's save
  // landing on top of another's.
  const store = { students: new Map(), groups: new Map(), bump: 0 };

  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      let path = new URL(req.url).pathname;

      // ── the shared store ──────────────────────────────────────────
      if (path.startsWith("/__store")) {
        const parts = path.split("/").filter(Boolean);   // __store, collection, id
        const json = (body) => new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json", "cache-control": "no-store",
                     "access-control-allow-origin": "*" },
        });
        const collection = parts[1] && store[parts[1]];
        if (req.method === "GET" && parts.length === 2 && collection) {
          return json({ bump: store.bump, docs: [...collection.values()] });
        }
        if (req.method === "POST" && parts.length === 3 && collection) {
          const doc = await req.json();
          // Every document carries a version. A client never accepts a copy
          // older than the one it wrote itself, which is the guarantee real
          // Firestore gives through its local cache: onSnapshot hands you your
          // own write immediately and never a server copy from before it.
          // Without this the poll can answer with the copy from just before a
          // save and the browser undoes its own change.
          doc.__v = ++store.bump;
          collection.set(parts[2], doc);
          return json({ ok: true, bump: store.bump, version: doc.__v });
        }
        if (req.method === "DELETE" && parts.length === 3 && collection) {
          collection.delete(parts[2]);
          store.bump++;
          return json({ ok: true, bump: store.bump });
        }
        return json({ error: "bad store request", path });
      }

      if (path === "/") path = "/index.html";
      try {
        const body = await Deno.readFile(dir + path);
        const dot = path.lastIndexOf(".");
        return new Response(body, {
          headers: {
            "content-type": MIME[path.slice(dot)] || "application/octet-stream",
            // The harness is rebuilt between runs; nothing may be remembered.
            "cache-control": "no-store",
          },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    },
  );
  return {
    port: server.addr.port, store,
    stop: () => { ac.abort(); return server.finished; },
  };
}

/**
 * A browser, with the pieces of CDP these tests need.
 *
 * Pass `site` from another page to put this browser on the SAME server, and so
 * on the same shared store: two separate browsers, each with its own profile
 * and its own sign-in, both writing to one set of records. That is the setup
 * where one person's save can land on top of another's.
 */
export async function openPage(dir, { verbose = false, site: shared = null } = {}) {
  const meta = JSON.parse(await Deno.readTextFile(`${dir}/harness-meta.json`));
  const site = shared || serve(dir);
  const port = 9000 + Math.floor(Math.random() * 900);
  const profile = await Deno.makeTempDir({ prefix: "harness-profile-" });

  const browser = new Deno.Command(findBrowser(), {
    args: [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-gpu",
      // Keeps a headless run from being throttled like a background tab.
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1400,1000",
      "about:blank",
    ],
    stdout: "null", stderr: "null",
  }).spawn();

  // Wait for the debugging endpoint rather than guessing at a delay.
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === "page");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await new Promise(r => setTimeout(r, 100));
  }
  if (!wsUrl) throw new Error("the browser never opened its debugging port");

  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = () => no(new Error("devtools socket failed")); });

  let seq = 0;
  const waiting = new Map();
  const events = [];
  const listeners = new Set();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && waiting.has(msg.id)) {
      const { ok, no } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
      return;
    }
    events.push(msg);
    for (const fn of listeners) fn(msg);
  };

  const send = (method, params = {}) =>
    new Promise((ok, no) => { waiting.set(++seq, { ok, no }); ws.send(JSON.stringify({ id: seq, method, params })); });

  // Everything the page logs, so a test can fail on a page error it did not
  // expect rather than passing while the console fills with them.
  const consoleLines = [];
  const pageErrors = [];
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Log.enable");
  listeners.add(msg => {
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || []).map(a =>
        a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" ");
      consoleLines.push({ level: msg.params.type, text });
      if (verbose) console.log(`  [page ${msg.params.type}] ${text}`);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description || d.text);
      if (verbose) console.log(`  [page throw] ${d.exception?.description || d.text}`);
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      consoleLines.push({ level: "error", text: msg.params.entry.text });
    }
  });

  const page = {
    url: `http://127.0.0.1:${site.port}/index.html`,
    /** Pass this to openPage to put another browser on the same store. */
    site,
    consoleLines, pageErrors, events,

    /** Run an expression in the page and give back its value. */
    async eval(expression, { awaitPromise = true } = {}) {
      const r = await send("Runtime.evaluate", {
        expression, awaitPromise, returnByValue: true, userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error("in page: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      return r.result.value;
    },

    /**
     * Install the data the app will load, before any of its code runs.
     *
     * It has to go in as a new-document script: setting it after navigating is
     * too late, because app.js asks for it while the page is still loading,
     * and setting it before navigating is wiped by the navigation itself.
     */
    async fixture(data) {
      // Seeded so the app does not take its force-sign-out path. It signs
      // everyone out once when the stored epoch does not match, which on a
      // fresh browser profile is always -- that would land every test on the
      // sign-in screen. The values come from app.js via the build.
      const seed = `
        try {
          localStorage.setItem(${JSON.stringify(meta.sessionEpochKey)}, ${JSON.stringify(meta.sessionEpoch)});
          localStorage.setItem(${JSON.stringify(meta.lastLoginKey)}, "1");
        } catch (e) { /* storage blocked; the test will say so */ }`;
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `globalThis.__FIXTURE = ${JSON.stringify(data)};
                 globalThis.__harness = { calls: [], log: (name, args) => globalThis.__harness.calls.push({ name, args }) };
                 ${seed}`,
      });
    },

    /** What the build read out of app.js. */
    meta,

    /** Load the harness and wait until the app has finished starting. */
    async load() {
      await send("Page.navigate", { url: page.url });
      await page.until(`document.readyState === "complete"`, "the page to finish loading");
      // The app signs in asynchronously; the home screen is what says it is ready.
      await page.until(
        `!!document.querySelector("#screen-home:not(.hidden), .screen.active, #home-screen")`,
        "the app to reach its home screen",
      ).catch(() => {});
      return page;
    },

    /** Poll an expression until it is true. */
    async until(expression, what = expression, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try { last = await page.eval(`!!(${expression})`); if (last) return true; }
        catch (err) { last = err.message; }
        await new Promise(r => setTimeout(r, 60));
      }
      throw new Error(`timed out waiting for ${what}` + (typeof last === "string" ? ` (${last})` : ""));
    },

    /** A real key press, dispatched by the browser rather than by script. */
    async key(key, { ctrl = false, shift = false, text } = {}) {
      const mods = (ctrl ? 2 : 0) | (shift ? 8 : 0);
      // Named keys need their own code; charCodeAt on "Enter" gives "E".
      const NAMED = {
        Enter: { code: 13, text: "\r" }, Tab: { code: 9, text: "\t" },
        Backspace: { code: 8 }, Delete: { code: 46 }, Escape: { code: 27 },
        ArrowLeft: { code: 37 }, ArrowRight: { code: 39 },
        ArrowUp: { code: 38 }, ArrowDown: { code: 40 },
        Home: { code: 36 }, End: { code: 35 },
      };
      const named = NAMED[key];
      const base = {
        modifiers: mods, key,
        windowsVirtualKeyCode: named ? named.code : key.toUpperCase().charCodeAt(0),
      };
      const typed = text ?? (named ? named.text : (mods ? undefined : key));
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(typed ? { text: typed } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    },

    /** Type text one character at a time, as a person would. */
    async type(string) {
      for (const ch of string) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      }
    },

    /** A real mouse click at the centre of whatever the selector finds. */
    async click(selector) {
      const box = await page.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
      })()`);
      if (!box) throw new Error(`nothing matches ${selector}`);
      if (!box.w || !box.h) throw new Error(`${selector} has no size, so it cannot be clicked`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
    },

    /** Click a point, for the dimmed area outside a panel. */
    async clickAt(x, y) {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    },

    async screenshot(path) {
      const r = await send("Page.captureScreenshot", { format: "png" });
      await Deno.writeFile(path, Uint8Array.from(atob(r.data), c => c.charCodeAt(0)));
      return path;
    },

    async close() {
      try { ws.close(); } catch { /* already gone */ }
      try { browser.kill(); } catch { /* already gone */ }
      await browser.status.catch(() => {});
      // Only the browser that started the server shuts it down, or closing
      // the first of two would pull the store out from under the second.
      if (!shared) await site.stop().catch(() => {});
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    },
  };

  return page;
}

/** Shared pass/fail reporting. */
export function reporter() {
  let failed = 0, passed = 0;
  return {
    section: (t) => console.log(`\n${t}\n`),
    check(name, got, want) {
      const ok = JSON.stringify(got) === JSON.stringify(want);
      ok ? passed++ : failed++;
      console.log(`${ok ? "  ok  " : "FAIL  "}${name}`);
      if (!ok) console.log(`        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
      return ok;
    },
    ok(name, cond, detail = "") {
      cond ? passed++ : failed++;
      console.log(`${cond ? "  ok  " : "FAIL  "}${name}`);
      if (!cond && detail) console.log(`        ${detail}`);
      return !!cond;
    },
    done() {
      console.log(`\n${passed} passed, ${failed} failed\n`);
      return failed;
    },
  };
}
