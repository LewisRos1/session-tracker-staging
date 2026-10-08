// "+ Add Parent Activity with Sub-activities", from adding it to closing the
// window, in a real browser.
//
// The rules, as the boss set them out:
//
//   - Adding a parent creates the parent and one blank sub-activity, both
//     ready to be clicked.
//   - You name them one at a time: name the parent, Save and Close, THEN open
//     the sub. So a blank sub-activity has to survive Save and Close.
//   - Done clears anything still blank. A named parent whose only
//     sub-activity was never filled in goes with it.
//   - A parent with one real sub and one blank keeps the parent and the real
//     sub; only the blank row goes.
//   - Opening Edit Target clears blank rows too, in case a tab was closed.
//   - A blank sub-activity never appears on a Start Session screen.
//
//   deno run -A tests/browser/parent-sub-lifecycle.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: parent-sub-lifecycle.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

const settle = (ms = 450) => new Promise(res => setTimeout(res, ms));

const fixture = (who = "daisy", acts = null) => ({
  today: "2026-10-08",
  authUser: who,
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [{
      id: "t1", name: "FEDC 1", scale: 3,
      predefinedActivities: acts || [
        { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
      ],
    }],
  }],
  groups: [], sessions: [],
});

async function openEditTarget(who = "daisy", acts = null) {
  await page.fixture(fixture(who, acts));
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-act-card").length >= 1`, "the activity list");
  await settle();
  await page.eval(`window.__dialogs = [];
    window.confirm = m => { window.__dialogs.push(m); return true; };
    window.alert  = m => { window.__dialogs.push(m); };`);
}

/** The target's rows, live and proposed together, as the app holds them. */
const rows = () => page.eval(`(() => {
  const s = window.__app.state.students.find(x => x.id === "amy");
  const t = s.targets[0];
  const all = [
    ...(t.predefinedActivities || []),
    ...(t.pendingActivities || []),
  ];
  return all.map(a => ({
    id: a.id, title: a.title || "", details: a.name || "",
    parentOf: a._linkKey || null, childOf: a.parentActivity || null,
  }));
})()`);

/** What the Edit Target list is showing. */
const onScreen = () => page.eval(`
  [...document.querySelectorAll(".mn-act-card, .mn-sub-compact")]
    .filter(e => e.offsetParent !== null)
    .map(e => {
      const chip = e.querySelector(".mn-row-chip");
      return (chip ? chip.innerText.trim() : "SUB")
        + "|" + (e.querySelector(".mn-act-compact-title, .mn-sub-title-text")?.innerText || "").trim();
    })`);

const addParent = async () => {
  await page.click("#btn-mn-add-parent");
  await settle(900);
};

