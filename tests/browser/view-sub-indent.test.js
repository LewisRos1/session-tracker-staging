// A sub-activity should look like it belongs to the row above it.
//
// The View/Edit past session table showed a parent and its subs as a flat
// list, where the only cue was the a) b) in the No. column -- easy to miss
// once a row runs several lines tall, which they do.
//
// Sub rows now indent, by the same amount the Word export uses, so the
// screen and the document agree. They briefly carried a rail down the left
// as well, the way the Start Session screen marks a sub, but a table draws
// a border between every row: the rail came out as one short tick per row
// instead of a line down the group, and read as a stray mark.
//
// What this checks is that the indent is measured as the browser applies it
// (a class name proves nothing on its own), that only sub rows get it, and
// that marking the row did not drop the colour classes that were already on
// it -- the grey Maintain row and the green activity row share that same
// attribute.
//
//   deno run -A tests/browser/view-sub-indent.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: view-sub-indent.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

const ACTS = [
  { id: "a1", title: "NEW NAME I GUESS", name: "", order: 0, createdOn: "2026-01-01" },
  { id: "p1", title: "vibe coding", name: "", noRemark: true, order: 1, createdOn: "2026-01-01" },
  { id: "s1", title: "silhoutte incredible", name: "sadddddddddddddd",
    parentActivity: "vibe coding", order: 2, createdOn: "2026-01-01" },
  { id: "s2", title: "shit", name: "yup",
    parentActivity: "vibe coding", order: 3, createdOn: "2026-01-01" },
  { id: "a2", title: "do it like u", name: "", order: 4, createdOn: "2026-01-01" },
  // Shares the row attribute the sub marker had to be merged into.
  { id: "g1", title: "a grey one", name: "", order: 5, createdOn: "2026-01-01",
    activityColor: "gray" },
  { id: "s3", title: "a grey sub", name: "", parentActivity: "vibe coding",
    order: 6, createdOn: "2026-01-01", activityColor: "gray" },
];

