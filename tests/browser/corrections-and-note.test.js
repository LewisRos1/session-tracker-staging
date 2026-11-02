// Four things Lewis found on live, in one place because two of them turned
// out to be the same bug.
//
//   1. "List of Corrections - Rayhanah (0 to check)" sat beside two
//      corrections nobody had touched. The number was Ms. Daisy's own
//      workload, and both rows were on Needs Revision, which is the
//      instructor's turn -- so nought was true and told her the wrong
//      thing.
//
//      The pill no longer counts what is on the reader's plate at all.
//      "to correct" means rows on Needs Revision and "to approve" means
//      rows on Done, whoever is signed in, so two people can talk about
//      what it says and neither half goes unmentioned.
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

const buttonInfo = (data, asUser) => page.eval(`(() => {
  const u = window.__app.USERS.find(x => x.id === ${JSON.stringify(asUser)});
  if (u) window.__app.state.authEmail = u.email;
  const host = document.createElement("div");
  host.innerHTML = String(window.__app.renderCheckedByStripHtml(${JSON.stringify(data)}, null, false) ?? "");
  const btn = [...host.querySelectorAll(".wf-note-btn")]
    .find(b => /Corrections/.test(b.textContent));
  if (!btn) return null;
  return {
    text: btn.textContent.replace(/\\s+/g, " ").trim(),
    // Red means there is work here, green means it is done, grey means
    // nobody has looked yet.
    colour: /--red/.test(btn.className) ? "red"
      : /--green/.test(btn.className) ? "green"
      : /--grey/.test(btn.className) ? "grey" : "none",
  };
})()`);
const buttonText = async (d, u) => (await buttonInfo(d, u))?.text ?? null;

