// Assembles a runnable copy of the app with Firebase replaced by stubs.
//
// The point is to drive the REAL app.js against the REAL index.html in a real
// browser. Everything that would reach the network is swapped out, and the
// data the app would have loaded is handed to it from a fixture instead.
//
//   deno run -A tests/browser/build-harness.js <out-dir>
//
// Nothing here is served to anyone: the output is a throwaway directory.

const ROOT = Deno.cwd();
const out = Deno.args[0];
if (!out) { console.error("usage: build-harness.js <out-dir>"); Deno.exit(2); }

await Deno.mkdir(out, { recursive: true });

// ── the real files, copied untouched ───────────────────────────────────
const verbatim = ["app.js", "export.js", "index.html", "styles.css", "manifest.json"];
for (const f of verbatim) await Deno.copyFile(`${ROOT}/${f}`, `${out}/${f}`);

// Images and icons too, or the page logs a 404 for each one and a test that
// checks the console for errors can never come back clean.
for await (const e of Deno.readDir(ROOT)) {
  if (e.isFile && /\.(png|jpe?g|svg|ico|webp)$/i.test(e.name)) {
    await Deno.copyFile(`${ROOT}/${e.name}`, `${out}/${e.name}`);
  }
}

await Deno.mkdir(`${out}/vendor`, { recursive: true });
for await (const e of Deno.readDir(`${ROOT}/vendor`)) {
  if (e.isFile) await Deno.copyFile(`${ROOT}/vendor/${e.name}`, `${out}/vendor/${e.name}`);
}

// A service worker that cached the page would make reruns answer from the
// cache instead of the files just built, and sw.js is deliberately not copied
// here. navigator.serviceWorker cannot simply be assigned away -- it is a
// getter on the prototype -- so it is redefined, which also stops the 404 the
// registration would otherwise log.
let html = await Deno.readTextFile(`${out}/index.html`);
html = html.replace(/<script type="module" src="app\.js"><\/script>/,
  `<script>
     try {
       Object.defineProperty(Navigator.prototype, "serviceWorker", {
         configurable: true,
         get: () => ({
           register: () => new Promise(() => {}),   // never settles, never 404s
           addEventListener: () => {},
           ready: new Promise(() => {}),
           controller: null,
         }),
       });
     } catch (e) { console.warn("could not stub the service worker", e); }
   </script>
   <script type="module" src="app.js"></script>`);
await Deno.writeTextFile(`${out}/index.html`, html);

// The real sw.js is not served, so anything that still asks gets a no-op.
await Deno.writeTextFile(`${out}/sw.js`, `// no-op worker for the harness\n`);

// ── config.js: the real shape, none of the real keys ───────────────────
await Deno.writeTextFile(`${out}/config.js`, `
export const FIREBASE_CONFIG = { projectId: "harness", apiKey: "harness" };
export const CONFIG = {
  SCORE_LABELS: {
    3: { 0: "Refuse to Engage", 1: "Fully Prompt", 2: "Partial Prompt", 3: "Independent" },
    4: { 0: "Refuse to Respond", 1: "Partial Prompted", 2: "Prompted Response",
         3: "Delayed Response", 4: "Attempt Independently" },
  },
  INITIAL_STUDENTS: [],
};
`);

// ── firebase-service.js: every export the app asks for ─────────────────
// The list is read out of the real imports rather than written by hand, so a
// new import cannot silently leave a hole here.
const appSrc = await Deno.readTextFile(`${ROOT}/app.js`);
const expSrc = await Deno.readTextFile(`${ROOT}/export.js`);

