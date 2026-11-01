// A sub-activity should look like it belongs to the row above it.
//
// The Start Session screen already draws a parent and its sub-activities as
// one block: the parent's bottom edge is open and each sub carries a 5px
// rail down its left. The View/Edit past session table showed the same thing
// as a flat list, where the only cue was the a) b) in the No. column -- easy
// to miss once a row runs several lines tall, which they do.
//
// So the sub rows now indent and carry the same rail. What this checks is
// that the rail is actually painted (a class name proves nothing on its own),
// that only sub rows get it, and that marking the row did not drop the
// colour classes that were already on it -- the grey Maintain row and the
// green activity row share that same attribute.
//
//   deno run -A tests/browser/view-sub-rail.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: view-sub-rail.test.js <harness-dir>"); Deno.exit(2); }

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
  // Shares the row attribute the rail had to be merged into.
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

  // Build the real table and put it on the page, so the rail is measured as
  // the browser paints it rather than read out of a string.
  const rows = await page.eval(`(() => {
    const s = window.__app.state;
    const target = s.students.find(x => x.id === "s1").targets[0];
    const data = { date: "2026-10-22", studentId: "s1", activities: {}, remarks: {} };
    const host = document.createElement("div");
    host.id = "rail-probe";
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
        railWidth: bar.width,
        railColor: bar.backgroundColor,
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
    r.check(`"${name}" is indented`, row && row.padLeft, "30.4px");   // 1.9rem
    r.ok(`"${name}" has a rail painted beside it`,
      !!row && row.railWidth === "3px", JSON.stringify(row));
    r.ok(`and the rail is actually visible`,
      !!row && row.railColor !== "rgba(0, 0, 0, 0)" && row.railColor !== "transparent",
      JSON.stringify(row && row.railColor));
  }
  r.check("and they are still lettered", [byText("silhoutte")?.no, byText("shit")?.no],
    ["a)", "b)"]);

  r.section("3. and nothing else is");
  const parent = byText("vibe coding");
  r.ok("the parent row is not railed", !!parent && !parent.sub, JSON.stringify(parent));
  r.ok("the parent still spans the table", !!parent && parent.colspan === "5",
    JSON.stringify(parent));
  for (const name of ["NEW NAME", "do it like u"]) {
    const row = byText(name);
    r.ok(`"${name}" is a plain row`, !!row && !row.sub, JSON.stringify(row));
    r.check(`"${name}" is not indented`, row && row.padLeft, parent.padLeft);
  }

  // ── 4. the bug this shape could easily have introduced ──────────────
  //
  // The colour classes and the rail class share one attribute. Building that
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
  const darkRail = await page.eval(`(() => {
    const host = document.getElementById("rail-probe");
    const sub = host && [...host.querySelectorAll("tr.vrow-sub .vcol-act")][0];
    if (!sub) return { missing: true };
    const bar = getComputedStyle(sub, "::before");
    const cell = getComputedStyle(sub);
    const lum = c => { const m = String(c).match(/[0-9]+/g);
      return m ? 0.299*+m[0] + 0.587*+m[1] + 0.114*+m[2] : null; };
    return { rail: bar.backgroundColor, railLum: lum(bar.backgroundColor),
      bg: cell.backgroundColor, bgLum: lum(cell.backgroundColor) };
  })()`);
  r.ok("a sub row is still there to look at", !darkRail.missing, JSON.stringify(darkRail));
  r.ok("the rail is still visible against the row behind it",
    !darkRail.missing && darkRail.railLum !== null
      && Math.abs(darkRail.railLum - darkRail.bgLum) > 40,
    JSON.stringify(darkRail));

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
