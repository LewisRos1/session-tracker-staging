// Only one person in a target's Edit Target at a time.
//
// Saving writes the whole student record, so two people in one target
// overwrite each other. Rather than merge two versions afterwards, the second
// person is kept out until the first has finished. Nobody can take a lock from
// somebody else, main teacher or not.
//
//   deno run -A tests/browser/edit-target-lock.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: edit-target-lock.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const settle = (ms = 700) => new Promise(res => setTimeout(res, ms));

const FIX = {
  today: "2026-10-08", sharedStore: true,
  students: [{
    id: "amy", name: "Amy", order: 1,
    targets: [
      { id: "t1", name: "FEDC 1", scale: 3, predefinedActivities: [
        { id: "a1", title: "Greeting", name: "", order: 0, createdOn: "2026-01-01" }] },
      { id: "t2", name: "FEDC 2", scale: 3, predefinedActivities: [
        { id: "a2", title: "Turn taking", name: "", order: 0, createdOn: "2026-01-01" }] },
    ],
  }],
  groups: [], sessions: [],
};

const ray   = await openPage(dir, { verbose: Deno.args.includes("--verbose") });
const daisy = await openPage(dir, { site: ray.site });

const start = async (page, who) => {
  await page.fixture({ ...FIX, authUser: who });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, `home for ${who}`);
  await page.eval(`window.confirm = () => true; window.alert = () => {};`);
};

/** Open a target by its position in the student's list. */
const openTarget = async (page, idx) => {
  await page.eval(`(() => {
    const s = window.__app.state.students.find(x => x.id === "amy");
    window.__app.openManageModal(s, s.targets[${idx}]);
  })()`);
  await settle(900);
};

const modalOpen = (page) => page.eval(
  `!document.getElementById("manage-modal").classList.contains("hidden")`);

const lockMessage = (page) => page.eval(`(() => {
  const el = document.querySelector("[data-lock-wait]");
  return el ? el.innerText.replace(/\\s+/g, " ").trim() : null;
})()`);

const countdown = (page) => page.eval(
  `document.getElementById("mn-lock-timer")?.textContent || null`);

const lockInStore = async () => {
  const res = await fetch(`http://127.0.0.1:${ray.site.port}/__store/editLocks`).then(x => x.json());
  return res.docs.map(d => ({ id: d.id, by: d.holderName }));
};