function importedFrom(src, module) {
  const names = new Set();
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*["']\\./${module}["']`, "g");
  let m;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.replace(/\/\/.*$/gm, "").trim().split(/\s+as\s+/).pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

const needed = new Set([
  ...importedFrom(appSrc, "firebase-service\\.js"),
  ...importedFrom(expSrc, "firebase-service\\.js"),
]);
if (needed.size < 50) { console.error(`only found ${needed.size} imports -- parse failed`); Deno.exit(1); }

// A few have to behave rather than just record, or the app never starts.
const behaving = {
  // Auth has to be a little state machine, not a one-shot callback.
  //
  // The app force-signs-out when its stored session epoch is stale and then
  // waits for onAuthChange to fire a SECOND time with no user. A stub that
  // fired once left it on "Auto logging in..." for ever. The epoch is seeded
  // below so that path is not taken, but signing out still has to work,
  // because some tests go through it.
  onAuthChange: `(cb) => {
    // Who is signed in. The app works out the role from the e-mail, so a
    // wrong domain makes everyone an "assistant" and every control locked.
    // A test sets __FIXTURE.authUser to "daisy", "nigel", "rayhanah" or
    // "lewis" to check what each of them may do.
    const who = globalThis.__FIXTURE.authUser || "daisy";
    globalThis.__auth = globalThis.__auth || { user: { email: who + "__DOMAIN__", uid: who } };
    globalThis.__auth.cb = cb;
    setTimeout(() => cb(globalThis.__auth.user), 0);
    return () => {};
  }`,
  signInAs: `async (who) => {
    globalThis.__auth.user = { email: (who || "daisy") + "__DOMAIN__", uid: who || "daisy" };
    setTimeout(() => globalThis.__auth.cb?.(globalThis.__auth.user), 0);
    return globalThis.__auth.user;
  }`,
  signOutUser: `async () => {
    globalThis.__auth.user = null;
    setTimeout(() => globalThis.__auth.cb?.(null), 0);
  }`,
  getTodayString: `() => globalThis.__FIXTURE.today`,
  generateId: `() => "id" + (globalThis.__idSeq = (globalThis.__idSeq || 0) + 1)`,
  sanitizeKey: `(s) => String(s ?? "").replace(/[.#$/\\[\\]]/g, "_")`,
  // Both come back as ARRAYS of documents, sorted by `order` -- not as maps
  // keyed by id. A map made loadAppData throw "students is not iterable".
  // Read through the shared store when the test asked for one, so two
  // browsers see each other's writes the way two people on two machines do.
  // __FIXTURE is the starting content; the store is where it then lives.
  loadStudentsConfig: `async () => globalThis.__store.load("students")`,
  loadGroups:         `async () => globalThis.__store.load("groups")`,
  loadScoringConfig:  `async () => structuredClone(globalThis.__FIXTURE.scoring || {})`,
  loadRemarkPresets:  `async () => []`,
  loadTemplates:      `async () => []`,
  loadHalfYearReportConfig: `async () => ({})`,
  getTrashItems: `async () => []`,
  cleanupExpiredTrash: `async () => {}`,
  getAiCostAllTime: `async () => 0`,
  // Listeners never fire: the fixture is the only source of truth, so nothing
  // arrives later to overwrite what a test just did.
  // A real listener when the store is shared: it polls, and calls back
  // whenever that student's record changes. Without this a second browser
  // never learns what the first one wrote, which is the whole point.
  listenToStudent: `(id, cb) => globalThis.__store.watch("students", id, cb)`,
  // The Edit Target lock, through the shared store so two browsers really do
  // compete for the same one.
  editLockId: `(a, b) => String(a) + "__" + String(b)`,
  getEditLock: `async (owner, target) => globalThis.__store.getLock(String(owner) + "__" + String(target))`,
  setEditLock: `async (owner, target, holder) => globalThis.__store.setLock(String(owner) + "__" + String(target), {
    ownerId: String(owner), targetId: String(target),
    holderId: holder.id, holderName: holder.name, heldAt: Date.now(),
  })`,
  clearEditLock: `async (owner, target) => globalThis.__store.clearLock(String(owner) + "__" + String(target))`,
  listenToEditLock: `() => () => {}`,
  listenToGroup:   `(id, cb) => globalThis.__store.watch("groups", id, cb)`,
  listenToSession: `() => () => {}`,
  listenToReviewQueue: `() => () => {}`,
  // Sessions, for the "open an old session" case.
  getAllSessionsForStudent: `async () => structuredClone(globalThis.__FIXTURE.sessions || [])`,
  getRecentSessionsForStudent: `async () => structuredClone(globalThis.__FIXTURE.sessions || [])`,
  getIndividualSessionsForStudent: `async () => structuredClone(globalThis.__FIXTURE.sessions || [])`,
  getAllSessions: `async () => structuredClone(globalThis.__FIXTURE.sessions || [])`,
  getSessionById: `async (id) => structuredClone((globalThis.__FIXTURE.sessions || []).find(s => s.id === id) || null)`,
  getStudentById: `async (id) => (await globalThis.__store.load("students")).find(s => s.id === id) || null`,
};

// saveStudent is the write the save tests are actually about. It records the
// call AND writes back into the fixture, so reopening a panel reads what was
// saved, exactly as a reload from Firestore would.
//
// It takes the whole student object, not (id, data) -- the real one reads
// student.id itself and refuses a blank name, so that refusal is kept here.
behaving.saveStudent = `async (student) => {
  if (!student?.name?.trim()) throw new Error("Cannot save a student with a blank name.");
  globalThis.__harness.log("saveStudent", [structuredClone(student)]);
  await globalThis.__store.save("students", student);
}`;
behaving.saveGroup = `async (group) => {
  globalThis.__harness.log("saveGroup", [structuredClone(group)]);
  await globalThis.__store.save("groups", group);
}`;

// The login domain decides the role, so it is read from the app rather than
// repeated here.
const LOGIN_DOMAIN = (appSrc.match(/const LOGIN_DOMAIN\s*=\s*"([^"]+)"/) || [])[1];
if (!LOGIN_DOMAIN) { console.error("could not find LOGIN_DOMAIN in app.js"); Deno.exit(1); }
for (const k of Object.keys(behaving)) behaving[k] = behaving[k].replaceAll("__DOMAIN__", LOGIN_DOMAIN);

let stub = `// Generated by tests/browser/build-harness.js -- do not edit.
// Every call is recorded on window.__harness.calls so a test can assert on
// what the app tried to write.
const rec = (name) => (...args) => {
  globalThis.__harness.log(name, args.map(a => {
    try { return structuredClone(a); } catch { return String(a); }
  }));
  return Promise.resolve();
};
`;
for (const name of [...needed].sort()) {
  stub += behaving[name]
    ? `export const ${name} = ${behaving[name]};\n`
    : `export const ${name} = rec("${name}");\n`;
}
// The store client, written into the page before anything else runs.
//
// With no shared store the fixture is used directly and nothing is polled,
// so single-browser tests behave exactly as they did.
const storeClient = `
globalThis.__store = (() => {
  const shared = () => !!globalThis.__FIXTURE.sharedStore;
  const copy = v => JSON.parse(JSON.stringify(v));
  const seeded = {};

  async function load(collection) {
    if (!shared()) return copy(globalThis.__FIXTURE[collection] || []);
    // First read seeds the store from the fixture, so whichever browser
    // gets there first fills it and the other reads what is already there.
    if (!seeded[collection]) {
      seeded[collection] = true;
      const now = await fetch("/__store/" + collection).then(r => r.json());
      if (!now.docs.length) {
        for (const doc of (globalThis.__FIXTURE[collection] || [])) {
          await fetch("/__store/" + collection + "/" + doc.id,
            { method: "POST", body: JSON.stringify(doc) });
        }
      }
    }
    const res = await fetch("/__store/" + collection).then(r => r.json());
    return res.docs;
  }

  const mine = {};                 // id -> version this browser last wrote

  async function save(collection, doc) {
    if (!shared()) {
      const list = (globalThis.__FIXTURE[collection] ||= []);
      const at = list.findIndex(x => x.id === doc.id);
      at === -1 ? list.push(copy(doc)) : (list[at] = copy(doc));
      return;
    }
    const res = await fetch("/__store/" + collection + "/" + doc.id,
      { method: "POST", body: JSON.stringify(doc) }).then(r => r.json());
    mine[collection + "/" + doc.id] = res.version;
  }

  function watch(collection, id, cb) {
    if (!shared()) return () => {};
    let last = null, stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/__store/" + collection).then(r => r.json());
        const doc = res.docs.find(d => d.id === id);
        // Never hand back a copy older than this browser's own last write.
        const floor = mine[collection + "/" + id] || 0;
        if (doc && (doc.__v || 0) >= floor) {
          const now = JSON.stringify(doc);
          if (now !== last) { last = now; cb(JSON.parse(now)); }
        }
      } catch (e) { /* server going away at the end of a run */ }
      if (!stopped) setTimeout(tick, 150);
    };
    tick();
    return () => { stopped = true; };
  }

  // Locks live in the same shared store, so one browser can see the other's.
  async function getLock(id) {
    if (!shared()) return (globalThis.__locks ||= {})[id] || null;
    const res = await fetch("/__store/editLocks").then(r => r.json());
    return res.docs.find(d => d.id === id) || null;
  }
  async function setLock(id, doc) {
    if (!shared()) { (globalThis.__locks ||= {})[id] = { id, ...doc }; return; }
    await fetch("/__store/editLocks/" + id,
      { method: "POST", body: JSON.stringify({ id, ...doc }) });
  }
  async function clearLock(id) {
    if (!shared()) { delete (globalThis.__locks ||= {})[id]; return; }
    await fetch("/__store/editLocks/" + id, { method: "DELETE" });
  }

  return { load, save, watch, getLock, setLock, clearLock };
})();
`;

// The client goes in front of the exports, so it exists before app.js
// imports this module and starts calling them.
await Deno.writeTextFile(`${out}/firebase-service.js`, storeClient + stub);

// ── a way in to the module's own scope ─────────────────────────────────
// app.js is an ES module, so nothing inside it can be reached from the
// devtools console. A test needs a couple of entry points -- chiefly the one
// that opens the Edit Target modal -- so the harness copy gets a block
// appended that hands them out.
//
// Only the way IN is exposed. Everything a test then does is a real click or
// a real key press on the real markup, so this cannot paper over a broken
// button: it only saves walking three menus to reach the screen under test.
const exposed = [
  "openManageModal", "openGroupManageModal", "closeManageModal",
  "renderGroupTargetContent", "renderFedcTarget", "paDisplayHtml",
  "mnSetIdleTimeoutForTests",
  "state", "currentUser", "currentRole",
  "mnPanelSave", "mnPanelDiscard", "mnPanelIsDirty",
  "richToMarkers", "markersToRichHtml", "attachRichEditors",
  "showHome", "showScreen", "APP_VERSION",
];
let shim = `

// ── appended by tests/browser/build-harness.js ──────────────────────────
globalThis.__app = {};
`;
for (const name of exposed) {
  shim += `try { globalThis.__app.${name} = ${name}; } catch (e) { /* not in this build */ }\n`;
}
shim += `globalThis.__appReady = true;\n`;
await Deno.writeTextFile(`${out}/app.js`, await Deno.readTextFile(`${out}/app.js`) + shim);

// ── what the driver needs to know about this build ─────────────────────
// Read out of app.js rather than written here, so bumping the epoch in the
// app does not quietly start every test on the sign-in screen again.
const pick = (re, what) => {
  const m = appSrc.match(re);
  if (!m) throw new Error(`could not find ${what} in app.js`);
  return m[1];
};
await Deno.writeTextFile(`${out}/harness-meta.json`, JSON.stringify({
  appVersion:     pick(/const APP_VERSION\s*=\s*"([^"]+)"/, "APP_VERSION"),
  sessionEpoch:    pick(/const SESSION_EPOCH\s*=\s*"([^"]+)"/, "SESSION_EPOCH"),
  sessionEpochKey: pick(/const SESSION_EPOCH_KEY\s*=\s*"([^"]+)"/, "SESSION_EPOCH_KEY"),
  lastLoginKey:    pick(/const LAST_LOGIN_DATE_KEY\s*=\s*"([^"]+)"/, "LAST_LOGIN_DATE_KEY"),
}, null, 2));

console.log(`harness built in ${out}`);
console.log(`  ${needed.size} firebase exports stubbed, ${Object.keys(behaving).length} of them behaving`);
