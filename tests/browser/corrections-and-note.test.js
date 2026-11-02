// Four things Lewis found on live, in one place because two of them turned
// out to be the same bug.
//
//   1. The same person appeared twice: once as a pill inside Phase 3, and
//      again as a loose button in a row under the whole chart, with no line
//      joining the two. You matched them up by reading the name off both.
//      They are one card per person now, inside the phase they belong to --
//      name, what is outstanding, the tick, and the way into the list.
//
//      The sentence had to change with it. The loose pill counted whatever
//      was on the reader's own plate: "1 to check" for Ms. Daisy, "1 to
//      fix" for Rayhanah, off one list. Fine on a button sitting by itself,
//      wrong on a card headed with her name. (Before that again it read "0
//      to check" beside two corrections nobody had touched, because both
//      sat on Needs Revision, which is the instructor's turn.)
//
//   2. A ticked answer bubble went white in dark mode. White is right for a
//      picked day in the date grid, one cell out of thirty-five, but a row
//      of white bubbles was shouting. Grey, still clearly chosen.
//
//   3 and 4. The sticky note's close button was reported missing. It was
//      never missing. Its colour and its header's colour both came from the
//      amber family, so in dark mode it was pale amber on yellow: 19 points
//      of brightness apart, where about 60 is the floor for something you
//      have to find. Giving the note a dark theme put the cross back.
//
//   deno run -A tests/browser/corrections-and-note.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: corrections-and-note.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