try {
  r.section("1. the first person in gets the target");

  await start(ray, "rayhanah");
  await start(daisy, "daisy");

  await openTarget(ray, 0);
  r.ok("Rayhanah is in", await modalOpen(ray));
  r.check("and the target is marked as hers", await lockInStore(), [{ id: "amy__t1", by: "Rayhanah" }]);

  r.section("2. the second person is kept out, whoever they are");

  // Watch the modal itself: it must never be shown at all, not shown and then
  // taken away. Opening first and backing out flashed the whole screen up for
  // about half a second, which reads as a fault.
  await daisy.eval(`(() => {
    window.__flashed = false;
    const el = document.getElementById("manage-modal");
    new MutationObserver(() => {
      if (!el.classList.contains("hidden")) window.__flashed = true;
    }).observe(el, { attributes: true, attributeFilter: ["class"] });
  })()`);

  await openTarget(daisy, 0);
  r.ok("Ms. Daisy's window did not stay open", !(await modalOpen(daisy)));
  r.ok("and it never flashed up on the way", !(await daisy.eval(`window.__flashed`)),
    "the window was shown and then taken away again");

  const msg = await lockMessage(daisy);
  r.ok("she is told who is in there and to try again", !!msg && /Rayhanah/.test(msg) && /try again/i.test(msg),
    `she saw: ${JSON.stringify(msg)}`);
  console.log(`        message: ${msg}`);

  r.check("and the lock is still Rayhanah's", await lockInStore(), [{ id: "amy__t1", by: "Rayhanah" }]);

  r.section("3. a different target on the same child is free");

  await daisy.eval(`document.querySelector("[data-lock-wait]")?.remove()`);
  await openTarget(daisy, 1);
  r.ok("Ms. Daisy can edit the other target", await modalOpen(daisy));
  const both = await lockInStore();
  r.check("both targets are held, one each", both.length, 2);

  r.section("4. the countdown, and closing itself");

  // There is no countdown on screen any more -- watching a clock run out while
  // you work is its own small stress, so Lewis asked for it to go. The window
  // still closes, so that is what gets checked.
  //
  // Ten minutes is the real wait. The test shortens it, or it could not be
  // written at all.
  await ray.click("#manage-modal-close");
  await settle(1000);
  await ray.eval(`window.__app.mnSetIdleTimeoutForTests(4000)`);
  await openTarget(ray, 0);
  r.ok("Rayhanah is in again", await modalOpen(ray));

  // Said beside the Done button, not across the top of the list.
  await ray.until(`document.getElementById("mn-lock-countdown")`, "the countdown");
  const beside = await ray.eval(`(() => {
    const el = document.getElementById("mn-lock-countdown");
    const done = document.getElementById("manage-modal-close");
    return { text: el?.textContent || null, rightBeforeDone: el?.nextElementSibling === done };
  })()`);
  r.ok("the countdown sits next to Done", beside.rightBeforeDone,
    `it is not beside the button: ${JSON.stringify(beside)}`);
  r.ok("and reads as a quiet note", /^Auto-closes in \d+:\d\d$/.test(beside.text || ""),
    `it reads ${JSON.stringify(beside.text)}`);
  console.log(`        beside Done: ${beside.text}`);
  r.ok("no banner across the list any more",
    !(await ray.eval(`!!document.querySelector(".mn-lock-banner")`)));

  r.section("4b. looking at it counts as being in it");

  // Lewis: somebody starts at 9pm and is still working at 9:10 -- it must not
  // shut on them because of when they opened it. And he asked that scrolling
  // count, not just typing: reading the list is still being in there.
  await settle(1200);
  await ray.eval(`document.getElementById("manage-modal-body").dispatchEvent(
    new WheelEvent("wheel", { bubbles: true, deltaY: 40 }))`);
  await settle(2600);
  r.ok("a scroll keeps it open past the whole wait", await modalOpen(ray),
    "it closed even though the window had been scrolled");

  await ray.eval(`(() => {
    const el = document.getElementById("mn-t-name");
    el.focus(); el.setSelectionRange(el.value.length, el.value.length);
  })()`);
  await ray.type("x");
  await settle(2600);
  r.ok("so does typing", await modalOpen(ray),
    "it closed even though something had just been typed");
  await ray.key("Backspace");
  await settle(300);

  r.section("4c. left alone, it goes");

  await settle(5200);
  r.ok("the window closed by itself", !(await modalOpen(ray)),
    "it was left alone for longer than the wait and stayed open");
  const freed = await lockInStore();
  r.ok("and the target is free again", !freed.some(l => l.id === "amy__t1"),
    JSON.stringify(freed));

  await ray.eval(`window.__app.mnSetIdleTimeoutForTests(10 * 60 * 1000)`);
  await openTarget(ray, 0);

  r.section("5. letting go");

  await ray.click("#manage-modal-close");
  await settle(1200);
  const after = await lockInStore();
  r.ok("Rayhanah's lock is gone when she presses Done",
    !after.some(l => l.id === "amy__t1"), JSON.stringify(after));

  await daisy.eval(`document.querySelector("[data-lock-wait]")?.remove()`);
  await openTarget(daisy, 0);
  r.ok("and Ms. Daisy can now get in", await modalOpen(daisy));

  r.section("6. a lock from a browser that never came back");

  // Older than the idle wait, which is now ten minutes for this too: a window
  // that is awake gives its lock up after ten idle minutes, and one that is
  // asleep has its taken after the same ten. The two cannot disagree.

  // A lock older than five minutes belongs to a laptop that went to sleep.
  await daisy.click("#manage-modal-close");
  await settle(900);
  await fetch(`http://127.0.0.1:${ray.site.port}/__store/editLocks/amy__t1`, {
    method: "POST",
    body: JSON.stringify({
      id: "amy__t1", ownerId: "amy", targetId: "t1",
      holderId: "nigel", holderName: "Nigel",
      heldAt: Date.now() - (11 * 60 * 1000),
    }),
  });

  await openTarget(ray, 0);
  r.ok("a dead lock does not keep anybody out", await modalOpen(ray));
  const taken = await lockInStore();
  r.ok("and it is taken over", taken.some(l => l.id === "amy__t1" && l.by === "Rayhanah"),
    JSON.stringify(taken));

  // ── console ──────────────────────────────────────────────────────────
  r.section("console");
  for (const [who, page] of [["Rayhanah", ray], ["Ms. Daisy", daisy]]) {
    const noise = page.consoleLines.filter(l => l.level === "error");
    r.ok(`${who}: no console errors`, noise.length === 0,
      noise.slice(0, 4).map(n => n.text.slice(0, 160)).join("\n        "));
  }
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await ray.screenshot("edit-lock-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await daisy.close();
  await ray.close();
}

Deno.exit(r.done() ? 1 : 0);
