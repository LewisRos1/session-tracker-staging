// The daily session note's footer.
//
// Lewis asked for "ZORA Behavioural Intervention" in the middle of it. The
// page number was already on the right and stays there.
//
// This builds a real report with the app's own export code and reads the
// footer out of the file, rather than checking that export.js contains a
// string. The two are different questions, and only the file answers the
// one that matters.
//
//   deno run -A tests/browser/session-note-footer.test.js <harness-dir>

import { openPage, reporter } from "./driver.js";

const dir = Deno.args[0];
if (!dir) { console.error("usage: session-note-footer.test.js <harness-dir>"); Deno.exit(2); }

const r = reporter();
const page = await openPage(dir, { verbose: Deno.args.includes("--verbose") });

const session = {
  id: "sess1", studentId: "qipei", date: "2026-10-08", sessionNumber: 31,
  activities: {
    a1: { targetName: "Self-Regulation", activityName: "Shows interest in different sensations",
          order: 0, isPredefined: true, configId: "c1" },
  },
  remarks: {
    r1: { id: "r1", activityId: "a1", text: "Fun house, swing, water play", trials: [3, 3, 2] },
  },
};

try {
  await page.fixture({
    today: "2026-10-13", authUser: "daisy",
    students: [{
      id: "qipei", name: "Zhang Qi Pei", order: 1, preferredName: "QiPei",
      targets: [{ id: "t1", name: "Self-Regulation", scale: 3, predefinedActivities: [
        { id: "c1", title: "", name: "Shows interest in different sensations",
          order: 0, activeFrom: "2026-01-01" },
      ] }],
    }],
    groups: [], sessions: [session],
  });
  await page.load();
  await page.until(`!document.querySelector("#screen-home").classList.contains("hidden")`, "home");

  // The export downloads, so the blob is caught on its way to the link.
  const b64 = await page.eval(`(async () => {
    let blob = null;
    const real = URL.createObjectURL;
    // A real URL, not a made-up one: the export hands it to a download
    // link, and a fake makes the browser log a failure the test then
    // reports as if the app had caused it.
    URL.createObjectURL = (b) => { blob = b; return real.call(URL, b); };
    try {
      const s = window.__app.state.students.find(x => x.id === "qipei");
      await window.__app.exportStudentSingleSessionWord(s, ${JSON.stringify(session)});
    } catch (e) { return "ERR " + e.message; } finally { URL.createObjectURL = real; }
    if (!blob) return "ERR nothing was downloaded";
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  })()`, 60000);

  r.ok("the report was built", !String(b64).startsWith("ERR"), String(b64).slice(0, 120));
  if (String(b64).startsWith("ERR")) throw new Error(String(b64));

  // Unzipped in the page, where JSZip already is.
  const parts = await page.eval(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const zip = await JSZip.loadAsync(bytes);
    const out = {};
    for (const name of Object.keys(zip.files)) {
      if (/^word\\/(footer|header)\\d*\\.xml$/.test(name)) out[name] = await zip.file(name).async("string");
    }
    return out;
  })()`, 60000);

  const footers = Object.entries(parts).filter(([n]) => n.includes("footer"));
  r.ok("the document has a footer", footers.length > 0, `parts found: ${Object.keys(parts)}`);

  const footerXml = footers.map(([, x]) => x).join("");
  r.section("what the footer says");
  r.ok("the company name is in it",
    footerXml.includes("ZORA Behavioural Intervention"),
    "the footer does not mention the company");
  r.ok("the page number is still there",
    /PAGE/.test(footerXml), "the page number has gone");

  r.section("and it is laid out across the line, not stacked");
  r.ok("one paragraph, not three",
    (footerXml.match(/<w:p[ >]/g) || []).length === 1,
    `found ${(footerXml.match(/<w:p[ >]/g) || []).length} paragraphs`);
  r.ok("with a centre tab stop for the name",
    /<w:tab [^>]*w:val="center"/.test(footerXml), "no centre tab stop");
  r.ok("and a right one for the page number",
    /<w:tab [^>]*w:val="right"/.test(footerXml), "no right tab stop");

  r.section("the header is unchanged");
  const headerXml = Object.entries(parts).filter(([n]) => n.includes("header"))
    .map(([, x]) => x).join("");
  r.ok("still the student, the session and the date",
    headerXml.includes("Zhang Qi Pei") && headerXml.includes("Session 31"),
    "the header lost something");
  r.ok("the company name is not repeated up there",
    !headerXml.includes("ZORA Behavioural Intervention"),
    "the company name is in the header too");

  // While the file is open: the stamp. It is fetched by a name with spaces
  // in it, which the harness server used to answer with a 404, so until now
  // every document built in a test came out without one.
  r.section("the company stamp made it in");
  const media = await page.eval(`(async () => {
    const bin = atob(${JSON.stringify(b64)});
    const zip = await JSZip.loadAsync(Uint8Array.from(bin, c => c.charCodeAt(0)));
    return Object.keys(zip.files).filter(n => n.startsWith("word/media/"));
  })()`, 60000);
  r.ok("there is an image in the document", media.length > 0,
    "no word/media entries, so the stamp did not load");

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

Deno.exit(r.done() ? 1 : 0);