/** Open a row's panel by its position among the cards, or a sub row. */
async function openRow(selector, index = 0) {
  const hit = await page.eval(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return null;
    const t = el.querySelector(".mn-act-compact-title") || el;
    t.scrollIntoView({ block: "center" });
    const b = t.getBoundingClientRect();
    return { x: b.left + Math.min(40, b.width / 2), y: b.top + b.height / 2 };
  })()`);
  if (!hit) throw new Error(`nothing at ${selector}[${index}]`);
  await page.clickAt(hit.x, hit.y);
  await page.until(`document.querySelector("#mn-act-panel-overlay .mn-act-title-input")`, "a panel");
  await settle();
}

async function setTitle(value) {
  await page.eval(`(() => {
    const el = document.querySelector("#mn-act-panel-overlay .mn-act-title-input");
    el.focus(); el.setSelectionRange(0, el.value.length);
  })()`);
  await page.key("a", { ctrl: true });
  await page.type(value);
  await settle(200);
}

const saveAndClose = async () => {
  await page.click("#mn-act-panel-overlay .mn-act-panel-save");
  await settle(800);
};

const pressDone = async () => {
  await page.click("#manage-modal-close");
  await settle(1200);
};

try {
  // ══ 1. the window has one way out ════════════════════════════════════
  r.section("1. one Done, not two");

  await openEditTarget();
  r.check("the header button says Done",
    await page.eval(`document.getElementById("manage-modal-close")?.innerText.trim()`), "Done");
  r.check("there is no second Done under the list",
    await page.eval(`!!document.getElementById("btn-mn-done-target")`), false);

  // The headings down this screen are one style, not three.
  const headings = await page.eval(`
    [...document.querySelectorAll("#manage-modal .admin-section-title")]
      .filter(e => e.offsetParent !== null)
      .map(e => {
        const cs = getComputedStyle(e);
        return { text: e.innerText.trim(),
                 look: [cs.fontSize, cs.fontWeight, cs.textTransform, cs.letterSpacing, cs.color].join("|") };
      })`);
  r.check("the screen is headed Target Name, Activities & Notes and Add New",
    headings.map(h => h.text), ["TARGET NAME", "ACTIVITIES & NOTES", "ADD NEW"]);
  r.ok("and all three are set the same way",
    new Set(headings.map(h => h.look)).size === 1,
    JSON.stringify(headings, null, 2));

  // ══ 2. a blank sub-activity survives Save and Close ══════════════════
  r.section("2. name the parent, Save and Close, the sub-activity is still there");

  await openEditTarget();
  await addParent();
  const added = await rows();
  r.check("a parent and a sub were added", added.length, 3);

  await openRow(".mn-act-card", 1);          // the new parent
  await setTitle("my parent");
  await saveAndClose();

  const afterSave = await rows();
  const parent = afterSave.find(a => a.title === "my parent");
  const sub    = afterSave.find(a => a.childOf);
  r.ok("the parent kept its name", !!parent, JSON.stringify(afterSave));
  r.ok("the blank sub-activity is still there", !!sub, JSON.stringify(afterSave));
  r.ok("and it still belongs to that parent",
    !!sub && !!parent && sub.childOf === (parent.parentOf || parent.title),
    JSON.stringify(afterSave));

  const screen = await onScreen();
  r.ok("the row still shows as a PARENT ACTIVITY",
    screen.some(x => x.startsWith("PARENT ACTIVITY")), JSON.stringify(screen));
  r.ok("with its sub-activity under it",
    screen.some(x => x.startsWith("SUB")), JSON.stringify(screen));

  // ══ 3. then name the sub-activity ════════════════════════════════════
  r.section("3. now open the sub-activity and name it");

  await openRow(".mn-sub-compact", 0);
  await setTitle("my sub");
  await saveAndClose();

  const named = await rows();
  r.ok("the sub-activity kept its name",
    named.some(a => a.title === "my sub"), JSON.stringify(named));

  await pressDone();
  const kept = await rows();
  r.ok("Done keeps a parent with a real sub-activity",
    kept.some(a => a.title === "my parent") && kept.some(a => a.title === "my sub"),
    JSON.stringify(kept));

  // ══ 4. Done clears a family that was never filled in ═════════════════
  r.section("4. Done removes a named parent whose sub-activity is still blank");

  await openEditTarget();
  await addParent();
  await openRow(".mn-act-card", 1);
  await setTitle("abandoned parent");
  await saveAndClose();
  await pressDone();

  const swept = await rows();
  r.check("only the original activity is left", swept.length, 1);
  r.check("and it is the right one", swept[0]?.title, "Greeting");

  // ══ 5. only the blank row goes when a real sub exists ════════════════
  r.section("5. a parent with one real sub and one blank keeps both parent and real sub");

  await openEditTarget("daisy", [
    { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
    { id: "p1", title: "Voice", name: "", noRemark: true, order: 1, createdOn: "2026-01-01" },
    { id: "s1", title: "Loud", name: "", parentActivity: "Voice", order: 2, createdOn: "2026-01-01" },
    { id: "s2", title: "", name: "", parentActivity: "Voice", order: 3, createdOn: "2026-01-01" },
  ]);
  await pressDone();

  const mixed = await rows();
  r.ok("the parent stayed", mixed.some(a => a.title === "Voice"), JSON.stringify(mixed));
  r.ok("the real sub-activity stayed", mixed.some(a => a.title === "Loud"), JSON.stringify(mixed));
  r.check("the blank one went", mixed.length, 3);

  // ══ 6. opening Edit Target clears what a closed tab left ═════════════
  r.section("6. opening Edit Target clears a blank row left from last time");

  await openEditTarget("daisy", [
    { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
    { id: "p1", title: "Leftover", name: "", noRemark: true, order: 1, createdOn: "2026-01-01" },
    { id: "s1", title: "", name: "", parentActivity: "Leftover", order: 2, createdOn: "2026-01-01" },
  ]);
  await settle(700);

  const onOpen = await rows();
  r.check("the leftover family is gone on open", onOpen.length, 1);
  const shown = await onScreen();
  r.ok("and nothing blank is on screen",
    !shown.some(x => x.endsWith("|") || x.includes("Leftover")), JSON.stringify(shown));

  // ══ 7. an assistant's proposal follows the same rules ════════════════
  r.section("7. the same for a proposal (Rayhanah)");

  await openEditTarget("rayhanah");
  await addParent();
  await openRow(".mn-act-card", 1);
  await setTitle("proposed parent");
  await saveAndClose();

  const proposed = await rows();
  r.ok("the proposed parent kept its name",
    proposed.some(a => a.title === "proposed parent"), JSON.stringify(proposed));
  r.ok("its blank sub-activity survived Save and Close",
    proposed.some(a => a.childOf), JSON.stringify(proposed));

  await pressDone();
  const proposedAfter = await rows();
  r.check("Done clears the unfinished proposal too", proposedAfter.length, 1);

  // ══ 8. deleting a parent takes its sub-activities with it ═══════════
  r.section("8. the kebab's Delete on a parent");

  await openEditTarget("daisy", [
    { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
    { id: "p1", title: "Voice", name: "", noRemark: true, order: 1, createdOn: "2026-01-01" },
    { id: "s1", title: "Loud",   name: "", parentActivity: "Voice", order: 2, createdOn: "2026-01-01" },
    { id: "s2", title: "Quiet",  name: "", parentActivity: "Voice", order: 3, createdOn: "2026-01-01" },
  ]);

  /** Open the kebab on the card at `index` and read its delete entry. */
  const openKebab = async (index) => {
    await page.eval(`(() => {
      const card = document.querySelectorAll(".mn-act-card")[${index}];
      card.querySelector(".mn-kebab-btn").click();
    })()`);
    await settle(350);
    return page.eval(`(() => {
      const btn = [...document.querySelectorAll('.mn-km-opt[data-action="delete"]')]
        .filter(b => b.offsetParent !== null)[0];
      return btn ? btn.innerText.trim() : "(no delete entry)";
    })()`);
  };

  r.check("a plain activity still says Delete Activity",
    await openKebab(0), "🗑️ Delete Activity");

  r.check("a parent says what it will take with it",
    await openKebab(1), "🗑️ Delete Parent Activity & All Its Sub-activities");

  // Press it and work through the confirmation.
  await page.eval(`(() => {
    [...document.querySelectorAll('.mn-km-opt[data-action="delete"]')]
      .filter(b => b.offsetParent !== null)[0].click();
  })()`);
  await page.until(`document.querySelector("#del-type-input")`, "the confirmation box");
  await settle(400);

  const warning = await page.eval(`document.querySelector("[data-del-overlay]")?.innerText || ""`);
  r.ok("the box names the sub-activities", /Loud/.test(warning) && /Quiet/.test(warning),
    `box reads:\n        ${warning.replace(/\n/g, "\n        ").slice(0, 500)}`);

  const word = await page.eval(`document.querySelector("#del-type-input")?.placeholder || ""`);
  await page.eval(`(() => {
    const inp = document.querySelector("#del-type-input");
    inp.focus();
    inp.value = ${JSON.stringify("")};
  })()`);
  await page.type(word);
  await settle(250);
  r.check("the Delete button is enabled once the word matches",
    await page.eval(`document.querySelector("#del-type-ok")?.disabled`), false);

  await page.click("#del-type-ok");
  await settle(1200);

  const left = await rows();
  r.check("the whole family went", left.length, 1);
  r.check("and the untouched activity stayed", left[0]?.title, "Greeting");
  r.ok("no sub-activity was left pointing at a parent that is gone",
    !left.some(a => a.childOf), JSON.stringify(left));

  // ══ 9. the approval buttons do not sit on top of each other ═════════
  //
  // A reviewer sees an Approve / Reject column that an assistant never does,
  // and it is twice the height of a title row. Checking the layout as the
  // assistant only is how a change that stacked the two columns on top of
  // each other got through.
  r.section("9. a proposed parent and sub, laid out for each of them");

  /** Every pending row's box and its button column. */
  const pendingBoxes = () => page.eval(`
    [...document.querySelectorAll(".mn-pending-card")].map(el => {
      const r = el.getBoundingClientRect();
      const foot = el.querySelector(":scope > .mn-pending-foot");
      const f = foot ? foot.getBoundingClientRect() : null;
      return {
        what: el.classList.contains("mn-sub-compact") ? "sub" : "parent",
        box:  [r.left, r.right, r.top, r.bottom].map(Math.round),
        foot: f ? [f.left, f.right, f.top, f.bottom].map(Math.round) : null,
      };
    })`);

  const overlaps = (a, b) =>
    a[0] < b[1] && b[0] < a[1] && a[2] < b[3] && b[2] < a[3];

  for (const who of ["rayhanah", "daisy"]) {
    await page.fixture({
      today: "2026-10-08", authUser: who,
      students: [{
        id: "amy", name: "Amy", order: 1,
        targets: [{
          id: "t1", name: "FEDC 1", scale: 3,
          predefinedActivities: [
            { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" },
          ],
          pendingActivities: [
            { id: "p1", title: "a proposed parent", name: "", noRemark: true,
              _linkKey: "pk1", pendingAtIdx: 1, proposedBy: "ray", createdOn: "2026-10-08" },
            { id: "s1", title: "its sub", name: "", parentActivity: "pk1",
              pendingAtIdx: 2, proposedBy: "ray", createdOn: "2026-10-08" },
          ],
        }],
      }],
      groups: [], sessions: [],
    });
    await page.load();
    await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");
    await page.eval(`(() => {
      const s = window.__app.state.students.find(x => x.id === "amy");
      window.__app.openManageModal(s, s.targets[0]);
    })()`);
    await page.until(`document.querySelectorAll(".mn-pending-card").length >= 2`, "the proposal rows");
    await settle(800);

    const boxes = await pendingBoxes();
    const parentRow = boxes.find(b => b.what === "parent");
    const subRow    = boxes.find(b => b.what === "sub");

    r.ok(`${who}: both rows are on screen`, !!parentRow && !!subRow, JSON.stringify(boxes));

    if (parentRow?.foot && subRow?.foot) {
      r.ok(`${who}: the two button columns do not overlap`,
        !overlaps(parentRow.foot, subRow.foot),
        `parent column ${JSON.stringify(parentRow.foot)}\n        sub column    ${JSON.stringify(subRow.foot)}`);

      r.ok(`${who}: the sub's buttons stay inside its own row`,
        subRow.foot[3] <= subRow.box[3] + 2,
        `row ends at ${subRow.box[3]}, buttons end at ${subRow.foot[3]}`);
    }

    if (parentRow && subRow) {
      // The sub sits inside its parent, so it can never be wider than it.
      r.ok(`${who}: the sub-activity does not stick out of its parent`,
        subRow.box[1] <= parentRow.box[1],
        `parent ends at ${parentRow.box[1]}, sub ends at ${subRow.box[1]}`);
    }
  }

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors during the run", noise.length === 0,
    noise.slice(0, 5).map(n => n.text.slice(0, 160)).join("\n        "));
  const thrown = page.pageErrors.filter(e => !/ServiceWorker|manifest|favicon/i.test(e));
  r.ok("nothing thrown during the run", thrown.length === 0,
    thrown.slice(0, 3).map(e => e.slice(0, 200)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("parent-sub-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