try {
  await page.fixture({
    today: "2026-11-01", authUser: "daisy",
    students: [{ id: "s1", name: "TEST yas", order: 1,
      targets: [{ id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: ACTS }] }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // Build the real table and put it on the page, so the indent is measured as
  // the browser paints it rather than read out of a string.
  const rows = await page.eval(`(() => {
    const s = window.__app.state;
    const target = s.students.find(x => x.id === "s1").targets[0];
    const data = { date: "2026-10-22", studentId: "s1", activities: {}, remarks: {} };
    const host = document.createElement("div");
    host.id = "sub-probe";
    host.innerHTML = String(window.__app.buildTargetViewTable(target, data) ?? "");
    document.body.appendChild(host);
    return [...host.querySelectorAll("tr")].map(tr => {
      const act = tr.querySelector(".vcol-act");
      const no = tr.querySelector(".vcol-no");
      if (!act) return null;
      const cs = getComputedStyle(act);
      const bar = getComputedStyle(act, "::before");
      return {
        text: act.textContent.replace(/\\s+/g, " ").trim().slice(0, 28),
        no: (no?.textContent || "").trim(),
        cls: tr.className,
        sub: tr.classList.contains("vrow-sub"),
        padLeft: cs.paddingLeft,
        elbowLeft: bar.borderLeftWidth,
        elbowColor: bar.borderLeftColor,
        armBottom: getComputedStyle(act, "::after").borderBottomWidth,
        colspan: act.getAttribute("colspan"),
      };
    }).filter(Boolean);
  })()`);

  const byText = t => rows.find(x => x.text.includes(t));

  r.section("1. the rows the table built");
  r.ok("the parent and both subs are there",
    !!byText("vibe coding") && !!byText("silhoutte") && !!byText("shit"),
    JSON.stringify(rows.map(x => x.text)));

  r.section("2. a sub-activity is marked and indented");
  for (const name of ["silhoutte", "shit"]) {
    const row = byText(name);
    r.ok(`"${name}" is marked as a sub`, !!row && row.sub, JSON.stringify(row));
    r.check(`"${name}" is indented`, row && row.padLeft, "33.6px");   // 1.9rem
    r.ok(`"${name}" has an upright beside it`,
      !!row && row.elbowLeft === "2px", JSON.stringify(row));
    r.ok(`and an arm reaching into the text`,
      !!row && row.armBottom === "2px", JSON.stringify(row));
    r.ok(`and it is actually visible`,
      !!row && row.elbowColor !== "rgba(0, 0, 0, 0)",
      JSON.stringify(row && row.elbowColor));
  }
  r.check("and they are still lettered", [byText("silhoutte")?.no, byText("shit")?.no],
    ["a)", "b)"]);

  r.section("3. and nothing else is");
  const parent = byText("vibe coding");
  r.ok("the parent row is not indented", !!parent && !parent.sub, JSON.stringify(parent));
  r.ok("the parent still spans the table", !!parent && parent.colspan === "5",
    JSON.stringify(parent));
  for (const name of ["NEW NAME", "do it like u"]) {
    const row = byText(name);
    r.ok(`"${name}" is a plain row`, !!row && !row.sub, JSON.stringify(row));
    r.check(`"${name}" is not indented`, row && row.padLeft, parent.padLeft);
    r.check(`"${name}" has no upright`, row && row.elbowLeft, "0px");
    r.check(`"${name}" has no arm either`, row && row.armBottom, "0px");
  }

  // ── 3b. the elbow has to fit in the space the indent makes ──────────
  //
  // Measured rather than reasoned about: the elbow is positioned and the
  // text is padded by two separate numbers, and if they ever cross, the L
  // is drawn through the first letter of the activity name.
  // ── 3a. the thing Lewis actually asked for ──────────────────────────
  //
  // The elbows have to join up into one line down the group. This is the
  // check that cannot be done by reading CSS: the uprights are laid out
  // inside each cell's padding box, and border-collapse puts a shared 1px
  // line between the rows, so without a deliberate bleed every upright
  // stops short at both ends and the line comes out dashed. Measured as
  // painted rectangles, and the gap between one upright and the next has
  // to be zero or less.
  r.section("3a. the uprights join into one line");
  const chain = await page.eval(`(() => {
    const px = v => parseFloat(v) || 0;
    // A pseudo-element has no rect of its own, so build it: the cell's
    // padding box, offset by the resolved top and bottom. getComputedStyle
    // hands both back in pixels, so a 50% bottom arrives already worked out.
    const upright = (tr) => {
      const cell = tr.querySelector(".vcol-act");
      const cs = getComputedStyle(cell);
      const bar = getComputedStyle(cell, "::before");
      const r = cell.getBoundingClientRect();
      const padTop = r.top + px(cs.borderTopWidth);
      const padBottom = r.bottom - px(cs.borderBottomWidth);
      return {
        top: padTop + px(bar.top),
        bottom: padBottom - px(bar.bottom),
        padBottom,
        height: padBottom - padTop,
      };
    };
    const rows = [...document.querySelectorAll("#sub-probe tr")];
    const out = [];
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].classList.contains("vrow-sub")) continue;
      const me = upright(rows[i]);
      const nextIsSub = rows[i + 1] && rows[i + 1].classList.contains("vrow-sub");
      out.push({
        // Does it stop short of the row's bottom? That is the L.
        closed: me.padBottom - me.bottom > me.height * 0.25,
        nextIsSub: !!nextIsSub,
        // Only a sub immediately followed by another sub has a join to make.
        gap: nextIsSub
          ? Math.round((upright(rows[i + 1]).top - me.bottom) * 10) / 10
          : null,
      });
    }
    return out;
  })()`);
  r.ok("there are subs to look at", chain.length >= 2, JSON.stringify(chain));
  const joins = chain.filter(c => c.nextIsSub);
  r.ok("a sub followed by another sub has no gap between the uprights",
    joins.length > 0 && joins.every(c => c.gap <= 0), JSON.stringify(chain));
  // Closing the last one is what stops the line running on past the group
  // and into the next activity.
  r.ok("a sub followed by another sub runs the full row",
    chain.filter(c => c.nextIsSub).every(c => !c.closed), JSON.stringify(chain));
  r.ok("and the last sub of a group closes off into an L",
    chain.filter(c => !c.nextIsSub).every(c => c.closed), JSON.stringify(chain));

  r.section("3b. the elbow does not run into the text");
  const fit = await page.eval(`(() => {
    const cell = document.querySelector("#sub-probe tr.vrow-sub .vcol-act");
    if (!cell) return { missing: true };
    const cs = getComputedStyle(cell);
    const bar = getComputedStyle(cell, "::before");
    const px = v => parseFloat(v) || 0;
    const elbowRight = px(bar.left) + px(bar.width) + px(bar.borderLeftWidth);
    return {
      textStartsAt: px(cs.paddingLeft),
      elbowEndsAt: elbowRight,
      gap: px(cs.paddingLeft) - elbowRight,
      // The arm meets the middle, because the cells centre their content.
      armAt: getComputedStyle(cell, "::after").top,
      cellH: Math.round(cell.getBoundingClientRect().height),
    };
  })()`);
  r.ok("the elbow is measurable", !fit.missing, JSON.stringify(fit));
  r.ok("and the text starts clear of it",
    !fit.missing && fit.gap > 2, JSON.stringify(fit));
  r.ok("with the arm at the middle of the row, where the text sits",
    !fit.missing && Math.abs(parseFloat(fit.armAt) - fit.cellH / 2) < 2,
    JSON.stringify(fit));

  // ── 4. the bug this shape could easily have introduced ──────────────
  //
  // The colour classes and the sub class share one attribute. Building that
  // attribute wrongly would silently drop view-gray-row, and a Maintain row
  // would stop being grey -- which nothing else in the suite would notice.
  r.section("4. the colour classes survived");
  const grey = byText("a grey one");
  r.ok("a grey row is still grey", !!grey && /view-gray-row/.test(grey.cls),
    JSON.stringify(grey));
  const greySub = byText("a grey sub");
  r.ok("a grey SUB keeps both its classes",
    !!greySub && /view-gray-row/.test(greySub.cls) && greySub.sub,
    JSON.stringify(greySub));
  r.ok("and no row has a stray empty class attribute",
    rows.every(x => x.cls === "" || !/^\s|\s\s|\s$/.test(x.cls)),
    JSON.stringify(rows.map(x => `"${x.cls}"`)));

  r.section("5. in dark mode too");
  await page.eval(`document.querySelector('.theme-opt[data-theme="dark"]').click()`);
  await new Promise(res => setTimeout(res, 400));
  const dark = await page.eval(`(() => {
    const host = document.getElementById("sub-probe");
    const sub = host && host.querySelector("tr.vrow-sub .vcol-act");
    const plain = host && [...host.querySelectorAll("tr:not(.vrow-sub) .vcol-act")]
      .find(c => !c.getAttribute("colspan"));
    if (!sub || !plain) return { missing: true };
    return { sub: getComputedStyle(sub).paddingLeft,
      plain: getComputedStyle(plain).paddingLeft };
  })()`);
  r.ok("a sub row is still there to look at", !dark.missing, JSON.stringify(dark));
  r.check("and still indented", dark.sub, "33.6px");
  r.ok("while a plain row is not", !dark.missing && dark.plain !== dark.sub,
    JSON.stringify(dark));

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

r.done("Sub-activities in the View table");
