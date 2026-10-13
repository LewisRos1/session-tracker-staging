// The Undo button has to be VISIBLE, not merely present.
//
// It shipped twice without being seen. The second time the markup was right,
// the CSS was right, and the tests passed -- because they read styles.css as
// text and found the rule. What they could not see was a dead
// `.snote-undo-btn { display: none }` left over from an older sticky note,
// sitting LATER in the same file, quietly winning. The button was in the
// page the whole time, 0 by 0 pixels.
//
// So this one asks the browser, not the stylesheet.
//
//   deno run -A tests/browser/sticky-note-undo.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: sticky-note-undo.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

// A row that says Done, and a row that does not. The real markup, against
// the real stylesheet the harness already loads.
const ROWS = `
<div class="snote-list-scroll" style="width:580px">
<table class="snote-table"><tbody>
  <tr class="snote-row snote-row--waiting">
    <td class="snote-no">1</td>
    <td class="snote-text"><textarea class="snote-textarea" rows="1">done row</textarea></td>
    <td class="snote-tick"><div class="snote-tick-wrap">
      <select class="snote-status-sel snote-status--waiting" id="sel-done">
        <option>Ms. Daisy: "Needs Revision"</option>
        <option>Ms. Daisy: "Approved"</option>
        <option selected>Rayhanah: "Done"</option>
      </select><button class="snote-undo-btn" id="undo">&#8630; Revert back to Needs Revision</button>
    </div></td>
    <td class="snote-del"><button class="snote-del-btn">x</button></td>
  </tr>
  <tr class="snote-row">
    <td class="snote-no">2</td>
    <td class="snote-text"><textarea class="snote-textarea" rows="1">open row</textarea></td>
    <td class="snote-tick"><div class="snote-tick-wrap">
      <select class="snote-status-sel snote-status--empty" id="sel-open">
        <option selected>Ms. Daisy: "Needs Revision"</option>
        <option>Ms. Daisy: "Approved"</option>
        <option>Rayhanah: "Done"</option>
      </select>
    </div></td>
    <td class="snote-del"><button class="snote-del-btn">x</button></td>
  </tr>
</tbody></table></div>`;

try {
  await page.fixture({ today: "2026-10-12", authUser: "daisy", students: [], groups: [], sessions: [] });
  await page.load();
  await page.until(`document.readyState === "complete"`, "the page");
  await page.eval(`document.body.innerHTML = ${JSON.stringify(ROWS)}; true`);
  await page.until(`!!document.getElementById("undo")`, "the row to be in the page");

  r.section("a row that says Done offers a way back");
  const box = await page.eval(`(() => {
    const b = document.getElementById("undo");
    const rect = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return { w: Math.round(rect.width), h: Math.round(rect.height),
             display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
             // Doubled on purpose: this runs inside a template literal, where
             // a lone \s is just s -- the regex became /s+/g and replaced
             // every letter s in the label with a space.
             text: b.textContent.replace(/\\s+/g, " ").trim() };
  })()`);

  r.ok("it is not display:none", box.display !== "none", `display is ${box.display}`);
  r.ok("nor hidden some other way",
    box.visibility !== "hidden" && Number(box.opacity) > 0,
    `visibility ${box.visibility}, opacity ${box.opacity}`);
  r.ok("it has a real size on screen", box.w > 40 && box.h > 10,
    `measured ${box.w} by ${box.h} pixels`);
  r.ok("it spells out what it does",
    /Revert back to Needs Revision/.test(box.text), `reads "${box.text}"`);

  r.section("and sits under the dropdown, not beside it");
  const stacked = await page.eval(`(() => {
    const sel = document.getElementById("sel-done").getBoundingClientRect();
    const btn = document.getElementById("undo").getBoundingClientRect();
    return { below: btn.top >= sel.bottom - 1, sameWidth: Math.abs(btn.width - sel.width) < 4 };
  })()`);
  r.ok("below it", stacked.below, "the button is not under the dropdown");
  r.ok("and as wide as it", stacked.sameWidth, "the widths do not match");

  r.section("a row that does not say Done has no button");
  r.check("none in that row", await page.eval(`
    document.querySelectorAll("tr:nth-child(2) .snote-undo-btn").length`), 0);

  r.section("nothing in the stylesheet hides it");
  // The exact failure: a later rule with the same name and display:none.
  r.check("no rule matching it sets display:none", await page.eval(`(() => {
    const b = document.getElementById("undo");
    const bad = [];
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (!rule.selectorText || !rule.style) continue;
        let m = false; try { m = b.matches(rule.selectorText); } catch {}
        if (m && rule.style.display === "none") bad.push(rule.selectorText);
      }
    }
    return bad;
  })()`), []);

  r.section("console");
  const noise = page.consoleLines.filter(l => l.level === "error");
  r.ok("no console errors", noise.length === 0,
    noise.slice(0, 3).map(n => n.text.slice(0, 140)).join("\n        "));
} catch (err) {
  console.log(`\nThe run stopped early: ${err.message}`);
  try { console.log(`screenshot: ${await page.screenshot("sticky-note-undo-failure.png")}`); } catch { /* ignore */ }
  r.ok("the run finished", false, err.message);
} finally {
  await page.close();
}

Deno.exit(r.done() ? 1 : 0);