// The same session with Rayhanah's Phase 3 ticked. The pill does not hand
// the list to Ms. Daisy until that click lands.
const ticked = d => ({ ...d, checks: { ...d.checks, p3_ray: { by: "ray", at: 3 } } });

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

  // -- 1. what the pill says ------------------------------------------
  //
  // Only three states say anything in words. These pills are read as a
  // row of them under the chart, so a sentence on every one is four
  // sentences to get through before you find the one that wants you. The
  // rest carry their state in the colour and say nothing.
  r.section("1. the corrections pill says what is outstanding");
  // What the whole button reads, for a state whose words are `words`.
  const pill = words =>
    `\u{1F4DD} Corrections – Rayhanah${words ? ` (${words})` : ""}`;
  const states = [
    ["", "grey", sessionWith([], "none"),
     "before the instructor has entered anything"],
    ["", "grey", sessionWith([], "entered"),
     "entered, but Ms. Daisy has not looked"],
    ["", "green", sessionWith([], "checked"),
     "checked, and she found nothing wrong"],
    ["All Approved", "green", sessionWith(["fixed", "fixed"], "checked"),
     "she wrote some and signed them all off"],
    ["2", "red", sessionWith([null, null]),
     "two written, neither fixed"],
    ["", "red", sessionWith(["done", "done"]),
     "both fixed, but Phase 3 not ticked"],
    ["2 to approve", "red", ticked(sessionWith(["done", "done"])),
     "both fixed and Phase 3 ticked"],
  ];
  for (const [words, colour, data, why] of states) {
    const info = await buttonInfo(data, "daisy");
    r.check(`${why} -> "${pill(words)}"`, info && info.text, pill(words));
    r.check(`and it is ${colour}`, info && info.colour, colour);
  }

  // The four quiet states are quiet, not blank: the name is still there to
  // click, and the colour still says which of the four it is.
  r.section("1a. a quiet pill is still a pill");
  for (const [words, , data, why] of states.filter(st => st[0] === "")) {
    const info = await buttonInfo(data, "daisy");
    r.check(`${why}: no bracket`, /\(/.test(info.text), false);
    r.ok(`${why}: the name is still on it`,
      /Corrections – Rayhanah$/.test(info.text), info.text);
    r.ok(`${why}: and it still opens the list`, info.colour !== "none",
      JSON.stringify(info));
  }
  // Three of them look the same but for the colour, so the colour has to
  // actually differ.
  const quietColours = [];
  for (const [, , data] of states.filter(st => st[0] === "")) {
    quietColours.push((await buttonInfo(data, "daisy")).colour);
  }
  r.check("grey before anyone has read it, twice over",
    quietColours.slice(0, 2), ["grey", "grey"]);
  r.check("green when there was nothing wrong", quietColours[2], "green");
  r.check("red when it is only the tick that is missing", quietColours[3], "red");

  // Two untouched corrections used to read "0 to check", because both sat
  // on Needs Revision and Ms. Daisy was holding neither of them.
  const twoOpen = await buttonText(sessionWith([null, null]), "daisy");
  r.ok("two untouched corrections never read as nought",
    !!twoOpen && !/\b0\b/.test(twoOpen), String(twoOpen));

  // One is one.
  r.check("one to correct",
    (await buttonInfo(sessionWith([null]), "daisy")).text, pill("1"));
  r.check("one to approve",
    (await buttonInfo(ticked(sessionWith(["done"])), "daisy")).text,
    pill("1 to approve"));

  // The rename, while we are reading the label.
  r.ok("the pill is called Corrections, not List of Corrections",
    !/List of Corrections/.test(String(twoOpen)), String(twoOpen));

  // -- 1b. a list holding both names the instructor's half ------------
  //
  // Phase 3 cannot be ticked until the Needs Revision rows are gone, so
  // that is the half still asking for something. It hands over on the tick,
  // not on the last row being fixed -- and goes quiet in the gap between
  // the two, rather than saying "0".
  r.section("1b. a list holding both names the instructor's half");
  r.check("one fixed, one still to correct",
    (await buttonInfo(sessionWith(["done", null]), "daisy")).text, pill("1"));
  r.check("one approved, one still to correct",
    (await buttonInfo(sessionWith(["fixed", null]), "daisy")).text, pill("1"));
  r.check("nothing left to correct, and ticked, so it is hers",
    (await buttonInfo(ticked(sessionWith(["fixed", "done"])), "daisy")).text,
    pill("1 to approve"));
  // The gap: everything fixed, the tick not yet pressed. Nobody has a
  // number to show, so it shows none.
  r.check("the last one fixed, Phase 3 not ticked",
    (await buttonInfo(sessionWith(["done", "done"]), "daisy")).text, pill(""));
  r.check("and never reads as nought",
    /0/.test((await buttonInfo(sessionWith(["done", "done"]), "daisy")).text),
    false);
  // She can approve a row outright, without it ever being marked Done. The
  // tick is then nothing to wait for, because nothing is on her plate.
  r.check("every row approved outright, Phase 3 never ticked",
    (await buttonInfo(sessionWith(["fixed", "fixed"]), "daisy")).text,
    pill("All Approved"));

  // -- 1c. it reads the same to everybody -----------------------------
  //
  // It used to count the reader's own workload: "1 to check" for Ms. Daisy
  // and "1 to fix" for Rayhanah off one list, with the other half going
  // unmentioned.
  r.section("1c. the pill says the same thing to everybody");
  for (const [words, , data, why] of states) {
    r.check(`${why}, read by Rayhanah`,
      (await buttonInfo(data, "ray")).text, pill(words));
  }
  r.check("and a mixed list too",
    (await buttonInfo(sessionWith(["done", null]), "ray")).text, pill("1"));

  // -- 1d. the pill sits under the chart, one per instructor ----------
  r.section("1d. one pill per instructor, under the chart");
  const placing = await page.eval(`(() => {
    const host = document.createElement("div");
    host.innerHTML = String(window.__app.renderCheckedByStripHtml(
      ${JSON.stringify({ ...sessionWith([null]), participants: ["ray", "nigel"] })},
      null, false) ?? "");
    const wrap = host.querySelector(".wf-note-wrap");
    const p3 = [...host.querySelectorAll(".wf-node")]
      .find(n => /Phase 3/.test(n.textContent));
    return {
      pills: wrap ? [...wrap.querySelectorAll(".wf-note-btn")].length : 0,
      inPhase3: p3 ? p3.querySelectorAll(".wf-note-btn").length : -1,
      phase3Text: p3 ? p3.textContent.replace(/\\s+/g, " ").trim() : null,
    };
  })()`);
  r.check("one pill each for the two instructors", placing.pills, 2);
  r.check("and none of them inside the Phase 3 box", placing.inPhase3, 0);
  // Plain name pills, as before the cards. Nigel's Phase 2 is not ticked in
  // this fixture, so his row is the locked one.
  r.ok("which still holds the plain name pills",
    /Rayhanah: Incomplete/.test(String(placing.phase3Text))
    && /Nigel: Check #1 not done yet/.test(String(placing.phase3Text)),
    String(placing.phase3Text));

  // -- 1e. Export to Word waits for the phases ------------------------
  //
  // The button had no check on it at all. You could open a session nobody
  // had looked at, sitting in Phase 1, and send the note out -- which is
  // the whole thing the five phases exist to stop, two clicks from the
  // screen showing them all unfinished. Phase 5 is locked until the four
  // before it are done; the button sits outside the chart and was not
  // covered by that lock.
  r.section("1e. Export to Word is refused until Phase 4 is done");
  const ready = data => page.eval(
    `!!window.__app.getWorkflowState(${JSON.stringify(data)}).ready`);

  // One instructor, one approved correction, carried as far as phase `n`.
  // A real session can only ever be a prefix like this -- Ms. Daisy cannot
  // do Check #2 on a revision that has not happened -- which is why
  // ws.ready gets away with testing only Phase 1 and Phase 4.
  const CHECKS = [
    ["p1_ray",       { by: "ray",   at: 1 }],
    ["p2_check_ray", { by: "daisy", at: 2 }],
    ["p3_ray",       { by: "ray",   at: 3 }],
    ["p4_check_ray", { by: "daisy", at: 4 }],
  ];
  const upTo = n => ({
    ...sessionWith(["fixed"], "checked"),
    checks: Object.fromEntries(CHECKS.slice(0, n)),
  });

  r.check("nothing entered: refused",        await ready(upTo(0)), false);
  r.check("entered, not checked: refused",   await ready(upTo(1)), false);
  r.check("checked, not revised: refused",   await ready(upTo(2)), false);
  r.check("revised, no Check #2: refused",   await ready(upTo(3)), false);
  r.check("every phase done: allowed",       await ready(upTo(4)), true);

  // An instructor Ms. Daisy marked as needing no revisions skips Phases 3
  // and 4, so neither may hold the export up. Without this every clean
  // session would be blocked for good.
  r.check("no revisions needed skips Phase 3 and Phase 4", await ready({
    ...sessionWith([], "checked"),
    checks: { p1_ray: { by: "ray", at: 1 }, p2_check_ray: { by: "daisy", at: 2 },
              no_corr_ray: { by: "daisy", at: 2 } },
  }), true);

  // Two instructors: one behind is enough to hold it.
  r.check("one instructor behind blocks it",
    await ready({ ...upTo(4), participants: ["ray", "nigel"] }), false);

  // The refusal itself: one line, and it stops before the password prompt
  // and the export. Both screens go through this one handler.
  const src = await Deno.readTextFile("app.js");
  r.check("the refusal is a single sentence",
    /const EXPORT_NOT_READY_MSG = "You can export to Word once Phase 4 is complete\.";/
      .test(src), true);
  r.check("it does not name the phase that is behind, or who",
    /EXPORT_NOT_READY_MSG[\s\S]{0,200}not done yet/.test(src), false);
  r.ok("the button checks before it does anything else",
    /closest\("\.chk-export-btn"\);[\s\S]{0,400}?if \(!getWorkflowState\(getData\(\)\)\.ready\) \{[\s\S]{0,80}?alert\(EXPORT_NOT_READY_MSG\);[\s\S]{0,40}?return true;[\s\S]{0,40}?\}[\s\S]{0,40}?requirePassword\(/
      .test(src), "the gate sits between the button and requirePassword");

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
