# Tests for the Details boxes

Run from the project root:

    deno run --allow-read tests/details-markers.test.js
    deno run --allow-read tests/details-bullets.test.js

Both read `app.js` and pull the functions they test straight out of it, so
they cannot drift from what ships. Nothing is copied or re-implemented.

They cover the bold / underline / bullet boxes in "+ Add Activity", "+ Add
Note" and the activity name field -- the part that showed the boss stars and
underscores instead of real formatting.

## Why these exist

Every bug in this feature was found by the boss, in the live app, after a
deploy. Each one had a specific cause that a test would have caught first:

- two bold words on their own lines became one bold line
- a bullet always went on the first line, whatever line the caret was on
- a bullet could not be removed after saving and reopening
- removing bold left `*_ _*` behind

The two functions doing the converting only ever touch `childNodes`,
`nodeType`, `nodeName` and `nodeValue`, so plain objects can stand in for a
real page and the browser shapes that caused those bugs can be rebuilt here.
The bullet test stubs a little more -- a selection, `innerText`, `innerHTML`,
a tree walker -- because the bullet logic has to match a line in the text on
screen to the same line in the stored text, where a bold run is two
characters longer.

## Adding a case

When something goes wrong in one of these boxes, add the case here first and
watch it fail, then fix `app.js`. `check(name, got, want)` prints both sides
on a failure, and the script exits non-zero so it can gate a deploy.
