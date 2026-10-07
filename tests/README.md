# Tests

Run everything with one command, from the project root:

    deno run -A tests/run-all.js

It exits non-zero if anything fails, so it can gate a deploy. Nothing here
touches the real Firebase project: the browser tests run against a copy of the
app with Firestore swapped for stubs that record what the app tried to write.

## What is covered

**Without a browser** — the two functions that turn the Details box between
what is shown and what is stored:

    tests/details-markers.test.js    bold, underline, line breaks, empty tags
    tests/details-bullets.test.js    bullets land on the caret's line

**In a real browser** (headless Edge, driven over the DevTools protocol):

    tests/browser/smoke.test.js          the app starts and reaches the home screen
    tests/browser/details-saving.test.js the Details box saving list

The saving test does, as real clicks and real key presses:

1. type in Details, Save and Close, reopen
2. type, click the panel's dimmed area (must NOT close and lose the text)
3. type, click straight onto another activity's row
4. type, press Discard Changes, reopen
5. the same for a Note's Details and a Sub-activity's
6. change Details on an activity that has past sessions, and check nothing is
   propagated across them
7. type, then close the Edit Target modal itself

## Why these exist

Every bug in the Details boxes was found by the boss, in the live app, after a
deploy. Writing the tests found three more that had not been reported yet:

- **Ctrl+B and Ctrl+U never reached the Details boxes** (v2169). A Details box
  is contenteditable, so the general branch matched first and returned. The
  bold was never synced back to the field, which is why Discard Changes had
  nothing to compare; and a collapsed caret was never refused, which is where
  the stray `*_ _*` came from.
- **Discard Changes did not reach the app** (v2170). This screen edits a
  merged COPY of the target. Discard restored the copy, every screen reads
  state, and the text that had just been thrown away was still there.
- **Every discard leaked a stale Details box** (v2171). An abandoned panel
  body was left in the panel, and the next open appended beside it, so
  reopening showed two boxes -- the discarded text first.
- **Closing the Edit Target modal dropped an open panel's edit** (v2172).
  saveTarget writes nothing while a panel is open so a discard has something
  to undo, and nothing closed the panel on the way out, so the refusal was
  never revisited.

## How the browser tests work

`tests/browser/build-harness.js` copies the real `app.js`, `index.html`,
`styles.css`, `export.js` and `vendor/` into a throwaway directory and adds:

- a `firebase-service.js` whose exports are **read from the real imports**, so
  a new import cannot silently leave a hole. Most record their arguments;
  about two dozen behave (auth, the config loaders, `saveStudent`), and
  `saveStudent` writes back into the fixture so reopening a screen reads what
  was saved, exactly as a reload from Firestore would.
- a `config.js` with the real shape and none of the real keys.
- a block at the end of `app.js` exposing a few entry points on
  `window.__app`, chiefly the one that opens the Edit Target modal. Only the
  way IN is exposed -- everything a test then does is a real click or key
  press on the real markup, so this cannot paper over a broken button.

`tests/browser/driver.js` serves that directory, launches headless Edge with
`--remote-debugging-port`, and drives it: `click`, `type`, `key`, `until`,
`eval`, `screenshot`. A failing run writes `details-saving-failure.png`.

Two things worth knowing if a test starts failing oddly:

- The fixture is installed with `Page.addScriptToEvaluateOnNewDocument`.
  Setting it after navigating is too late, because `app.js` reads it while the
  page is still loading.
- The app force-signs-out when its stored session epoch does not match, which
  on a fresh browser profile is always. The driver seeds that key, reading the
  value out of `app.js` so bumping the epoch does not start every test on the
  sign-in screen.

## Field names

They read backwards, and this has caused real bugs:

    act.title        the activity's NAME, shown in the list
    act.name         the DETAILS text of an activity
    act.noteDetails  the DETAILS text of a note (act.text holds both halves)

## Adding a case

When something goes wrong in the Details boxes, add the case first and watch
it fail, then fix `app.js`. `check(name, got, want)` prints both sides on a
failure. For anything involving a click, a blur or the panel, put it in the
browser test: the plain tests use stand-in DOM nodes and cannot see what a
real browser does with `execCommand` or with focus.
