// What the Start Session screens actually print for an activity.
//
// Individual and group sessions are parallel features and are meant to show
// the same thing. The group screen printed a sub-activity's title by hand
// instead of going through paDisplayHtml, so a sub-activity's Details were
// never shown there and the bold/underline markers in its title were printed
// raw. This file holds both screens to the same rules.
//
//   deno run -A tests/browser/session-screen-display.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: session-screen-display.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

// act.title is the NAME, act.name is the DETAILS -- see tests/README.md.
const ACTS = [
  { id: "p1", title: "shes so bad", name: "", order: 0, createdOn: "2026-01-01" },
  { id: "s1", title: "tf is this", name: "sub details here",
    parentActivity: "shes so bad", order: 1, createdOn: "2026-08-14" },
  { id: "s2", title: "*bold sub*", name: "second sub details",
    parentActivity: "shes so bad", order: 2, createdOn: "2026-08-14" },
  { id: "a1", title: "", name: "Fah", order: 3, createdOn: "2026-01-01" },
];

const fixture = {
  today: "2026-10-08",
  authUser: "daisy",
  students: [{
    id: "st1", name: "Test Wong", order: 1,
    targets: [{ id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: ACTS }],
  }],
  groups: [{
    id: "g1", name: "test WONG & TEST yas", order: 1, students: ["st1"],
    targets: [{ id: "gt1", name: "FEDC 1", scale: 3, predefinedActivities: ACTS }],
  }],
  sessions: [],
};

/** A session document holding one record per activity, as the app writes them. */
const sessionData = (targetName) => ({
  date: "2026-10-08", targetName,
  activities: Object.fromEntries(ACTS.map((a, i) => [`act${i}`, {
    configId: a.id, targetName, activityName: a.title || a.name,
    parentActivity: a.parentActivity || null, order: i,
  }])),
  remarks: {}, trials: {},
});

const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

try {
  await page.fixture(fixture);
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "the home screen");

  // ══ the group screen ═════════════════════════════════════════════════
  r.section("group Start Session screen");

  const groupHtml = await page.eval(`(() => {
    const s = window.__app.state;
    s.currentGroup = s.groups.find(g => g.id === "g1");
    s.selectedGroupTargetName = "FEDC 1";
    s.groupSessionId = "gsess1";
    s.groupSessionData = ${JSON.stringify(sessionData("FEDC 1"))};
    s.groupAttendees = ["Test Wong"];
    // The screen has to be showing for its container to exist.
    document.getElementById("screen-group-session")?.classList.remove("hidden");
    window.__app.renderGroupTargetContent();
    return document.getElementById("group-target-content")?.innerText || "(no container)";
  })()`);
  await settle(200);

  r.ok("the sub-activity's title is shown", groupHtml.includes("tf is this"),
    `screen reads:\n        ${groupHtml.replace(/\n/g, "\n        ").slice(0, 700)}`);

  r.ok("the sub-activity's DETAILS are shown", groupHtml.includes("sub details here"),
    `a sub-activity's Details were missing from the group screen.\n        screen reads:\n        ${groupHtml.replace(/\n/g, "\n        ").slice(0, 700)}`);

  r.ok("the second sub-activity's details are shown too",
    groupHtml.includes("second sub details"));

  r.ok("bold markers are not printed raw", !groupHtml.includes("*bold sub*"),
    `the title's * markers reached the screen: ${JSON.stringify(groupHtml.slice(0, 300))}`);

  r.ok("an activity with no title still shows its details", groupHtml.includes("Fah"));

  // ══ the individual screen, which must agree ══════════════════════════
  r.section("individual Start Session screen (must match)");

  const indivHtml = await page.eval(`(() => {
    const s = window.__app.state;
    s.currentStudent = s.students.find(x => x.id === "st1");
    s.selectedTargetName = "FEDC 1";
    s.currentSessionId = "sess1";
    s.sessionData = ${JSON.stringify(sessionData("FEDC 1"))};
    document.getElementById("screen-session")?.classList.remove("hidden");
    const target = s.currentStudent.targets[0];
    const html = window.__app.renderFedcTarget(target);
    return Array.isArray(html) ? html.join("") : String(html ?? "");
  })()`);

  const indivText = indivHtml.replace(/<[^>]*>/g, " ");
  r.ok("the sub-activity's details are shown", indivText.includes("sub details here"),
    `individual screen: ${JSON.stringify(indivText.slice(0, 400))}`);
  r.ok("bold markers are not printed raw", !indivText.includes("*bold sub*"));

  // ══ the rule both screens follow ═════════════════════════════════════
  r.section("paDisplayHtml, which both screens use");

  const cases = await page.eval(`(() => {
    const f = window.__app.paDisplayHtml;
    return {
      titleAndDetails: f({ title: "Name", name: "Details" }),
      titleOnly:       f({ title: "Name", name: "" }),
      detailsOnly:     f({ title: "", name: "Details" }),
      withPlaceholder: f({ title: "", name: "Details" }, true),
      boldTitle:       f({ title: "*Name*", name: "Details" }),
      titleOnlyMode:   f({ title: "Name", name: "Details" }, false, true),
    };
  })()`);

  r.ok("title and details both appear",
    cases.titleAndDetails.includes("Name") && cases.titleAndDetails.includes("Details"));
  r.ok("a title with details is bold and underlined",
    /font-weight:700/.test(cases.titleAndDetails) && /underline/.test(cases.titleAndDetails),
    cases.titleAndDetails);
  r.ok("a title with nothing under it stays plain",
    !/underline/.test(cases.titleOnly), cases.titleOnly);
  r.ok("details alone still show", cases.detailsOnly.includes("Details"), cases.detailsOnly);
  r.ok("the placeholder appears only when asked",
    cases.withPlaceholder.includes("Please give this activity a title")
      && !cases.detailsOnly.includes("Please give"), cases.withPlaceholder);
  r.ok("markers in the title become real formatting",
    !cases.boldTitle.includes("*Name*"), cases.boldTitle);
  r.ok("titleOnly mode drops the details line",
    !cases.titleOnlyMode.includes("Details"), cases.titleOnlyMode);

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors during the run", noise.length === 0,
    noise.slice(0, 5).map(n => n.text.slice(0, 160)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("session-screen-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
