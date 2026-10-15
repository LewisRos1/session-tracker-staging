// The kebab menu, on a laptop that is not very tall.
//
// The menu hangs off its own row, so a long one near the bottom of the
// window fell off the screen. Flipping it above the button fixed that end
// and broke the other: on a shorter screen the top slid up under the Edit
// Target header, and "Activity Mastered" -- the first item, and the one
// people reach for -- was the one covered.
//
// Measured on a 700-pixel-tall window. A test on a tall one would never see
// it, which is why Lewis found this on another laptop and not here.
//
//   deno run -A tests/browser/kebab-menu-position.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: kebab-menu-position.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const settle = (ms = 400) => new Promise(res => setTimeout(res, ms));

// Enough activities that the last rows sit near the bottom of a short window.
const acts = Array.from({ length: 9 }, (_, i) => ({
  id: "a" + i, title: "Activity " + (i + 1), name: "", order: i,
  createdOn: "2026-01-01", activeFrom: "2026-01-01",
}));

try {
  await page.fixture({
    today: "2026-10-13", authUser: "daisy",
    students: [{
      id: "caden", name: "Caden Tan", order: 1,
      targets: [{ id: "t1", name: "English", scale: 3, predefinedActivities: acts }],
    }],
    groups: [], sessions: [],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // A short window, which is the whole point.
  await page.resize(1280, 700);
  await settle(200);
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "caden");
    window.__app.openManageModal(s, s.targets[0]);
  })()`);
  await page.until(`document.querySelectorAll(".mn-kebab-btn").length >= 5`, "the activity rows");
  await settle(500);

  /**
   * Open one row's menu and measure where it landed.
   *
   * The row is scrolled into view first, because that is the only kind of
   * button a person can click. Clicking one that is still below the fold
   * measures a position nobody will ever see.
   */
  const openAt = async (which) => {
    // Shut whatever is open first. Clicking the same kebab twice toggles it,
    // so without this the second call measures a menu that is not there.
    // Shut them by hand: a click on the body does not always reach the
    // handler, and a menu left open is the one the measurement then finds.
    await page.eval(`(() => {
      document.querySelectorAll(".mn-kebab-menu, .mn-sub-kebab-menu, .mn-inactive-km")
        .forEach(m => { m.style.display = "none"; });
      document.body.click();
    })()`);
    await settle(150);
    await page.eval(`(() => {
      const btns = [...document.querySelectorAll(".mn-kebab-btn")];
      const btn = ${JSON.stringify(which)} === "last" ? btns[btns.length - 1] : btns[0];
      btn.scrollIntoView({ block: ${JSON.stringify(which)} === "last" ? "end" : "start" });
    })()`);
    await settle(250);
    await page.eval(`(() => {
      const btns = [...document.querySelectorAll(".mn-kebab-btn")];
      const btn = ${JSON.stringify(which)} === "last" ? btns[btns.length - 1] : btns[0];
      btn.click();
    })()`);
    await settle(350);
    return await page.eval(`(() => {
      const menu = [...document.querySelectorAll(".mn-kebab-menu")]
        .find(m => m.style.display === "block");
      if (!menu) return null;
      const m = menu.getBoundingClientRect();
      const head = document.querySelector("#manage-modal .modal-header").getBoundingClientRect();
      const first = menu.querySelector("button, a, div[data-act]") || menu.firstElementChild;
      const f = first ? first.getBoundingClientRect() : null;
      return {
        top: Math.round(m.top), bottom: Math.round(m.bottom),
        headerBottom: Math.round(head.bottom),
        viewport: window.innerHeight,
        firstItemTop: f ? Math.round(f.top) : null,
        firstItemText: first ? first.textContent.replace(/\\s+/g, " ").trim().slice(0, 24) : null,
        scrolls: getComputedStyle(menu).overflowY,
      };
    })()`);
  };

  r.section("a row near the top");
  const top = await openAt("first");
  r.ok("the menu opened", !!top, "no menu is showing");
  r.ok("it does not run off the bottom of the window",
    top.bottom <= top.viewport, JSON.stringify(top));
  r.ok("nor up under the header",
    top.top >= top.headerBottom, JSON.stringify(top));

  r.section("a row near the bottom, which is where it flipped");
  const bottom = await openAt("last");
  r.ok("the menu opened", !!bottom, "no menu is showing");
  r.ok("it does not run off the bottom of the window",
    bottom.bottom <= bottom.viewport, JSON.stringify(bottom));
  // The exact fault: flipped up, the top went above the header and the
  // header -- which is painted over it -- hid the first item.
  r.ok("nor up under the header",
    bottom.top >= bottom.headerBottom, JSON.stringify(bottom));
  r.ok("so the first item is reachable",
    bottom.firstItemTop !== null && bottom.firstItemTop >= bottom.headerBottom,
    `first item "${bottom.firstItemText}" at ${bottom.firstItemTop}, `
    + `header ends at ${bottom.headerBottom}`);

  // ── the case Lewis actually hit ─────────────────────────────────────
  // His menu carried the two-line "Not available: this activity has data in
  // 31 sessions" note, which makes it a good deal taller, on a laptop with
  // a good deal less height. Once a menu is taller than the room between
  // the header and the bottom of the window, neither side fits, and the old
  // rule -- flip up whenever the bottom would overflow -- put the top under
  // the header and hid "Activity Mastered".
  //
  // Forced here rather than recreated pixel by pixel: the rule is what
  // matters, and it has to hold for any menu on any screen.
  r.section("a menu too tall for either side");
  await page.eval(`(() => {
    const st = document.createElement("style");
    st.id = "tall-menu";
    // Taller by its CONTENT, the way a real one is -- his carried a
    // two-line "Not available" note. A min-height would be the wrong test:
    // CSS min-height beats max-height, so it would defeat the clamp and
    // fail whatever the code did.
    st.textContent = ".mn-kebab-menu > * { padding-top: 34px !important;"
      + " padding-bottom: 34px !important; }";
    document.head.appendChild(st);
  })()`);
  const tall = await openAt("last");
  r.ok("the menu opened", !!tall, "no menu is showing");
  r.ok("its top is still below the header",
    tall.top >= tall.headerBottom, JSON.stringify(tall));
  r.ok("its bottom is still inside the window",
    tall.bottom <= tall.viewport, JSON.stringify(tall));
  r.ok("so the first item can be reached",
    tall.firstItemTop !== null && tall.firstItemTop >= tall.headerBottom,
    `first item "${tall.firstItemText}" at ${tall.firstItemTop}, `
    + `header ends at ${tall.headerBottom}`);
  r.ok("and the rest of it is reachable by scrolling",
    tall.scrolls === "auto" || tall.scrolls === "scroll",
    `overflow-y is ${tall.scrolls}`);
  await page.eval(`document.getElementById("tall-menu")?.remove()`);

  // ── no scrolling when the window has room ───────────────────────────
  //
  // The boss went looking for Delete Activity in a menu that had quietly
  // become a 120px scrolling window. A menu that fits between the header and
  // the bottom of the screen is shown whole, off the card if need be.
  r.section("a long menu on a short screen is shown whole");

  const whole = await openAt("last");
  r.ok("the menu opened", !!whole, "no menu is showing");
  r.ok("it does not scroll", whole && whole.scrolls !== "auto" && whole.scrolls !== "scroll",
    JSON.stringify(whole));
  r.ok("and all of it is on screen",
    whole && whole.top >= whole.headerBottom && whole.bottom <= whole.viewport,
    JSON.stringify(whole));

  // ── in front of the card below it ───────────────────────────────────
  //
  // A card waiting for approval puts its Approve / Reject strip on its own
  // layer. The NEXT card's strip painted over a menu hanging out of the one
  // above it, so half the menu was behind a yellow "Waiting for approval".
  r.section("a menu opened above a card that is waiting for approval");

  const covered = await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "caden");
    const acts = s.targets[0].predefinedActivities;
    // The last two rows proposed by somebody else, as an assistant's would be.
    for (const a of acts.slice(-2)) { a._pending = true; a.proposedBy = "rayhanah"; }
    window.__app.openManageModal(s, s.targets[0]);
    return acts.length;
  })()`);
  r.ok("the target still has its activities", covered === 9, String(covered));
  await settle(400);

  const stacking = await page.eval(`(() => {
    const btns = [...document.querySelectorAll(".mn-kebab-btn")];
    const btn = btns[btns.length - 2];
    if (!btn) return { error: "no second-to-last kebab" };
    btn.scrollIntoView({ block: "center" });
    btn.click();
    const menu = [...document.querySelectorAll(".mn-kebab-menu")]
      .find(m => m.style.display === "block");
    if (!menu) return { error: "no menu opened" };
    const m = menu.getBoundingClientRect();
    // What the browser says is actually drawn at the middle of the menu. If a
    // badge is on top, this is the badge.
    const x = Math.round(m.left + m.width / 2);
    const y = Math.round(m.top + m.height / 2);
    const hit = document.elementFromPoint(x, y);
    return {
      inMenu: !!(hit && menu.contains(hit)),
      hitClass: hit ? (hit.className || hit.tagName) : "(nothing)",
      lifted: !!btn.closest(".mn-km-lifted"),
    };
  })()`);

  r.ok("the middle of the menu is the menu, not something on top of it",
    stacking.inMenu === true, JSON.stringify(stacking));
  r.ok("and the card it belongs to was lifted above its neighbours",
    stacking.lifted === true, JSON.stringify(stacking));

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("kebab-menu-position-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