const lum = rgb => {
  const m = String(rgb).match(/\d+/g);
  return m ? Math.round(0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) : null;
};
const setTheme = mode =>
  page.eval(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(mode)})`);

// A session where Rayhanah entered the data and Ms. Daisy has written two
// corrections, both still on Needs Revision.
const sessionWith = (statuses, phase = "checked") => ({
  date: "2026-10-29", studentId: "s1",
  participants: ["ray"],
  // How far the session has got, which is what tells the four kinds of
  // empty list apart:
  //   "none"    Rayhanah has not entered her data
  //   "entered" she has, Ms. Daisy has not checked it
  //   "checked" Ms. Daisy has checked it
  //
  // The key for Ms. Daisy's check is p2_check_<instructor>, not p2_daisy --
  // it records whose work was checked, not who did the checking.
  checks: phase === "none" ? {}
    : phase === "entered" ? { p1_ray: { by: "ray", at: 1 } }
    : { p1_ray: { by: "ray", at: 1 }, p2_check_ray: { by: "daisy", at: 2 } },
  // The field is reviewComments. "comments" is not one the app reads.
  reviewComments: Object.fromEntries(statuses.map((s, i) => [
    "c" + i,
    // forInstructor is the field the app reads; instructorId is not one.
    { text: "correction " + i, byId: "daisy", forInstructor: "ray",
      ...(s === null ? {} : { fixStatus: s }) },
  ])),
  activities: {}, remarks: {},
});

// One Phase 3 card, pulled apart. Everything the card says about a person
// lives in one box now, so one read gets all of it.
const cardInfo = (data, asUser) => page.eval(`(() => {
  const u = window.__app.USERS.find(x => x.id === ${JSON.stringify(asUser)});
  if (u) window.__app.state.authEmail = u.email;
  const host = document.createElement("div");
  host.innerHTML = String(window.__app.renderCheckedByStripHtml(${JSON.stringify(data)}, null, false) ?? "");
  const card = host.querySelector(".wf-card");
  const flat = el => el ? el.textContent.replace(/\\s+/g, " ").trim() : null;
  const pick = sel => card ? card.querySelector(sel) : null;
  return {
    card: !!card,
    name:   flat(pick(".wf-card-name")),
    status: flat(pick(".wf-card-text")),
    tone:   card ? (card.className.match(/wf-card--(\\w+)/) || ["", null])[1] : null,
    tick:     flat(pick(".wf-card-btns .wf-pill")),
    tickRole: pick(".wf-card-btns [data-role]")
      ? pick(".wf-card-btns [data-role]").dataset.role : null,
    note:    flat(pick(".wf-card-note")),
    noteFor: pick(".wf-card-note") ? pick(".wf-card-note").dataset.instId : null,
    // The old row of loose pills under the whole chart. It should be empty
    // whenever there is an instructor to make a card for.
    loose: [...host.querySelectorAll(".wf-note-wrap .wf-note-btn")].map(flat),
  };
})()`);

try {
  await page.fixture({
    today: "2026-11-02", authUser: "daisy",
    students: [{ id: "s1", name: "Kayden Koh", order: 1,
      targets: [{ id: "t1", name: "Self-Regulation", scale: 3, predefinedActivities: [] }] }],
    groups: [],
    sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // -- 1. the card ----------------------------------------------------
  r.section("1. Phase 3 holds one card per instructor");
  const open2 = await cardInfo(sessionWith([null, null]), "daisy");
  r.ok("a card is rendered", open2.card, JSON.stringify(open2));
  r.check("headed with the instructor's name", open2.name, "Rayhanah");
  r.ok("it holds the tick", !!open2.tick, JSON.stringify(open2));
  r.check("which still writes that instructor's Phase 3 check",
    open2.tickRole, "p3_ray");
  r.ok("and a way into the list", /View Corrections/.test(String(open2.note)),
    String(open2.note));
  r.check("aimed at the same person", open2.noteFor, "ray");

  // The whole point of the move: the person appeared twice, once in the
  // phase box and again in a loose row under the chart with no line joining
  // it to anything, so you matched the two up by reading the name off both.
  r.check("and the loose row under the chart is gone", open2.loose.length, 0);
  r.ok("the tick no longer repeats the name the card is headed with",
    !/Rayhanah/.test(String(open2.tick)), String(open2.tick));

  // -- 1b. what the card says -----------------------------------------
  //
  // Six states. Each says what is true of that person now -- "all approved"
  // used to cover four of them, and only one was: Rayhanah had not so much
  // as entered her data and the pill was already green, telling Ms. Daisy
  // the work was signed off.
  r.section("1b. the six things a card can say");
  const states = [
    ["Waiting to complete Phase 1", "wait", sessionWith([], "none"),
     "before the instructor has entered anything"],
    ["Ms. Daisy hasn't checked yet", "wait", sessionWith([], "entered"),
     "entered, but Ms. Daisy has not looked"],
    ["Nothing to fix", "clear", sessionWith([], "checked"),
     "checked, and she wrote nothing"],
    ["All approved", "clear", sessionWith(["fixed", "fixed"], "checked"),
     "she wrote some and signed them all off"],
    ["Ms. Daisy has checked, kindly make 2 corrections", "work",
     sessionWith([null, null]), "two written, neither fixed"],
    ["2 corrections done, kindly check", "work",
     sessionWith(["done", "done"]), "both fixed, neither approved"],
  ];
  for (const [words, tone, data, why] of states) {
    const info = await cardInfo(data, "daisy");
    r.check(`${why} -> "${words}"`, info.status, words);
    r.check(`and it is ${tone}`, info.tone, tone);
  }

  // One is one, not "1 corrections".
  r.check("one to fix reads as one",
    (await cardInfo(sessionWith([null]), "daisy")).status,
    "Ms. Daisy has checked, kindly make 1 correction");
  r.check("and so does one to check",
    (await cardInfo(sessionWith(["done"]), "daisy")).status,
    "1 correction done, kindly check");

  // Both halves can be true at once. Phase 3 cannot be ticked until the
  // instructor's are gone, so that is the half that still asks for
  // something and that is what the card names.
  r.section("1c. a list holding both names the instructor's half");
  const mixed = await cardInfo(sessionWith(["done", null]), "daisy");
  r.check("one done, one still to fix",
    mixed.status, "Ms. Daisy has checked, kindly make 1 correction");
  r.check("one approved, one still to fix",
    (await cardInfo(sessionWith(["fixed", null]), "daisy")).status,
    "Ms. Daisy has checked, kindly make 1 correction");
  r.check("approved and done, with nothing left on her plate",
    (await cardInfo(sessionWith(["fixed", "done"]), "daisy")).status,
    "1 correction done, kindly check");

  // -- 1d. the card reads the same to everybody -----------------------
  //
  // The loose pill it replaced counted whatever was on the reader's own
  // plate: "1 to check" for Ms. Daisy, "1 to fix" for Rayhanah, off one
  // list. Fine on a button sitting by itself, wrong on a card with her name
  // at the top -- two people could not talk about what it said.
  r.section("1d. a card headed Rayhanah says the same to everybody");
  for (const [words, , data, why] of states) {
    const asRay = await cardInfo(data, "ray");
    r.check(`${why}, read by Rayhanah`, asRay.status, words);
  }
  r.check("and a mixed list too",
    (await cardInfo(sessionWith(["done", null]), "ray")).status, mixed.status);

  // -- 1e. the tick ---------------------------------------------------
  r.section("1e. the tick keeps every state it had");
  const locked = await cardInfo(sessionWith([], "entered"), "daisy");
  r.ok("locked until Ms. Daisy has checked", /Locked/.test(String(locked.tick)),
    String(locked.tick));
  r.check("and is not a button while it is locked", locked.tickRole, null);
  const unlocked = await cardInfo(sessionWith([], "checked"), "daisy");
  r.ok("unlocked once she has", /Incomplete/.test(String(unlocked.tick)),
    String(unlocked.tick));
  r.check("and is a button again", unlocked.tickRole, "p3_ray");
  const ticked = await cardInfo({
    ...sessionWith(["fixed"], "checked"),
    checks: { p1_ray: { by: "ray", at: 1 }, p2_check_ray: { by: "daisy", at: 2 },
              p3_ray: { by: "ray", at: new Date("2026-10-29T18:54:00").getTime() } },
  }, "daisy");
  r.ok("a ticked row shows when it was ticked",
    /29 Oct 6:54pm/.test(String(ticked.tick)), String(ticked.tick));
  r.check("and can still be undone", ticked.tickRole, "p3_ray");

  // The session nobody else was added to has no card to put it on, so the
  // plain button stays where it was.
  r.section("1f. a session with no instructor keeps the plain button");
  const alone = await cardInfo(
    { ...sessionWith([], "checked"), participants: [] }, "daisy");
  r.check("no card", alone.card, false);
  r.check("one loose button", alone.loose.length, 1);
  r.ok("with no name on it", /^.{0,3}Corrections$/.test(String(alone.loose[0])),
    String(alone.loose[0]));

  // ── 2. the ticked bubble ────────────────────────────────────────────
  r.section("2. a ticked answer bubble is grey in dark mode, not white");
  const chip = async () => page.eval(`(() => {
    const probe = (prop) => {
      const el = document.createElement("span");
      el.style.background = "var(" + prop + ")";
      document.body.appendChild(el);
      const v = getComputedStyle(el).backgroundColor;
      el.remove(); return v;
    };
    return { chip: probe("--chip-on-bg"), day: probe("--pick-bg") };
  })()`);

  await setTheme("dark");
  await settle(250);
  const darkChip = await chip();
  r.ok("the bubble is a mid grey, well short of white",
    lum(darkChip.chip) > 70 && lum(darkChip.chip) < 160,
    `${darkChip.chip} (brightness ${lum(darkChip.chip)})`);
  r.ok("but still clearly lighter than the page behind it",
    lum(darkChip.chip) - lum(await page.eval(
      `getComputedStyle(document.body).backgroundColor`)) > 45,
    JSON.stringify(darkChip));
  // The date grid keeps white. One cell out of thirty-five has to be
  // findable at a glance; a row of bubbles does not.
  r.ok("a picked day in the date grid is still white",
    lum(darkChip.day) > 230, `${darkChip.day} (brightness ${lum(darkChip.day)})`);

  await setTheme("light");
  await settle(250);
  const lightChip = await chip();
  r.check("and light mode is the indigo it always was",
    lightChip.chip, "rgb(99, 102, 241)");

  // ── 3 and 4. the sticky note ────────────────────────────────────────
  for (const mode of ["light", "dark"]) {
    r.section(`3. the sticky note's close button, in ${mode} mode`);
    await setTheme(mode);
    await settle(250);
    const x = await page.eval(`(() => {
      const note = document.getElementById("sticky-note");
      note.classList.remove("hidden");
      document.getElementById("sticky-note-title").textContent =
        "\\u{1F4DD} List of Corrections \\u2013 Rayhanah";
      const btn = document.getElementById("btn-sticky-note-close");
      if (!btn) return { missing: true };
      const nb = note.getBoundingClientRect(), xb = btn.getBoundingClientRect();
      return {
        w: Math.round(xb.width),
        inside: xb.right <= nb.right + 1 && xb.left >= nb.left - 1,
        fg: getComputedStyle(btn).color,
        headerBg: getComputedStyle(btn.parentElement).backgroundColor,
        noteBg: getComputedStyle(note).backgroundColor,
      };
    })()`);
    r.ok("the cross is there and has a size", !x.missing && x.w > 0, JSON.stringify(x));
    r.ok("it is inside the note rather than clipped off the edge",
      !x.missing && x.inside, JSON.stringify(x));
    // The number that mattered: it was 19 in dark mode, which is why it was
    // reported as missing rather than as hard to see.
    const gap = Math.abs(lum(x.fg) - lum(x.headerBg));
    r.ok(`it stands out from its header (gap ${gap})`, gap >= 60, JSON.stringify(x));
    const closed = await page.eval(`(() => {
      document.getElementById("btn-sticky-note-close").click();
      return document.getElementById("sticky-note").classList.contains("hidden");
    })()`);
    r.ok("and clicking it closes the note", closed, String(closed));

    if (mode === "dark") {
      r.section("4. and the note itself is dark, not a yellow lamp");
      r.ok("the note body is dark", lum(x.noteBg) < 70,
        `${x.noteBg} (brightness ${lum(x.noteBg)})`);
      r.ok("and its header is not the bright yellow it was",
        lum(x.headerBg) < 90, `${x.headerBg} (brightness ${lum(x.headerBg)})`);
    } else {
      r.ok("the note is still yellow in light mode, as a note should be",
        lum(x.noteBg) > 200, `${x.noteBg} (brightness ${lum(x.noteBg)})`);
    }
  }

  // ── 5. white text needs something dark under it ─────────────────────
  //
  // A toast and a progress pill float over the page as dark objects with
  // white text, in both themes. They were written with the TEXT end of the
  // grey ramp, which is a near-black in light mode -- so they looked right
  // -- and mirrors to a near-white in dark mode, leaving white on white.
  // Lewis could not read "Locked. Only Nigel can tick this." at all.
  //
  // Checked in both themes, because the light one is where the mistake
  // hides: it looks perfect there and that is why it shipped.
  r.section("5. a floating pill is readable, and stands off the page");
  for (const mode of ["light", "dark"]) {
    await setTheme(mode);
    await settle(250);
    const pills = await page.eval(`(() => {
      const mk = (cls) => {
        const el = document.createElement("div");
        el.className = cls;
        el.textContent = "x";
        el.style.display = "flex";
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = { bg: cs.backgroundColor, fg: cs.color };
        el.remove();
        return out;
      };
      const toast = document.createElement("div");
      toast.id = "wf-toast";
      toast.textContent = "x";
      document.body.appendChild(toast);
      const tcs = getComputedStyle(toast);
      const wf = { bg: tcs.backgroundColor, fg: tcs.color };
      toast.remove();
      return {
        "the workflow toast": wf,
        "the general toast": mk("toast"),
        "the progress pill": mk("progress-pill"),
        "the done pill": mk("progress-pill is-done"),
        "the fail pill": mk("progress-pill is-fail"),
      };
    })()`);
    const page_bg = await page.eval(`getComputedStyle(document.body).backgroundColor`);
    for (const [what, c] of Object.entries(pills)) {
      // Not "is the text white on something dark" any more -- the toasts
      // invert with the theme now, so the question is whether the text reads
      // on its own pill, whichever way round that pill is.
      const gap = Math.abs(lum(c.fg) - lum(c.bg));
      r.ok(`${mode}: ${what} is readable (gap ${gap})`, gap >= 90, JSON.stringify(c));
      // And whether the pill itself stands off the page behind it. A toast
      // that matches the page is the fault Lewis reported, either way up.
      const standOff = Math.abs(lum(c.bg) - lum(page_bg));
      r.ok(`${mode}: ${what} stands off the page (gap ${standOff})`,
        standOff >= 60, `${c.bg} on page ${page_bg}`);
    }
  }

  // ── 6. who gets the Revert button ───────────────────────────────────
  //
  // Needs Revision is the first entry in Ms. Daisy's own dropdown, so for
  // her the button is a second door onto the same room, under every row an
  // instructor has ticked. The instructor has no such entry and needs it.
  //
  // Lewis keeps it. This was once hidden from everyone who can approve,
  // which is the same test, and putting it back is recorded in app.js as
  // being because it left him looking at a Done row with no button and
  // nothing to say why. The two are only different if the rule names her.
  r.section("6. the Revert button is only for the people who need it");
  // currentUser() resolves the signed-in person from state.authEmail against
  // the USERS list, so setting a currentUser object does nothing. Sign in as
  // each person the way the app actually knows who you are.
  const revertFor = (userId) => page.eval(`(() => {
    const u = window.__app.USERS.find(x => x.id === ${JSON.stringify(userId)});
    if (!u) return { noSuchUser: ${JSON.stringify(userId)} };
    window.__app.state.authEmail = u.email;
    const note = document.getElementById("sticky-note");
    note.classList.remove("hidden");
    window.__app.renderStickyNoteContent(${JSON.stringify(sessionWith(["done", null]))}, false);
    const rows = [...document.querySelectorAll("#sticky-note-rows tr")];
    const out = {
      rows: rows.length,
      undo: document.querySelectorAll("#sticky-note-rows .snote-undo-btn").length,
      selects: document.querySelectorAll("#sticky-note-rows .snote-status-sel").length,
    };
    note.classList.add("hidden");
    return out;
  })()`);

  const daisy = await revertFor("daisy");
  r.ok("Ms. Daisy sees both correction rows", daisy.rows === 2, JSON.stringify(daisy));
  r.check("and no Revert button on the one marked Done", daisy.undo, 0);
  r.check("but she still has the dropdown to send it back", daisy.selects, 2);

  for (const who of ["nigel", "ray"]) {
    const them = await revertFor(who);
    r.ok(`${who} does get the Revert button`,
      !them.noSuchUser && them.undo === 1, JSON.stringify(them));
  }

  // The reason the rule names her rather than reusing canSignOffCorrections.
  const lewis = await revertFor("lewis");
  r.check("and Lewis keeps it, as he did before", lewis.undo, 1);

  // ── 7. Add Correction, and the colour of a correction ───────────────
  //
  // Writing a correction is Ms. Daisy's, like choosing Approved, and is
  // refused the same way. The instructor's side of this panel is the Done
  // tick and the words of a row she has already opened.
  r.section("7. only Ms. Daisy may add a correction");
  const addFor = (userId) => page.eval(`(async () => {
    const u = window.__app.USERS.find(x => x.id === ${JSON.stringify(userId)});
    window.__app.state.authEmail = u.email;
    let said = null;
    const realAlert = window.alert;
    window.alert = m => { said = String(m); };
    const note = document.getElementById("sticky-note");
    note.classList.remove("hidden");
    window.__app.renderStickyNoteContent(${JSON.stringify(sessionWith(["done", null]))}, false);
    const before = document.querySelectorAll("#sticky-note-rows tr").length;
    document.getElementById("sticky-note-add-row-btn").click();
    await new Promise(r2 => setTimeout(r2, 250));
    const after = document.querySelectorAll("#sticky-note-rows tr").length;
    window.alert = realAlert;
    note.classList.add("hidden");
    return { said, before, after };
  })()`);

  for (const who of ["nigel", "ray"]) {
    const res = await addFor(who);
    r.ok(`${who} is refused`, /Only Ms\. Daisy can add a correction/.test(String(res.said)),
      JSON.stringify(res));
    r.check(`and no row is added for ${who}`, res.after, res.before);
  }
  const daisyAdd = await addFor("daisy");
  r.check("Ms. Daisy is not refused", daisyAdd.said, null);

  // Deleting matters more than the other two: it goes without a trace, so
  // the person a correction was written for must not be able to make it
  // disappear. The confirm() is stubbed so a refused click cannot be
  // mistaken for someone simply cancelling the dialog.
  r.section("7a. and only Ms. Daisy may delete one");
  const delFor = (userId) => page.eval(`(async () => {
    const u = window.__app.USERS.find(x => x.id === ${JSON.stringify(userId)});
    window.__app.state.authEmail = u.email;
    let said = null, asked = false;
    const realAlert = window.alert, realConfirm = window.confirm;
    window.alert = m => { said = String(m); };
    window.confirm = () => { asked = true; return false; };
    const note = document.getElementById("sticky-note");
    note.classList.remove("hidden");
    window.__app.renderStickyNoteContent(${JSON.stringify(sessionWith(["done", null]))}, false);
    document.querySelector("#sticky-note-rows .snote-del-btn").click();
    await new Promise(r2 => setTimeout(r2, 250));
    window.alert = realAlert; window.confirm = realConfirm;
    note.classList.add("hidden");
    return { said, asked };
  })()`);

  for (const who of ["nigel", "ray"]) {
    const res = await delFor(who);
    r.ok(`${who} is refused`,
      /Only Ms\. Daisy can delete a correction/.test(String(res.said)), JSON.stringify(res));
    r.ok(`and ${who} is never even asked to confirm`, res.asked === false, JSON.stringify(res));
  }
  const daisyDel = await delFor("daisy");
  r.check("Ms. Daisy is not refused", daisyDel.said, null);
  // She is not asked to confirm here either, and that is the harness rather
  // than the gate: the note is rendered without a live session, so the
  // handler returns at the missing id a line later. What this pair proves is
  // the difference that matters -- she passes the gate silently, they do not
  // pass it at all.
  r.ok("the refusal is what separates them, not the confirm",
    daisyDel.said === null && daisyDel.asked === false, JSON.stringify(daisyDel));

  r.section("7b. a correction is the same colour whatever its status");
  for (const mode of ["light", "dark"]) {
    await setTheme(mode);
    await settle(250);
    const colours = await page.eval(`(() => {
      const u = window.__app.USERS.find(x => x.id === "daisy");
      window.__app.state.authEmail = u.email;
      const note = document.getElementById("sticky-note");
      note.classList.remove("hidden");
      // One of each status, so every row class is on screen at once.
      window.__app.renderStickyNoteContent(${JSON.stringify(sessionWith([null, "done", "fixed"]))}, false);
      const out = [...document.querySelectorAll("#sticky-note-rows .snote-textarea")]
        .map(el => getComputedStyle(el).color);
      const noteBg = getComputedStyle(note).backgroundColor;
      const faded = [...document.querySelectorAll("#sticky-note-rows .snote-text")]
        .map(el => getComputedStyle(el).opacity);
      note.classList.add("hidden");
      return { out, noteBg, faded };
    })()`);
    r.check(`${mode}: three statuses, one text colour`,
      new Set(colours.out).size, 1);
    r.ok(`${mode}: and none of them is faded`,
      colours.faded.every(o => Number(o) === 1), JSON.stringify(colours.faded));
    const want = mode === "dark" ? 200 : 60;
    const got = lum(colours.out[0]);
    r.ok(`${mode}: the words are ${mode === "dark" ? "near-white" : "near-black"} (${got})`,
      mode === "dark" ? got > want : got < want, JSON.stringify(colours));
    r.ok(`${mode}: and they read against the note behind them`,
      Math.abs(got - lum(colours.noteBg)) > 120,
      `${colours.out[0]} on ${colours.noteBg}`);
  }

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

r.done("Corrections count, ticked bubbles, and the sticky note");
