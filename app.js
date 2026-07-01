// ============================================================
// APP.JS — Main application controller
// ============================================================

import { CONFIG } from "./config.js";
import {
  getOrCreateTodaySession,
  listenToSession,
  addActivity,
  deleteActivity,
  updateActivityName,
  updateActivityCombineRemarks,
  addRemark,
  updateRemarkText,
  updateRemarkNote,
  deleteRemark,
  addTrial,
  deleteTrial,
  getRecentSessionsForStudent,
  loadStudentsConfig,
  saveStudent,
  deleteStudentConfig,
  setStudentWordExportReady,
  loadTemplates,
  saveTemplate,
  deleteTemplate,
  loadRemarkPresets,
  saveRemarkPreset,
  deleteRemarkPreset,
  updateFedcComment,
  loadGroups,
  saveGroup,
  deleteGroup,
  getOrCreateGroupSessionForDate,
  getRecentGroupSessions,
  deleteGroupTargetDataFromSessions,
  addGroupRemark,
  addGroupRemarksBatch,
  deleteRemarksBatch,
  setTrials,
  sanitizeKey,
  getTodayString,
  getOrCreateSessionForDate,
  deleteSession,
  deleteEmptyIndividualSession,
  resequenceIndividualSessions,
  updateSessionDate,
  updateGroupSessionDate,
  deleteTargetDataFromSessions,
  renameActivityAcrossSessions,
  renameGroupActivityAcrossSessions,
  renameTargetAcrossSessions,
  renameGroupTargetAcrossSessions,
  renameRemarkOptionAcrossSessions,
  renameGroupRemarkOptionAcrossSessions,
  mergeDuplicateActivity,
  deleteOrphanAcrossSessions,
  deleteGroupOrphanAcrossSessions,
  reassignGroupStudentAcrossSessions,
  signInWithPin,
  signOutUser,
  onAuthChange,
  generateId,
  getIndividualSessionsForStudent,
  getGroupSessionsForStudent,
  getAllSessionsForStudent,
  getAllSessionsForGroup,
  changeSessionNumber
} from "./firebase-service.js";
import {
  exportStudentData, exportAllStudents, exportGroupMemberData,
  exportStudentSingleSessionWord, exportGroupMemberSingleSessionWord
} from "./export.js";

// ── SW update detection — must run at parse time, before DOMContentLoaded,
//   so the listener is in place before the new SW can fire controllerchange.
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Only reload for updates, not for the very first SW install. Show
    // "App Updating…" on THIS page first so it's visible for a moment, then
    // reload — the fresh page picks the same message back up immediately
    // (see the sessionStorage check in DOMContentLoaded below) so it reads
    // as one continuous transition instead of the app silently bouncing to
    // the home screen with no explanation.
    if (hadController) {
      sessionStorage.setItem("justUpdated", "1");
      document.querySelectorAll(".screen").forEach(s => s.classList.toggle("hidden", s.id !== "screen-loading"));
      document.getElementById("updating-content")?.classList.remove("hidden");
      setTimeout(() => window.location.reload(), 700);
    }
  });
}

// Set when this page load is showing "App Updating…" right after a SW
// update reload — holds the timestamp it was revealed so the caller can
// guarantee a minimum visible time before moving on, regardless of how
// fast sign-in/data-loading actually finishes.
let updatingScreenShownAt = null;
const UPDATING_SCREEN_MIN_MS = 3000;

async function waitForUpdatingScreenMinimum(minMs = UPDATING_SCREEN_MIN_MS) {
  if (!updatingScreenShownAt) return;
  const remaining = minMs - (Date.now() - updatingScreenShownAt);
  updatingScreenShownAt = null; // only delay once per page load
  if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
}

// Fills the "App Updating…" progress bar and percentage text from 0 to 100
// over durationMs (matching waitForUpdatingScreenMinimum's own minimum), so
// it reads as real progress rather than a generic spinner. Holds at 100% if
// the actual load ends up taking longer than durationMs.
function animateUpdatingProgress(durationMs = UPDATING_SCREEN_MIN_MS) {
  const bar = $("updating-progress-bar");
  const pct = $("updating-percent");
  if (!bar || !pct) return;
  const start = Date.now();
  const tick = () => {
    const percent = Math.min(100, Math.round((Date.now() - start) / durationMs * 100));
    bar.style.width = percent + "%";
    pct.textContent = percent + "%";
    if (percent < 100) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function versionLineText() {
  return `Made by Lewis · Version ${APP_VERSION}`;
}

const APP_VERSION = "653";

// ─── STATE ───────────────────────────────────────────────────
const state = {
  authenticated:      false,
  students:           [],
  templates:          [],
  remarkPresets:      [],
  searchExisting:     "",
  searchAssessment:   "",
  searchTemplate:     "",
  currentStudent:     null,
  currentSessionId:   null,
  sessionData:        null,
  selectedTargetName: null,
  fbUnsubscribe:      null,
  renderPending:      false,
  // Count of in-flight "+Add Remark & Trials"-style button clicks on the
  // live Entry screens (both individual and group). Without this, a write
  // from an unrelated row/activity landing mid-click can pass the busy-check
  // and force a render that replaces the just-clicked button before its own
  // write resolves, silently dropping the click's visible result.
  entryActionsInFlight:      0,
  entryGroupActionsInFlight: 0,
  // Same idea for the View/Edit-past-session screens' own action buttons
  // (Trials column +/×, option-pill buttons, etc.) — these don't rely on a
  // remark box's blur to trigger a render, so without this, a click can
  // land while isViewBusy() is still true and its result silently waits on
  // a render that never gets re-checked.
  viewActionsInFlight:      0,
  viewGroupActionsInFlight: 0,
  flashActive:        false,
  _flashTimer:        null,
  scorePicker:        { open: false, remId: null },
  pendingNewRemark:   null,
  pendingNewActivity: null,
  viewStudent:        null,
  viewSessionId:      null,
  viewSessionData:    null,
  fbViewUnsubscribe:    null,
  viewRenderPending:    false,
  // Group sessions
  groups:                  [],
  searchGroup:             "",
  currentGroup:            null,
  groupSessionId:          null,
  groupSessionData:        null,
  groupAttendees:          [],
  fbGroupUnsubscribe:      null,
  groupRenderPending:      false,
  selectedGroupTargetName: null,
  // Group session view (table-based view/edit of a past group session)
  viewGroup:              null,
  viewGroupSessionId:     null,
  viewGroupSessionData:   null,
  fbViewGroupUnsubscribe: null,
  viewGroupRenderPending: false,
};

const $ = id => document.getElementById(id);

// Busy = an in-flight multi-step write only (see counterKey on
// setupViewRemarkSaving — covers the Trials/mastery/etc. action buttons and
// a ghost box's activity+remark creation). Typing/focus itself never needs
// to defer a render — captureActiveEditState/restoreActiveEditState (see
// renderSessionView/renderGroupSessionView) protect an in-progress edit
// through any render regardless of timing, so gating on "is a box focused"
// or "is there unsaved text mid-debounce" here would only ever add delay,
// never safety.
function isViewBusy() {
  return state.viewActionsInFlight > 0;
}
function isGroupViewBusy() {
  return state.viewGroupActionsInFlight > 0;
}

// Wraps a View-screen action button's async handler so its own write always
// results in a render once it settles, regardless of whether isViewBusy()
// happened to be true at the moment the resulting Firestore snapshot
// actually arrived (same idea as the Entry screens' entryActionsInFlight —
// see the matching comment on state.viewActionsInFlight).
// Renders immediately unless the view is mid-edit elsewhere (a focused
// remark/mastery-note box that an immediate full rebuild would yank focus
// out from under) — in that case the deferred-render flag is set instead,
// and the existing onIdle/snapshot machinery picks it up once free.
function renderViewOrDefer(pendingKey, isBusy, render) {
  if (isBusy()) state[pendingKey] = true;
  else render();
}

function withViewAction(counterKey, pendingKey, isBusy, render, fn) {
  return async (...args) => {
    state[counterKey]++;
    try {
      await fn(...args);
    } finally {
      state[counterKey]--;
      if (state[counterKey] === 0 && state[pendingKey] && !isBusy()) {
        state[pendingKey] = false;
        render();
      }
    }
  };
}

// addRemark()/addGroupRemark() etc resolve once the write is sent, but the
// Firestore onSnapshot listener that actually updates state.sessionData /
// state.groupSessionData can deliver that update a beat later. Rendering
// right after the await can therefore render the OLD data (new remark not
// in it yet), which looks like the click did nothing. Poll instead of
// guessing a delay — resolves the instant the local snapshot has the data.
function waitForSessionData(check, timeoutMs = 4000) {
  return new Promise(resolve => {
    if (check()) { resolve(); return; }
    const start = Date.now();
    const poll = () => {
      if (check() || Date.now() - start > timeoutMs) { resolve(); return; }
      setTimeout(poll, 40);
    };
    poll();
  });
}

// ─── BOTTOM-SHEET TEXT EDITOR ────────────────────────────────
let _sheetOriginEl = null;

// ─── GROUP TARGET EDIT OVERRIDE ──────────────────────────────
// When editing a target belonging to a group, this is set so that
// renderTargetManageContent saves to the group instead of the student.
let _groupForTargetEdit = null;

// Activities are matched to session data by name text (see
// renameActivityAcrossSessions in firebase-service.js for the full
// explanation) — call this right after a rename is saved in Edit Target so
// every session that already has a remark recorded under the old name
// doesn't lose its link to it. Fire-and-forget: the rename itself already
// saved by the time this runs, so a failure here is logged, not surfaced —
// it just means old sessions keep showing the pre-existing orphaned-row
// behavior rather than this being a new way to actually lose data.
//
// Renaming the same activity more than once in quick succession (e.g.
// composing a long name across several blur events before settling on the
// final wording) used to race: each call's getDocs()+updateDoc() pair runs
// independently, so a later rename's query could read Firestore before an
// earlier rename's writes had landed, find zero matches under the
// intermediate name, and silently break the chain — exactly what happened to
// Caden Tan's "FEDC 1" activity (see runOneOffRepairs). Queue every
// propagation for the same student/group so each one only starts once the
// previous one's writes have actually committed.
const _renamePropagationQueues = new Map();
function propagateActivityRename(student, targetName, oldName, newName) {
  if (!oldName || oldName === newName) return;
  const entityId = _groupForTargetEdit ? _groupForTargetEdit.id : student.id;
  const prior = _renamePropagationQueues.get(entityId) || Promise.resolve();
  const next = prior
    .then(() => _groupForTargetEdit
      ? renameGroupActivityAcrossSessions(_groupForTargetEdit.id, targetName, oldName, newName)
      : renameActivityAcrossSessions(student.id, targetName, oldName, newName))
    .catch(err => console.error("propagateActivityRename failed:", err));
  _renamePropagationQueues.set(entityId, next);
}

// Same orphaning risk as propagateActivityRename above, but for the target's
// own name — call this right after a target rename is saved in Edit Target.
// Shares the same per-student/group queue so a target rename and an activity
// rename fired close together (e.g. editing both during the same blur-heavy
// session) still serialize instead of racing each other's Firestore writes.
function propagateTargetRename(student, oldName, newName) {
  if (!oldName || oldName === newName) return;
  const entityId = _groupForTargetEdit ? _groupForTargetEdit.id : student.id;
  const prior = _renamePropagationQueues.get(entityId) || Promise.resolve();
  const next = prior
    .then(() => _groupForTargetEdit
      ? renameGroupTargetAcrossSessions(_groupForTargetEdit.id, oldName, newName)
      : renameTargetAcrossSessions(student.id, oldName, newName))
    .catch(err => console.error("propagateTargetRename failed:", err));
  _renamePropagationQueues.set(entityId, next);
}

// Same orphaning risk again, one level deeper: a Select-one/Tick-boxes
// activity's recorded answer is the literal option text, not a stable
// index — retyping wording in the "/"-separated options box (e.g. "Low" →
// "Fair") would otherwise leave old recorded answers stuck under text that
// no longer matches any current pill, just like an activity/target rename.
// oldOptsStr/newOptsStr are the raw "/"-separated strings before/after the
// edit. Since the options box is a single free-typed field (not a
// per-option rename control), this can only safely infer intent when the
// same NUMBER of options were swapped out — pairs each option that
// disappeared with one that appeared, in the order they occur in the
// string. A pure add or pure remove (different counts) has nothing to pair
// against, so it's left alone rather than guessing wrong.
function propagateRemarkOptionRename(student, target, pa, oldOptsStr, newOptsStr) {
  const oldOpts = parseOpts(oldOptsStr);
  const newOpts = parseOpts(newOptsStr);
  const removed = oldOpts.filter(o => !newOpts.includes(o));
  const added   = newOpts.filter(o => !oldOpts.includes(o));
  if (removed.length === 0 || removed.length !== added.length) return;
  const entityId = _groupForTargetEdit ? _groupForTargetEdit.id : student.id;
  for (let i = 0; i < removed.length; i++) {
    const oldOpt = removed[i];
    const newOpt = added[i];
    const prior = _renamePropagationQueues.get(entityId) || Promise.resolve();
    const next = prior
      .then(() => _groupForTargetEdit
        ? renameGroupRemarkOptionAcrossSessions(_groupForTargetEdit.id, target.name, pa.name, oldOpt, newOpt, !!pa.optionsMulti)
        : renameRemarkOptionAcrossSessions(student.id, target.name, pa.name, oldOpt, newOpt, !!pa.optionsMulti))
      .catch(err => console.error("propagateRemarkOptionRename failed:", err));
    _renamePropagationQueues.set(entityId, next);
  }
}

// A student's own profile name (changed via "Change Student's Name" in the
// Student Database) is also baked as plain text into any group roster slot
// linked to them — group.students/group.studentLinks key off the name
// string, and every historical group session's attendees/
// remarks.studentName carry that same text. Nothing else refreshes those
// automatically, so without this a renamed student's groups would keep
// silently recording under the pre-rename name forever — the exact same
// denormalized-name trap that already cost real data twice (see
// [[feedback_activity_rename_race_fix]]), just not yet visible since both
// sides stay mutually stale together. Resync proactively instead of
// leaving it to rot. Shares the rename queue, keyed by group id, so this
// can't race a target/activity rename landing on the same group.
async function propagateStudentRenameToGroups(student, oldName, newName) {
  if (!oldName || oldName === newName) return;
  for (const group of state.groups) {
    const idx = (group.students || []).findIndex(n => group.studentLinks?.[n] === student.id);
    if (idx === -1) continue;
    const groupId = group.id;
    const prior = _renamePropagationQueues.get(groupId) || Promise.resolve();
    const next = prior.then(async () => {
      group.students[idx] = newName;
      delete group.studentLinks[oldName];
      group.studentLinks[newName] = student.id;
      group.name = groupAutoName(group.students.filter(Boolean));
      const gi = state.groups.findIndex(g => g.id === groupId);
      if (gi >= 0) state.groups[gi] = group;
      await saveGroup(group);
      await reassignGroupStudentAcrossSessions(groupId, oldName, student.id, newName, student.id);
    }).catch(err => console.error("propagateStudentRenameToGroups failed:", err));
    _renamePropagationQueues.set(groupId, next);
  }
}

// Tracks a newly-created group ID so it can be auto-deleted if closed with no students.
let _newGroupId = null;
// When the Edit Target/Template modal is open, holds { acts, save } so closeManageModal
// can strip out activities/notes/headings the boss never typed anything into.
let _pendingActsCleanup = null;

// An activity/note/heading with no text is meaningless — drop it instead of saving it.
function isEmptyActItem(a) {
  const strip = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
  if (a.isNote) return strip(a.text).length === 0;
  if (a.isMaintain || a.isMaintainHeading) return (a.name || "").trim().length === 0;
  return strip(a.name).length === 0;
}

// Activity Name / Notes (actNote) fields format bold/underline directly in
// their plain <textarea> (see wrapTextareaSelection) rather than through this
// popup — the popup is only for remarks now, same as it always was.
function isActivityMarkupField(el) {
  return el.classList?.contains("mn-act-name-input") || el.classList?.contains("mn-act-note-input");
}

function openTextEditorSheet(originEl) {
  _sheetOriginEl = originEl;
  // Both the Entry and View screens' remark boxes are real <textarea>
  // elements (plain text, "\n" for line breaks) — the sketch sheet itself
  // stays contenteditable, so bridge between the two formats going in and out.
  const isFormField = originEl.tagName === "TEXTAREA" || originEl.tagName === "INPUT";
  $("text-editor-content").innerHTML = isFormField
    ? remarkToHtml(originEl.value).replace(/\n/g, "<br>")
    : originEl.innerHTML;
  $("text-editor-sheet").classList.remove("hidden");
  requestAnimationFrame(() => $("text-editor-content").focus());
}

function commitTextEditorSheet() {
  if (!_sheetOriginEl) return;
  const isFormField = _sheetOriginEl.tagName === "TEXTAREA" || _sheetOriginEl.tagName === "INPUT";
  if (isFormField) {
    _sheetOriginEl.value = plainTextForEdit($("text-editor-content").innerHTML);
    autoResizeTextarea(_sheetOriginEl);
  } else {
    _sheetOriginEl.innerHTML = $("text-editor-content").innerHTML;
  }
  _sheetOriginEl.dispatchEvent(new Event("blur"));
  // .view-remark-edit boxes on the view/edit-past-session screens no longer have
  // their own blur listener (saving is handled by the shared merged-editing host) —
  // bubble an "input" so that host's debounced flush picks up this change too.
  _sheetOriginEl.dispatchEvent(new Event("input", { bubbles: true }));
  _sheetOriginEl = null;
}

function closeTextEditorSheet() {
  $("text-editor-sheet").classList.add("hidden");
  _sheetOriginEl = null;
  // Process any render that was deferred while the sheet was open
  if (state.renderPending) { state.renderPending = false; renderTargetContent(); }
  if (state.viewRenderPending) { state.viewRenderPending = false; renderSessionView(); }
}

// ─── INIT ────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {

  // Register SW immediately — don't wait for Firebase so updates are never blocked.
  registerServiceWorker();

  // Picks the "App Updating…" message back up on the fresh page (it was
  // already showing on the old page right before this reload happened) —
  // #screen-loading is already the default-visible screen at this point,
  // so this just reveals its content; initPin()/showHome() naturally hides
  // the whole thing once sign-in state is known.
  if (sessionStorage.getItem("justUpdated")) {
    sessionStorage.removeItem("justUpdated");
    $("updating-content")?.classList.remove("hidden");
    updatingScreenShownAt = Date.now();
    animateUpdatingProgress();
  }


  // On iOS, relatedTarget is always null and pointerdown may not fire for <select>.
  // Use both pointerdown and touchstart (touchstart fires reliably before focusout on iOS).
  ["pointerdown", "touchstart"].forEach(evtName => {
    $("target-select").addEventListener(evtName, () => {
      state._targetSelDown = true;
      clearTimeout(state._targetSelTimer);
      state._targetSelTimer = setTimeout(() => { state._targetSelDown = false; }, 800);
    }, { passive: true });
  });

  document.addEventListener("focusout", (e) => {
    if (e.relatedTarget === $("target-select") || state._targetSelDown) return;
    // Don't trigger re-renders while the bottom-sheet editor is open
    if (!$("text-editor-sheet").classList.contains("hidden")) return;
    // Defer one tick so activeElement updates before we check
    setTimeout(() => {
      if (document.activeElement === $("target-select")) return;
      if (state.renderPending) {
        state.renderPending = false;
        renderTargetContent();
      }
      if (state.viewRenderPending) {
        state.viewRenderPending = false;
        renderSessionView();
      }
    }, 0);
  });

  // Ctrl+B / Cmd+B: visual bold in contenteditable remark fields, or a
  // *marker* wrap directly in the Activity Name/Notes plain textareas.
  document.addEventListener("keydown", e => {
    if (!(e.key === "b" && (e.ctrlKey || e.metaKey))) return;
    const el = document.activeElement;
    if (!el) return;
    if (el.isContentEditable) {
      e.preventDefault();
      document.execCommand("bold");
      return;
    }
    if (isActivityMarkupField(el)) {
      e.preventDefault();
      wrapTextareaSelection(el, "*");
    }
  });

  // Ctrl+U / Cmd+U: same idea as Ctrl+B above, with an _underline_ marker —
  // only Activity Name/Notes fields need this; remarks never asked for
  // underline support.
  document.addEventListener("keydown", e => {
    if (!(e.key === "u" && (e.ctrlKey || e.metaKey))) return;
    const el = document.activeElement;
    if (!el) return;
    if (el.isContentEditable) {
      e.preventDefault();
      document.execCommand("underline");
      return;
    }
    if (isActivityMarkupField(el)) {
      e.preventDefault();
      wrapTextareaSelection(el, "_");
    }
  });

  // Ctrl+Shift+L / Cmd+Shift+L: bullet point, same shortcut Word itself uses.
  // Activity Name/Notes fields only — bullets aren't supported in remarks.
  document.addEventListener("keydown", e => {
    if (!(e.key === "L" || e.key === "l") || !e.shiftKey || !(e.ctrlKey || e.metaKey)) return;
    const el = document.activeElement;
    if (!el || !isActivityMarkupField(el)) return;
    e.preventDefault();
    toggleBulletSelection(el);
  });

  $("text-editor-done").addEventListener("click", () => {
    commitTextEditorSheet();
    closeTextEditorSheet();
  });

  // Firestore now requires a real signed-in user (see firebase-service.js).
  // Sign-in persists across reloads, but only counts for the calendar day
  // it happened on — a persisted sign-in from an earlier day gets silently
  // signed back out here, which makes onAuthChange fire again with
  // user = null and fall into the PIN branch below.
  onAuthChange(async user => {
    if (user && !hasLoggedInToday()) {
      await signOutUser();
      return;
    }
    if (!user) {
      await waitForUpdatingScreenMinimum();
      initPin();
      return;
    }
    await loadAppData();
    await waitForUpdatingScreenMinimum();
    showHome();
  });
});

const LAST_LOGIN_DATE_KEY = "lastLoginDate";
function hasLoggedInToday() {
  return localStorage.getItem(LAST_LOGIN_DATE_KEY) === getTodayString();
}
function markLoggedInToday() {
  localStorage.setItem(LAST_LOGIN_DATE_KEY, getTodayString());
}

// Student/template/group/remark-preset config — only fetchable once signed in.
async function loadAppData() {
  // These 4 reads are independent of each other — fire them all at once
  // instead of one-after-another, or their wait times just add up.
  const [studentsR, templatesR, groupsR, presetsR] = await Promise.allSettled([
    loadStudentsConfig(),
    loadTemplates(),
    loadGroups(),
    loadRemarkPresets()
  ]);

  // Student config (seeds from INITIAL_STUDENTS if empty)
  if (studentsR.status === "fulfilled") {
    let students = studentsR.value;
    if (students.length === 0) {
      for (const s of CONFIG.INITIAL_STUDENTS) await saveStudent(s);
      students = CONFIG.INITIAL_STUDENTS;
    }
    state.students = students;
  } else {
    state.students = CONFIG.INITIAL_STUDENTS;
  }

  if (templatesR.status === "fulfilled") state.templates = templatesR.value;
  if (groupsR.status === "fulfilled") state.groups = groupsR.value;
  if (presetsR.status === "fulfilled") state.remarkPresets = presetsR.value;
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const promptSkip = sw => sw.postMessage("skipWaiting");
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" })
    .then(reg => {
      if (reg.waiting) promptSkip(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const sw = reg.installing;
        sw.addEventListener("statechange", () => {
          if (sw.state === "installed") promptSkip(sw);
        });
      });
      reg.update();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update();
      });
      // Catches updates even if the tab is just left open in the foreground
      // the whole time — visibilitychange alone never fires then, so an
      // update could otherwise sit undetected until the boss happens to
      // switch away and back, or manually refreshes.
      setInterval(() => reg.update(), 60000);
    })
    .catch(() => {});
}

// ============================================================
// PIN SCREEN
// ============================================================

function initPin() {
  showScreen("screen-pin");
  const vEl = $("pin-version");
  if (vEl) vEl.textContent = versionLineText();
  const errMsg = $("pin-error");
  const statusMsg = $("pin-status");
  const dotsEl = $("pin-dots");
  const keypad = $("pin-keypad");
  const pinLen = CONFIG.PIN_LENGTH;
  let value = "";
  let checking = false;

  // A previous successful login leaves statusMsg's "hidden" class removed
  // (only the error path explicitly re-hides it — success just navigates
  // away from this whole screen). Reset both on every fresh entry so
  // "Logging in…" can't still be showing before anything's been typed.
  errMsg.classList.add("hidden");
  statusMsg.classList.add("hidden");

  dotsEl.innerHTML = Array.from({ length: pinLen }, () =>
    '<span class="pin-dot"></span>'
  ).join("");
  const dots = dotsEl.querySelectorAll(".pin-dot");

  function renderDots() {
    dots.forEach((d, i) => d.classList.toggle("filled", i < value.length));
  }

  function shake() {
    dotsEl.classList.remove("shake");
    void dotsEl.offsetWidth;
    dotsEl.classList.add("shake");
  }

  async function submit() {
    if (checking) return;
    checking = true;
    keypad.classList.add("checking");
    errMsg.classList.add("hidden");
    statusMsg.classList.remove("hidden");
    try {
      // Marked *before* signing in, not after — onAuthChange's listener can
      // fire as soon as Firebase's internal state updates, which can race
      // ahead of this async function's own continuation after the await.
      // If hasLoggedInToday() were still false at that moment, onAuthChange
      // would immediately sign this brand-new login back out again (it
      // looks identical to a stale persisted session from a previous day),
      // leaving "Logging in…" stuck forever since the screen never moves on
      // to home OR back to a fresh PIN entry.
      markLoggedInToday();
      await signInWithPin(value);
      // Success: onAuthChange (registered once in DOMContentLoaded) picks up
      // the new signed-in user, loads data, and shows home from there. Leave
      // "Logging in…" up the whole time — loading that data after sign-in
      // can itself take a few seconds, and showScreen() will hide this
      // entire PIN screen (status message included) once home appears, so
      // there's no gap where nothing is showing.
      document.removeEventListener("keydown", onKeyDown);
      checking = false;
      keypad.classList.remove("checking");
    } catch (err) {
      shake();
      errMsg.classList.remove("hidden");
      statusMsg.classList.add("hidden");
      value = "";
      renderDots();
      checking = false;
      keypad.classList.remove("checking");
    }
  }

  function pressKey(key) {
    if (key === "back") {
      value = value.slice(0, -1);
      errMsg.classList.add("hidden");
      renderDots();
      return;
    }
    if (value.length >= pinLen) return;
    value += key;
    renderDots();
    if (value.length === pinLen) setTimeout(submit, 120);
  }

  keypad.addEventListener("click", e => {
    const btn = e.target.closest(".pin-key");
    if (!btn || btn.disabled) return;
    pressKey(btn.dataset.key);
  });

  function onKeyDown(e) {
    if (e.key >= "0" && e.key <= "9") pressKey(e.key);
    else if (e.key === "Backspace") pressKey("back");
    else if (e.key === "Enter" && value.length === pinLen) submit();
  }
  document.addEventListener("keydown", onKeyDown);
}

// ============================================================
// HOME SCREEN
// ============================================================

async function showHome() {
  showScreen("screen-home");
  const verEl = document.getElementById("app-version");
  if (verEl) verEl.textContent = versionLineText();
  // Clear section searches when returning home
  state.searchExisting = ""; state.searchAssessment = ""; state.searchTemplate = "";
  state.searchGroup = "";
  [$("search-existing"), $("search-assessment"), $("search-template"), $("search-group")]
    .forEach(el => { if (el) el.value = ""; });
  renderExistingStudentButtons();
  renderGroupButtons();
  renderAssessmentStudentButtons();
  renderTemplateButtons();
  renderExportButtons();
  renderStudentDatabaseButton();
  runOneOffRepairs();
}

// One-off repairs for specific data issues already fixed in the app's logic
// but whose damage needs a one-time correction in already-written Firestore
// data. Each repair is scoped to an exact studentId+targetName+oldName match,
// so it's a no-op (and safe to leave running) once that exact mismatch no
// longer exists — remove the call once confirmed fixed rather than leaving
// it as permanent dead weight.
let _ranOneOffRepairs = false;
function runOneOffRepairs() {
  if (_ranOneOffRepairs) return;
  _ranOneOffRepairs = true;

  // Caden Tan's "FEDC 1" target had an activity renamed without the rename
  // propagating to historical sessions, leaving real recorded data stuck
  // under the old name "Write FEDC 1's Comment in Self Regulation" while the
  // current config just says "Comment".
  const caden = state.students.find(s => s.name === "Caden Tan");
  if (caden) {
    renameActivityAcrossSessions(caden.id, "FEDC 1", "Write FEDC 1's Comment in Self Regulation", "Comment")
      .catch(err => console.error("runOneOffRepairs (Caden Tan FEDC 1 Comment) failed:", err));
  }

  // Caden Tan's "Self Regulation" → "Self-Regulation" and "Functional
  // Communication" → "Two-Way Communication" target renames had the same
  // missing-propagation bug as the FEDC 1 fix above, just one level up (the
  // target's own name instead of an activity's) — renameTargetAcrossSessions
  // didn't exist yet when these renames happened, so every historical
  // session's activities/remarks/trials for both targets were left stuck
  // under the old names and looked completely empty (scores included) under
  // the renamed targets.
  if (caden) {
    renameTargetAcrossSessions(caden.id, "Self Regulation", "Self-Regulation")
      .catch(err => console.error("runOneOffRepairs (Caden Tan Self-Regulation) failed:", err));
    renameTargetAcrossSessions(caden.id, "Functional Communication", "Two-Way Communication")
      .catch(err => console.error("runOneOffRepairs (Caden Tan Two-Way Communication) failed:", err));
    // The first version of this repair (v602) guessed the new name wrong —
    // "Two Way Communication" (no hyphen) instead of the boss's actual
    // "Two-Way Communication" — so it already ran once and moved the data
    // to that wrong name instead of fixing it. Correct it forward.
    renameTargetAcrossSessions(caden.id, "Two Way Communication", "Two-Way Communication")
      .catch(err => console.error("runOneOffRepairs (Caden Tan Two-Way Communication typo fix) failed:", err));
  }

  migrateAwayFromMasteryType()
    .catch(err => console.error("runOneOffRepairs (mastery removal) failed:", err));

  // v608 Data Integrity Check backlog — confirmed batch 1. Every pair here
  // was surfaced by the report and manually reviewed (not auto-merged):
  // either a wording/typo cleanup of the same activity, a list
  // renumbering (only the leading letter/number changed), or the v606
  // heading-rename bug (a "Comment Section" heading hijacking a "Comment"
  // activity's data) recurring on FEDC 2/3/Attending in addition to the
  // ones already fixed. Deliberately excludes a few report entries that
  // looked too ambiguous to merge safely (e.g. Leven Chua's "Overall:",
  // which the current config split into separate Part A/Part B activities;
  // Liam Chua's per-session "Activity Name: ..." one-offs; Caspar Lim's
  // "Behaviour 2", which might be tracking a distinct incident rather than
  // a renamed duplicate of "Behaviour").
  const BACKLOG_ACTIVITY_RENAMES_V608 = [
    { student: "Leven Chua", target: "Learning", old: "d) Story Understanding", new: "d) Story Understanding ( Can organises the retelling)" },
    { student: "Leven Chua", target: "Learning", old: "e) Response & Interaction", new: "e) Response & Interaction (Can Responds to Follow-Up Questions from the text)" },
    { student: "Leven Chua", target: "Learning", old: "c) Matches clues to guess", new: "c) Matches clues to guess - Skill: Previous Event connection" },
    { student: "Leven Chua", target: "Learning", old: "d) Explain the answer", new: "d) Explain the answer - Skill: Prediction" },
    { student: "Leven Chua", target: "Learning", old: "b) Makes a guess", new: "b) Makes a guess - Skill: Thought inference" },
    { student: "Leven Chua", target: "Learning", old: "a) Looks for clues", new: "a) Looks for clues - Skill : Emotion inference" },
    { student: "Leven Chua", target: "Learning", old: "c) Sentence Structure", new: "c) Sentence Structure (Uses Clear Sentences)" },
    { student: "Leven Chua", target: "Learning", old: "Sumarise story:", new: "c) Summarises the story" },
    { student: "Leven Chua", target: "Learning", old: "Aesop Fable:", new: "Aesop Fable" },
    { student: "Leven Chua", target: "Learning", old: "c) Understands the answers", new: "c) Understands the answers and discussion" },
    { student: "Leven Chua", target: "Learning", old: "e) Response & Interaction (Can Responds to Follow-Up Questions)", new: "e) Response & Interaction (Can Responds to Follow-Up Questions from the text)" },

    { student: "Liam Chua", target: "Learning", old: "3. Vocabulary - use suitable words related to the topic.", new: "Vocabulary - use suitable words related to the picture, characters, actions and setting." },
    { student: "Liam Chua", target: "Learning", old: "Completing worksheet and comprehension", new: "Completing Worksheets - Applies Story Understanding in Worksheet Tasks" },
    { student: "Liam Chua", target: "Learning", old: "7. Confidence - attempts to speak with less teacher support.", new: "Level of Support - attempts to speak with less teacher support." },
    { student: "Liam Chua", target: "Learning", old: "2. Clarity - speak clearly enough to understand.", new: "Clarity - Speaks at an understandable volume and pace, with words clear enough for the listener to follow." },
    { student: "Liam Chua", target: "Learning", old: "Completing Worksheets", new: "Completing Worksheets - Applies Story Understanding in Worksheet Tasks" },
    { student: "Liam Chua", target: "Learning", old: "Clarity - speak clearly enough to understand.", new: "Clarity - Speaks at an understandable volume and pace, with words clear enough for the listener to follow." },
    { student: "Liam Chua", target: "Learning", old: "Participation - attempts to speak with less teacher support.", new: "Level of Support - attempts to speak with less teacher support." },
    { student: "Liam Chua", target: "Learning", old: "Vocabulary - use suitable words related to the topic.", new: "Vocabulary - use suitable words related to the picture, characters, actions and setting." },
    { student: "Liam Chua", target: "Learning", old: "Story Discussion and Two-Way Communication", new: "Story Discussion and Two-Way Communication (Responds to and asks questions related to the story during discussion.)" },

    { student: "Hayden Chan", target: "Math", old: "Counting forward and backwards (a. Movement b. written c. application- worksheets)", new: "Counting forward and backwards (a. Movement b. written c. Application- worksheets)" },
    { student: "Hayden Chan", target: "Math", old: "Today, yesterday and tomorrow", new: "Identify today, yesterday and tomorrow" },
    { student: "Hayden Chan", target: "Math", old: "Numbers", new: "Maths - Numbers" },

    { student: "Kayden Koh", target: "Learning", old: "c. Listen to two instructions - Find two sentences from the story.", new: "b) Find two sentences from the story." },
    { student: "Kayden Koh", target: "Learning", old: "e, Play a barrier game -", new: "d) Play a barrier game -" },
    { student: "Kayden Koh", target: "Learning", old: "d. complete two movements circuits", new: "c) complete two movements circuits" },

    { student: "Caden Tan", target: "FEDC 2", old: "Comment Section", new: "Comment" },
    { student: "Caden Tan", target: "FEDC 3", old: "Comment Section", new: "Comment" },
    { student: "Caden Tan", target: "Attending", old: "Comment Section", new: "Comment" },
    { student: "Caden Tan", target: "Two-Way Communication", old: "7. Open the door", new: "9. Open the door" },
    { student: "Caden Tan", target: "Two-Way Communication", old: "5. I am hungry (snack)", new: "5. I am hungry (snack)" },
    { student: "Caden Tan", target: "Two-Way Communication", old: "6. Turn on the light", new: "8. Turn on the light" },
    { student: "Caden Tan", target: "Two-Way Communication", old: "7. Water", new: "6. Water" },
    { student: "Caden Tan", target: "Two-Way Communication", old: "4. Sounds are too loud.", new: "4. Sounds are too loud" },
    { student: "Caden Tan", target: "Two-Way Communication",
      old: `Verbalising Phase 1: a. Provide 3-5 seconds to provide an answer. b. To provide an alternative, simpler question that provides a clue to the answer. c. State the answer in a functional manner before asking the question again. d. Provide a sentence stem. e. Ask the question and provide the answer. f. Provide the sentence stem "I". Phase 2: Provide a visual of the sentence stem 'I' to elicit a response to a question. Phase 3: Provide Caden with a short phrase of 3-4 words. Provide a non-'wh' question. Phase 4: To answer independently what he wants to play in the playground.`,
      new: `Phase 1: a. Provide 3-5 seconds to provide an answer. b. To provide an alternative, simpler question that provides a clue to the answer. c. State the answer in a functional manner before asking the question again. d. Provide a sentence stem. e. Ask the question and provide the answer. f. Provide the sentence stem "I". Phase 2: Provide a visual of the sentence stem 'I' to elicit a response to a question. Phase 3: Provide Caden with a short phrase of 3-4 words. Provide a non-'wh' question. Phase 4: To answer independently what he wants to play in the playground.` },
    { student: "Caden Tan", target: "Attending",
      old: `Attending Phase 1: a. Intro to whole body listening. 2. b. Use of a token board. 3. A stimulus to use outdoors. Phase 2 4. To sit on a convenient, safe surface to follow the instructor's instructions.`,
      new: `Attending Phase 1: a. Intro to whole body listening. b. Use of a token board. c. A stimulus to use outdoors. Phase 2: d. To sit on a convenient, safe surface to follow the instructor's instructions. Phase 3: e. To stand still to listen to an instructions and to follow it.` },

    { student: "Caspar Lim", target: "Target Behaviour", old: "Caspar has a tendency to pinch or say he wants to bite others when he is frustrated.", new: "Target Behaviour 2: Caspar tends to pinch or say he wants to bite others when he is frustrated" },
    { student: "Caspar Lim", target: "ABC Chart", old: "Behaviour", new: "Behaviours" }
  ];

  for (const { student: studentName, target, old: oldName, new: newName } of BACKLOG_ACTIVITY_RENAMES_V608) {
    const s = state.students.find(st => st.name === studentName);
    if (s) {
      renameActivityAcrossSessions(s.id, target, oldName, newName)
        .catch(err => console.error(`runOneOffRepairs (v608 backlog: ${studentName}/${target}/${oldName}) failed:`, err));
    }
  }
}

// "Mastery Level + Free Text" was removed as a Remark Type — this converts
// any activity still configured as isMastery into the equivalent Sentence
// Starter + Select One + Free Text config, the exact same pure config flip
// the old per-activity "Convert" button used to do: existing remarks'
// rem.text ("In Progress"/"Mastered"/"Maintain") and rem.masteryNote already
// line up with the new type's select options and notes field, so nothing in
// the sessions collection needs touching. Scoped to students/groups/
// templates that still have an isMastery activity, so it's a no-op (and
// safe to leave running) once none remain.
function convertMasteryActivity(pa) {
  pa.sentenceStarter = pa.sentenceStarter || "Mastery Level";
  pa.inlineOptions    = "In Progress/Mastered/Maintain";
  pa.optionsMulti     = false;
  pa.remarkPresetId   = null;
  pa.isMastery        = false;
  pa.remarkHasNote    = true;
}

async function migrateAwayFromMasteryType() {
  for (const student of state.students) {
    let changed = false;
    for (const target of (student.targets || [])) {
      for (const pa of (target.predefinedActivities || [])) {
        if (pa.isMastery) { convertMasteryActivity(pa); changed = true; }
      }
    }
    if (changed) await saveStudent(student);
  }
  for (const group of state.groups) {
    let changed = false;
    for (const target of (group.targets || [])) {
      for (const pa of (target.predefinedActivities || [])) {
        if (pa.isMastery) { convertMasteryActivity(pa); changed = true; }
      }
    }
    if (changed) await saveGroup(group);
  }
  for (const template of state.templates) {
    let changed = false;
    for (const pa of (template.predefinedActivities || [])) {
      if (pa.isMastery) { convertMasteryActivity(pa); changed = true; }
    }
    if (changed) await saveTemplate(template);
  }
}

$("btn-logout").addEventListener("click", () => {
  signOutUser();
});

// ── Add student / template from home screen ───────────────────

$("btn-add-existing-student").addEventListener("click", () => showRegisteredStudentPicker("existing"));
$("btn-add-assessment-student").addEventListener("click", () => showRegisteredStudentPicker("assessment"));
$("btn-add-template").addEventListener("click", addNewTemplate);
$("btn-add-group").addEventListener("click", addNewGroup);
$("search-existing").addEventListener("input", e => {
  state.searchExisting = e.target.value;
  renderExistingStudentButtons();
});
$("search-group").addEventListener("input", e => {
  state.searchGroup = e.target.value;
  renderGroupButtons();
});
$("search-assessment").addEventListener("input", e => {
  state.searchAssessment = e.target.value;
  renderAssessmentStudentButtons();
});
$("search-template").addEventListener("input", e => {
  state.searchTemplate = e.target.value;
  renderTemplateButtons();
});

function renderStudentDatabaseButton() {
  const container = $("student-database-button");
  if (!container) return;
  container.innerHTML = `<button class="export-btn export-btn-all" id="btn-open-student-registry">View</button>`;
  $("btn-open-student-registry").addEventListener("click", () => openStudentRegistryScreen());
}

// highlightAdd: briefly glows "+ Add New Student" — used when redirected
// here from another screen's "register a new student" option, instead of
// a popup the boss has to stop and read.
function openStudentRegistryScreen(opts = {}) {
  showScreen("screen-student-registry");
  renderStudentRegistryBody(opts);
}

// Full-page Student Database screen — table of every registered student
// (No./First/Last/latest individual session/latest group session), with
// "Add New Student" (inline editable row, both names required) and "Delete
// Student" (pick by number, then type DELETE) actions above it. Clicking a
// row still opens Manage Student for editing/transfer. Individual and group
// session numbers are tracked as two separate lifetime sequences per
// student (see getIndividualSessionsForStudent/getGroupSessionsForStudent),
// so they get their own columns rather than one combined number.
//
// The table itself renders instantly from data already in memory
// (state.students) — the per-student session-number lookups are genuinely
// slow (2 Firestore queries each), so those fill in afterwards per-cell
// instead of blocking the whole screen behind a "Loading…" spinner.
async function renderStudentRegistryBody({ highlightAdd = false } = {}) {
  const body = $("student-registry-body");
  if (!body) return;

  const sorted = [...state.students].sort((a, b) => a.name.localeCompare(b.name));

  body.innerHTML = `
    <div style="padding:1rem">
      <div style="display:flex;gap:.6rem;margin-bottom:1rem;flex-wrap:wrap">
        <button class="export-btn" id="btn-add-student-row">+ Add New Student</button>
        <button class="export-btn" id="btn-delete-student-row" style="color:#dc2626">Delete Student</button>
      </div>
      <div class="view-table-wrapper">
        <table class="view-table">
          <colgroup>
            <col style="width:42px">
            <col style="width:14%">
            <col style="width:14%">
            <col style="width:110px">
            <col style="width:160px">
            <col style="width:150px">
          </colgroup>
          <thead>
            <tr>
              <th>No.</th>
              <th>First Name</th>
              <th>Last Name</th>
              <th style="white-space:normal">Ready for Word Export</th>
              <th style="white-space:normal">Latest Individual Session Recorded</th>
              <th style="white-space:normal">Latest Group Session Recorded</th>
            </tr>
          </thead>
          <tbody id="student-registry-tbody">
            ${sorted.map((s, i) => `
              <tr class="registry-row" data-id="${escHtml(s.id)}" style="cursor:pointer">
                <td style="text-align:center">${i + 1}</td>
                <td style="text-align:center">${escHtml(s.firstName || s.name.split(/\s+/)[0] || "")}</td>
                <td style="text-align:center">${escHtml(s.lastName || s.name.split(/\s+/).slice(1).join(" ") || "")}</td>
                <td style="text-align:center">
                  <button class="btn-word-export-ready${s.readyForWordExport ? " is-ready" : ""}"
                    data-id="${escHtml(s.id)}" data-ready="${s.readyForWordExport ? "1" : "0"}">
                    ${s.readyForWordExport ? "✓ Ready" : "No"}
                  </button>
                </td>
                <td class="reg-indiv-num" data-id="${escHtml(s.id)}" style="text-align:center">…</td>
                <td class="reg-group-num" data-id="${escHtml(s.id)}" style="text-align:center">…</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
      ${sorted.length === 0 ? `<p class="empty-hint" style="padding:1rem">No students registered yet.</p>` : ""}
    </div>`;

  $("student-registry-body").querySelectorAll(".registry-row").forEach(row => {
    row.addEventListener("click", () => {
      const s = state.students.find(x => x.id === row.dataset.id);
      if (s) openManageModal(s);
    });
  });

  $("student-registry-body").querySelectorAll(".btn-word-export-ready").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation(); // don't open the manage modal
      const studentId = btn.dataset.id;
      const currentlyReady = btn.dataset.ready === "1";
      const s = state.students.find(x => x.id === studentId);
      if (!s) return;
      const action = currentlyReady ? "mark as NOT ready" : "mark as READY";
      if (!confirm(`Are you sure you want to ${action} for Word export?\n\n${s.name}`)) return;
      const newReady = !currentlyReady;
      btn.disabled = true;
      try {
        await setStudentWordExportReady(studentId, newReady);
        s.readyForWordExport = newReady;
        btn.dataset.ready = newReady ? "1" : "0";
        btn.textContent = newReady ? "✓ Ready" : "No";
        btn.classList.toggle("is-ready", newReady);
      } finally {
        btn.disabled = false;
      }
    });
  });

  $("btn-add-student-row").addEventListener("click", startAddStudentRow);
  $("btn-delete-student-row").addEventListener("click", promptDeleteStudentFromRegistry);

  if (highlightAdd) {
    const btn = $("btn-add-student-row");
    btn.classList.add("btn-flash-hint");
    setTimeout(() => btn.classList.remove("btn-flash-hint"), 3400);
  }

  const latestNumber = sessions => sessions.reduce((max, s) => Math.max(max, s.number || 0), 0);
  sorted.forEach(s => {
    Promise.all([
      getIndividualSessionsForStudent(s.id).catch(() => []),
      getGroupSessionsForStudent(s.id).catch(() => [])
    ]).then(([indiv, group]) => {
      const indivCell = body.querySelector(`.reg-indiv-num[data-id="${s.id}"]`);
      const groupCell = body.querySelector(`.reg-group-num[data-id="${s.id}"]`);
      if (indivCell) indivCell.textContent = latestNumber(indiv) || "—";
      if (groupCell) groupCell.textContent = latestNumber(group) || "—";
    });
  });
}

function startAddStudentRow() {
  const tbody = $("student-registry-tbody");
  if (!tbody || $("new-student-row")) return;
  $("btn-add-student-row").disabled = true;
  const nextNo = tbody.querySelectorAll("tr").length + 1;
  const tr = document.createElement("tr");
  tr.id = "new-student-row";
  tr.innerHTML = `
    <td style="padding:.5rem .3rem;text-align:center">${nextNo}</td>
    <td style="padding:.3rem"><input class="admin-input" id="new-student-first" placeholder="First name" style="width:100%;text-align:center" /></td>
    <td style="padding:.3rem"><input class="admin-input" id="new-student-last" placeholder="Last name" style="width:100%;text-align:center" /></td>
    <td colspan="2" style="padding:.3rem;display:flex;gap:.4rem">
      <button class="btn-primary-sm" id="btn-save-new-student">Save</button>
      <button class="btn-adm-edit" id="btn-cancel-new-student">Cancel</button>
    </td>`;
  tbody.appendChild(tr);
  tr.scrollIntoView({ block: "center" });

  const firstInput = $("new-student-first");
  const lastInput  = $("new-student-last");
  firstInput.focus();
  firstInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); lastInput.focus(); } });
  lastInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("btn-save-new-student").click(); } });

  $("btn-save-new-student").addEventListener("click", async () => {
    const firstName = firstInput.value.trim();
    const lastName  = lastInput.value.trim();
    if (!firstName || !lastName) {
      alert("Please enter both a first name and a last name.");
      return;
    }
    const s = {
      id: cfgId("s"),
      name: `${firstName} ${lastName}`,
      firstName, lastName,
      type: "unassigned",
      order: state.students.length,
      targets: []
    };
    state.students.push(s);
    await withSaveFeedback($("btn-save-new-student"), saveStudent(s));
    renderStudentRegistryBody();
  });

  $("btn-cancel-new-student").addEventListener("click", renderStudentRegistryBody);
}

async function promptDeleteStudentFromRegistry() {
  if (state.students.length === 0) { alert("No students to delete."); return; }
  const sorted = [...state.students].sort((a, b) => a.name.localeCompare(b.name));
  const choice = prompt(
    "Type the No. of the student to delete:\n" +
    sorted.map((s, i) => `${i + 1}. ${s.name}`).join("\n")
  );
  if (choice === null) return;
  const idx = Number(choice) - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= sorted.length) {
    alert("Invalid number.");
    return;
  }
  const student = sorted[idx];
  const typed = prompt(`Type DELETE to permanently delete "${student.name}". Session data is kept in Firebase, but the student will be removed from all lists.`);
  if (typed !== "DELETE") return;
  state.students = state.students.filter(s => s.id !== student.id);
  await deleteStudentConfig(student.id);
  renderStudentRegistryBody();
}

// Dice's coefficient over character bigrams — a cheap, dependency-free way
// to score "is this basically the same text, just reworded/typo'd" (high
// score) vs "this is a different activity entirely" (low score). Used by
// runDataIntegrityCheck to separate likely propagation-failure renames from
// activities that were deliberately deleted/restructured (where the old
// recorded data is CORRECTLY preserved under its original name forever —
// not a bug, and should never be auto-merged into an unrelated activity).
function stringSimilarity(a, b) {
  const norm = s => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = s => {
    const map = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };
  const ba = bigrams(a), bb = bigrams(b);
  let shared = 0;
  for (const [bg, count] of ba) if (bb.has(bg)) shared += Math.min(count, bb.get(bg));
  let totalA = 0; for (const c of ba.values()) totalA += c;
  let totalB = 0; for (const c of bb.values()) totalB += c;
  return (totalA + totalB) === 0 ? 0 : (2 * shared) / (totalA + totalB);
}

// Temporary diagnostic tool (v606/v607) — scans every student and group's
// full session history for "orphaned" activities: real, recorded remark
// data sitting under an activityName text that no current
// predefinedActivities entry matches for that target. This is the exact
// shape left behind by the heading-rename bug fixed in v606 (and the older
// FEDC1/Comment race from v596) — but it's ALSO the exact shape left behind
// by deliberately deleting/restructuring a target's activity list, which is
// correct, intended data preservation, not a bug. stringSimilarity above
// splits findings into "likely a simple rename" (high text overlap with a
// current activity — worth reviewing) vs "likely deliberate restructuring"
// (low overlap with everything — left collapsed, no action implied).
// Read-only: it only reports findings so the boss can confirm each one
// before any repair is written, rather than guessing and silently merging
// data that might not actually belong together. Remove this button/
// function once the backlog from before v606 has been fully reviewed.
const LIKELY_RENAME_THRESHOLD = 0.45;

// Findings live here (not just in the rendered HTML) so the Merge buttons
// below can hand the exact in-memory orphanName/bestMatch strings straight
// to renameActivityAcrossSessions — no round-trip through rendered HTML,
// copy-paste into chat, and hand-retyped code, which is exactly how 4 of
// the 38 v609 batch-1 repairs silently no-op'd (an invisible whitespace/
// quote-style difference between the boss's pasted report text and the
// real Firestore string meant the === match in renameActivityAcrossSessions
// never fired). Clicking Merge here can never have that problem, since the
// string never leaves memory.
let _dataIntegrityFindings = [];
// Separate from the rename findings above: this catches a DIFFERENT shape
// of problem — two activities created in the SAME session under the exact
// same (targetName, activityName), where the name matches the current
// config perfectly (so the rename-detection above sees nothing wrong) but
// whichever duplicate isn't picked by the first-match lookup used
// everywhere becomes invisible. See mergeDuplicateActivity's comment in
// firebase-service.js for how this happens (a race in the structured/
// mapped-score auto-fill that an in-memory guard can't catch across
// separate devices/tabs/reloads).
let _dataIntegrityDuplicates = [];

async function runDataIntegrityCheck() {
  $("manage-modal-title").textContent = "Data Integrity Check";
  $("manage-modal-body").innerHTML = `<p style="padding:1rem">Scanning every student and group's full session history… this can take a little while.</p>`;
  $("manage-modal").classList.remove("hidden");

  const findings = [];
  const duplicates = [];

  const scanTargets = async (who, entityId, isGroup, targets, sessions) => {
    for (const target of (targets || [])) {
      const validNames = [...new Set(
        (target.predefinedActivities || [])
          .filter(pa => !pa.isHeading && !pa.isNote)
          .map(pa => pa.name)
      )];
      const validNameSet = new Set(validNames);
      const byOrphanName = new Map();
      for (const session of sessions) {
        const actIdsByName = new Map();
        for (const [actId, act] of Object.entries(session.activities || {})) {
          if (act.targetName !== target.name) continue;
          if (!actIdsByName.has(act.activityName)) actIdsByName.set(act.activityName, []);
          actIdsByName.get(act.activityName).push(actId);
          if (validNameSet.has(act.activityName)) continue;
          const remarks = Object.values(session.remarks || {}).filter(r => r.activityId === actId);
          if (remarks.length === 0) continue; // no real data — not worth reporting
          const entry = byOrphanName.get(act.activityName) || { count: 0, dates: [], sample: null };
          entry.count++;
          entry.dates.push(session.date);
          if (!entry.sample) entry.sample = plainTextForEdit(remarks[0].text || "").slice(0, 140);
          byOrphanName.set(act.activityName, entry);
        }
        for (const [activityName, actIds] of actIdsByName) {
          if (actIds.length < 2) continue;
          const withCounts = actIds.map(actId => ({
            actId,
            remarkCount: Object.values(session.remarks || {}).filter(r => r.activityId === actId).length
          })).sort((a, b) => b.remarkCount - a.remarkCount);
          duplicates.push({
            who, entityId, isGroup, targetName: target.name, activityName,
            sessionId: session.id, sessionDate: session.date,
            primaryActId: withCounts[0].actId,
            duplicateActIds: withCounts.slice(1).map(w => w.actId),
            remarkCounts: withCounts,
            merged: false
          });
        }
      }
      for (const [orphanName, info] of byOrphanName) {
        const dates = info.dates.slice().sort();
        let bestMatch = null, bestSim = 0;
        for (const name of validNames) {
          const sim = stringSimilarity(orphanName, name);
          if (sim > bestSim) { bestSim = sim; bestMatch = name; }
        }
        findings.push({
          who, entityId, isGroup, targetName: target.name, orphanName,
          sessionCount: info.count,
          dateRange: dates.length > 1 ? `${dates[0]} → ${dates[dates.length - 1]}` : dates[0],
          sample: info.sample,
          bestMatch, bestSim, merged: false
        });
      }
    }
  };

  for (const student of state.students) {
    try {
      const sessions = await getAllSessionsForStudent(student.id);
      await scanTargets(student.name, student.id, false, student.targets, sessions);
    } catch (err) { console.error(`Data integrity scan failed for ${student.name}:`, err); }
  }
  for (const group of state.groups) {
    try {
      const sessions = await getAllSessionsForGroup(group.id);
      await scanTargets(`${group.name} (group)`, group.id, true, group.targets, sessions);
    } catch (err) { console.error(`Data integrity scan failed for ${group.name}:`, err); }
  }

  _dataIntegrityFindings  = findings;
  _dataIntegrityDuplicates = duplicates;

  if (findings.length === 0 && duplicates.length === 0) {
    $("manage-modal-body").innerHTML = `<p style="padding:1rem">No orphaned or duplicate activity data found. Everything currently matches up.</p>`;
    return;
  }

  renderDataIntegrityReport();
}

function renderDataIntegrityReport() {
  const findings = _dataIntegrityFindings;
  const likely     = findings.filter(f => f.bestSim >= LIKELY_RENAME_THRESHOLD && !f.merged);
  const structural = findings.filter(f => f.bestSim <  LIKELY_RENAME_THRESHOLD && !f.merged);
  const merged      = findings.filter(f => f.merged);

  const dupesOpen   = _dataIntegrityDuplicates.filter(d => !d.merged);
  const dupesMerged = _dataIntegrityDuplicates.filter(d => d.merged);

  $("manage-modal-body").innerHTML = `
    <div style="padding:1rem">
      <p style="margin-bottom:1rem">Scanned everyone's full history — ${findings.length} orphaned activit${findings.length === 1 ? "y" : "ies"} with real recorded data found, plus ${_dataIntegrityDuplicates.length} duplicate activit${_dataIntegrityDuplicates.length === 1 ? "y" : "ies"} within a single session.</p>

      <h3 style="margin:.5rem 0">Duplicate activities in one session — same name, two records (${dupesOpen.length})</h3>
      <p style="color:var(--text-muted);font-size:.85rem;margin-bottom:.5rem">The name matches the current config fine — the problem is two separate activity records exist for that one name in the same session (usually from a sync race), and only one of them ever shows up on the entry/View screens. Merging moves any remarks off the empty/lesser one onto the one already being displayed, then removes the now-empty duplicate.</p>
      ${dupesOpen.length === 0 ? `<p style="color:var(--text-muted);font-size:.85rem">None found.</p>` : dupesOpen.map(d => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:.75rem;margin-bottom:.75rem">
          <div><strong>${escHtml(d.who)}</strong> — ${escHtml(d.targetName)} — ${escHtml(d.sessionDate)}</div>
          <div style="margin-top:.3rem">Activity: <strong>${escHtml(d.activityName)}</strong></div>
          <div style="margin-top:.3rem;color:var(--text-muted);font-size:.85rem">${d.remarkCounts.length} records found — remark counts: ${d.remarkCounts.map(w => w.remarkCount).join(", ")} (keeping the one with the most, folding the rest into it)</div>
          <button class="btn-primary-sm btn-integrity-merge-dup" data-idx="${_dataIntegrityDuplicates.indexOf(d)}" style="margin-top:.5rem">Merge duplicates</button>
        </div>
      `).join("")}

      ${dupesMerged.length === 0 ? "" : `
        <h3 style="margin:1.5rem 0 .5rem;color:#16a34a">Duplicates merged just now (${dupesMerged.length})</h3>
        ${dupesMerged.map(d => `<div style="padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.85rem">${escHtml(d.who)} — ${escHtml(d.targetName)} — ${escHtml(d.sessionDate)}: "${escHtml(d.activityName)}"</div>`).join("")}
      `}

      <h3 style="margin:1.5rem 0 .5rem">Likely simple renames — worth reviewing (${likely.length})</h3>
      ${likely.length === 0 ? `<p style="color:var(--text-muted);font-size:.85rem">None found.</p>` : likely.map(f => `
        <div style="border:1px solid var(--border);border-radius:8px;padding:.75rem;margin-bottom:.75rem">
          <div><strong>${escHtml(f.who)}</strong> — ${escHtml(f.targetName)}</div>
          <div style="margin-top:.3rem">Old name: <strong>${escHtml(f.orphanName)}</strong></div>
          <div style="margin-top:.3rem">Best current match: <strong>${escHtml(f.bestMatch || "(none)")}</strong> <span style="color:var(--text-muted);font-size:.85rem">(${Math.round(f.bestSim * 100)}% text overlap)</span></div>
          <div style="margin-top:.3rem;color:var(--text-muted);font-size:.85rem">Affects ${f.sessionCount} session${f.sessionCount === 1 ? "" : "s"} (${escHtml(f.dateRange)})</div>
          <div style="margin-top:.3rem;color:var(--text-muted);font-size:.85rem">Sample remark: "${escHtml(f.sample || "")}"</div>
          <button class="btn-primary-sm btn-integrity-merge" data-idx="${findings.indexOf(f)}" style="margin-top:.5rem">Merge into "${escHtml(f.bestMatch || "")}"</button>
        </div>
      `).join("")}

      ${merged.length === 0 ? "" : `
        <h3 style="margin:1.5rem 0 .5rem;color:#16a34a">Merged just now (${merged.length})</h3>
        ${merged.map(f => `<div style="padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.85rem">${escHtml(f.who)} — ${escHtml(f.targetName)}: "${escHtml(f.orphanName)}" → "${escHtml(f.bestMatch)}"</div>`).join("")}
      `}

      <h3 style="margin:1.5rem 0 .5rem">Looks like deliberate restructuring — no action needed (${structural.length})</h3>
      <p style="color:var(--text-muted);font-size:.85rem;margin-bottom:.5rem">These old names don't closely match anything currently in their target, which usually means the activity list was rebuilt on purpose. If you want to permanently remove this data from all past sessions (so it stops appearing in Excel exports), click "Delete from all sessions" — this is irreversible.</p>
      ${structural.length === 0 ? "" : `<details>
        <summary style="cursor:pointer">Show the list anyway</summary>
        ${structural.map(f => `
          <div style="border:1px solid var(--border);border-radius:8px;padding:.75rem;margin:.5rem 0">
            <div><strong>${escHtml(f.who)}</strong> — ${escHtml(f.targetName)}</div>
            <div style="margin-top:.3rem;font-size:.9rem">Orphaned name: <strong>${escHtml(f.orphanName)}</strong></div>
            <div style="margin-top:.3rem;color:var(--text-muted);font-size:.85rem">Affects ${f.sessionCount} session${f.sessionCount === 1 ? "" : "s"} (${escHtml(f.dateRange || "")})</div>
            ${f.sample ? `<div style="margin-top:.3rem;color:var(--text-muted);font-size:.85rem">Sample: "${escHtml(f.sample)}"</div>` : ""}
            <button class="btn-adm-danger btn-integrity-delete-orphan" data-idx="${findings.indexOf(f)}"
              style="margin-top:.6rem;font-size:.8rem;padding:.3rem .75rem">Delete from all sessions</button>
          </div>
        `).join("")}
      </details>`}

      ${(() => { const deleted = findings.filter(f => f.deleted); return deleted.length === 0 ? "" : `
        <h3 style="margin:1.5rem 0 .5rem;color:#dc2626">Permanently deleted just now (${deleted.length})</h3>
        ${deleted.map(f => `<div style="padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.85rem">${escHtml(f.who)} — ${escHtml(f.targetName)}: "${escHtml(f.orphanName)}"</div>`).join("")}
      `; })()}
    </div>`;

  $("manage-modal-body").querySelectorAll(".btn-integrity-merge").forEach(btn => {
    btn.addEventListener("click", async () => {
      const f = _dataIntegrityFindings[Number(btn.dataset.idx)];
      if (!f || f.merged) return;
      btn.disabled = true;
      btn.textContent = "Merging…";
      try {
        if (f.isGroup) {
          await renameGroupActivityAcrossSessions(f.entityId, f.targetName, f.orphanName, f.bestMatch);
        } else {
          await renameActivityAcrossSessions(f.entityId, f.targetName, f.orphanName, f.bestMatch);
        }
        f.merged = true;
        renderDataIntegrityReport();
      } catch (err) {
        console.error("Data integrity merge failed:", err);
        btn.disabled = false;
        btn.textContent = `Merge into "${f.bestMatch}" (failed — try again)`;
      }
    });
  });

  $("manage-modal-body").querySelectorAll(".btn-integrity-merge-dup").forEach(btn => {
    btn.addEventListener("click", async () => {
      const d = _dataIntegrityDuplicates[Number(btn.dataset.idx)];
      if (!d || d.merged) return;
      btn.disabled = true;
      btn.textContent = "Merging…";
      try {
        for (const dupActId of d.duplicateActIds) {
          await mergeDuplicateActivity(d.sessionId, d.primaryActId, dupActId);
        }
        d.merged = true;
        renderDataIntegrityReport();
      } catch (err) {
        console.error("Duplicate merge failed:", err);
        btn.disabled = false;
        btn.textContent = "Merge duplicates (failed — try again)";
      }
    });
  });

  $("manage-modal-body").querySelectorAll(".btn-integrity-delete-orphan").forEach(btn => {
    btn.addEventListener("click", async () => {
      const f = _dataIntegrityFindings[Number(btn.dataset.idx)];
      if (!f || f.deleted) return;
      if (btn.dataset.confirming !== "1") {
        btn.dataset.confirming = "1";
        btn.textContent = "⚠️ Confirm — permanently delete?";
        setTimeout(() => {
          if (btn.dataset.confirming === "1") {
            btn.dataset.confirming = "";
            btn.textContent = "Delete from all sessions";
          }
        }, 4000);
        return;
      }
      btn.disabled = true;
      btn.textContent = "Deleting…";
      try {
        if (f.isGroup) {
          await deleteGroupOrphanAcrossSessions(f.entityId, f.targetName, f.orphanName);
        } else {
          await deleteOrphanAcrossSessions(f.entityId, f.targetName, f.orphanName);
        }
        f.deleted = true;
        renderDataIntegrityReport();
      } catch (err) {
        console.error("Orphan delete failed:", err);
        btn.disabled = false;
        btn.dataset.confirming = "";
        btn.textContent = "Delete from all sessions (failed — try again)";
      }
    });
  });
}

// Choosing a student here adds them to Individual Sessions or Assessments.
// One flat list, no separate "transfer" entry — an Assessment student
// shows up right alongside everyone else in the Individual Sessions
// picker, and clicking them just asks a one-line confirm tailored to what's
// actually happening ("Move X from Assessment...?") instead of a special
// menu item or a guard error sending the boss elsewhere. Doesn't create a
// new person directly — "Register a New Student" sends the boss to the
// Student Database page instead, which is the one place new students get
// created (see openStudentRegistryScreen).
function showRegisteredStudentPicker(targetType) {
  $("session-picker-title").textContent =
    targetType === "assessment" ? "Add to Assessments" : "Add to Individual Sessions";

  const renderList = () => {
    // Leave out students already in this exact bucket, and — since
    // Individual Sessions and Assessment are mutually exclusive — also
    // leave Individual Sessions students out of the Assessment picker.
    const candidates = state.students
      .filter(s => s.type !== targetType)
      .filter(s => !(targetType === "assessment" && s.type === "existing"))
      .sort((a, b) => a.name.localeCompare(b.name));

    $("session-picker-list").innerHTML = `
      <div class="choice-list">
        <button class="choice-btn choice-register-new">
          <span class="choice-icon">➕</span>
          <div class="choice-text"><div class="choice-label">Register a New Student</div></div>
        </button>
        ${candidates.map(s => `
          <button class="choice-btn reg-student-pick" data-id="${escHtml(s.id)}">
            <div class="choice-text"><div class="choice-label">${escHtml(s.name)}</div></div>
          </button>`).join("")}
      </div>
      ${candidates.length === 0 ? `<p class="empty-hint" style="padding:1rem">All registered students have already been added.</p>` : ""}`;

    $("session-picker-list").querySelector(".choice-register-new").addEventListener("click", () => {
      closeSessionPicker();
      openStudentRegistryScreen({ highlightAdd: true });
    });
    $("session-picker-list").querySelectorAll(".reg-student-pick").forEach(btn => {
      btn.addEventListener("click", async () => {
        const s = state.students.find(x => x.id === btn.dataset.id);
        if (s) await assignStudentToBucket(s, targetType);
      });
    });
  };

  renderList();
  $("session-picker-modal").classList.remove("hidden");
}

async function assignStudentToBucket(student, targetType) {
  if (student.type === targetType) {
    alert(`"${student.name}" is already in ${targetType === "existing" ? "Individual Sessions" : "Assessments"}.`);
    return;
  }
  if (student.type === "assessment" && targetType === "existing") {
    if (!confirm(`Move "${student.name}" from Assessment to Individual Sessions?`)) return;
  } else if (student.type === "existing" && targetType === "assessment") {
    alert(`"${student.name}" is already in Individual Sessions.`);
    return;
  }
  student.type = targetType;
  await saveStudent(student);
  closeSessionPicker();
  if (targetType === "existing") renderExistingStudentButtons();
  else renderAssessmentStudentButtons();
}

async function addNewTemplate() {
  const name = prompt("Template name:");
  if (!name?.trim()) return;
  const t = {
    id: cfgId("tmpl"),
    name: name.trim(),
    order: state.templates.length,
    predefinedActivities: [],
    notes: [],
    maxPoints: 3
  };
  state.templates.push(t);
  await saveTemplate(t);
  renderTemplateButtons();
  openManageModal(null, null, t);
}

// ── Render helpers ────────────────────────────────────────────

function renderStudentList(container, students, query = "") {
  if (!container) return;
  const q = query.toLowerCase();
  const filtered = students
    .filter(s => !q || s.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (filtered.length === 0) {
    container.innerHTML = q
      ? `<p class="empty-hint">No matches.</p>`
      : `<p class="empty-hint">None yet.</p>`;
    return;
  }
  container.innerHTML = `<div class="roster-list">` +
    filtered.map(s => `
      <button class="roster-item" data-id="${s.id}">
        <span class="roster-item-name">${escHtml(s.name)}</span>
      </button>
    `).join("") +
    `</div>`;
  container.querySelectorAll(".roster-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const student = state.students.find(s => s.id === btn.dataset.id);
      if (student) showStudentChoice(student);
    });
  });
}

function renderExistingStudentButtons() {
  // Pre-registry records have no type field at all (undefined) and should
  // keep defaulting to "existing" for backward compatibility — only the new
  // explicit "unassigned" (set when a student is registered via the Student
  // Database page or a group roster picker) opts out of that default, so a
  // freshly-registered student doesn't show here until she actually +Adds
  // them via showRegisteredStudentPicker.
  const students = state.students.filter(s => s.type !== "assessment" && s.type !== "unassigned");
  renderStudentList($("existing-student-buttons"), students, state.searchExisting);
}

function addNewGroup() {
  const g = { id: cfgId("g"), name: "", order: state.groups.length, students: [], targets: [] };
  state.groups.push(g);
  renderGroupButtons();
  _newGroupId = g.id;
  openGroupManageModal(g);
  saveGroup(g).catch(() => {});
}

function groupAutoName(students) {
  return (students || []).join(" & ");
}

function renderGroupButtons() {
  const container = $("group-buttons");
  if (!container) return;
  const q = state.searchGroup.toLowerCase();
  const filtered = state.groups
    .filter(g => !q || g.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (filtered.length === 0) {
    container.innerHTML = q
      ? `<p class="empty-hint">No matches.</p>`
      : `<p class="empty-hint">None yet.</p>`;
    return;
  }
  container.innerHTML = `<div class="roster-list">` +
    filtered.map(g => `<button class="roster-item" data-id="${g.id}"><span class="roster-item-name">${escHtml(g.name)}</span></button>`).join("") +
    `</div>`;
  container.querySelectorAll(".roster-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const group = state.groups.find(g => g.id === btn.dataset.id);
      if (group) showGroupChoice(group);
    });
  });
}

function renderAssessmentStudentButtons() {
  const students = state.students.filter(s => s.type === "assessment");
  renderStudentList($("assessment-student-buttons"), students, state.searchAssessment);
}

function renderTemplateButtons() {
  const container = $("template-buttons");
  if (!container) return;
  const q = state.searchTemplate.toLowerCase();
  const filtered = state.templates
    .filter(t => !q || t.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  let html = "";
  if (filtered.length === 0 && !q) {
    html = `<p class="empty-hint">No templates yet.</p>`;
  } else if (filtered.length === 0) {
    html = `<p class="empty-hint">No matches.</p>`;
  } else {
    html = `<div class="roster-list">` +
      filtered.map(t => `
        <button class="roster-item" data-id="${t.id}">
          <span class="roster-item-name">${escHtml(t.name)}</span>
        </button>
      `).join("") +
      `</div>`;
  }
  container.innerHTML = html;

  container.querySelectorAll(".roster-item").forEach(btn => {
    btn.addEventListener("click", () => {
      const tmpl = state.templates.find(t => t.id === btn.dataset.id);
      if (tmpl) openManageModal(null, null, tmpl);
    });
  });
}

function renderExportButtons() {
  const exportAllContainer = $("export-all-button");
  if (!exportAllContainer) return;

  exportAllContainer.innerHTML = `
    <div style="display:flex;gap:.6rem;flex-wrap:wrap">
      <button class="export-btn export-btn-all" id="btn-export-all-trials">Backup All Excel (ZIP)</button>
      <button class="export-btn" id="btn-data-integrity-check">🔍 Run Data Integrity Check</button>
    </div>`;

  const wire = (btnId, defaultLabel, includeTrials) => {
    $(btnId).addEventListener("click", async () => {
      const btn = $(btnId);
      btn.style.width = btn.offsetWidth + "px";
      btn.disabled = true;
      btn.textContent = "Generating…";
      try {
        await exportAllStudents(state.students, state.groups, includeTrials);
      } catch (err) {
        alert("Export failed: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = defaultLabel;
        btn.style.width = "";
      }
    });
  };
  wire("btn-export-all-trials", "Backup All Excel (ZIP)", true);
  $("btn-data-integrity-check").addEventListener("click", runDataIntegrityCheck);
}

// ============================================================
// SESSION PICKER
// ============================================================

// Show three-choice sheet: Today's Session | Edit Past Sessions | Manage Student
function showStudentChoice(student) {
  $("session-picker-title").textContent = student.name;
  $("session-picker-list").innerHTML = `
    <div class="choice-list">
      <button class="choice-btn choice-today">
        <span class="choice-icon">▶️</span>
        <div class="choice-text">
          <div class="choice-label">Start Session</div>
        </div>
      </button>
      <button class="choice-btn choice-other">
        <span class="choice-icon">🗂️</span>
        <div class="choice-text">
          <div class="choice-label">View/Edit Past Sessions</div>
        </div>
      </button>
      <button class="choice-btn choice-manage">
        <span class="choice-icon">✏️</span>
        <div class="choice-text">
          <div class="choice-label">Manage Student</div>
        </div>
      </button>
      <button class="choice-btn choice-export-excel">
        <span class="choice-icon">📊</span>
        <div class="choice-text">
          <div class="choice-label">Export to Excel (Yearly Summary)</div>
        </div>
      </button>
      <button class="choice-btn choice-export-word">
        <span class="choice-icon">📝</span>
        <div class="choice-text">
          <div class="choice-label">Export to Word (Daily Session Note)</div>
        </div>
      </button>
    </div>`;
  $("session-picker-modal").classList.remove("hidden");

  $("session-picker-list").querySelector(".choice-export-excel").addEventListener("click", () => {
    showExportTrialsChoice(student.name, includeTrials => exportStudentData(student, includeTrials));
  });
  $("session-picker-list").querySelector(".choice-export-word").addEventListener("click", () => {
    showExportSessionPickerGeneric(
      student.name,
      () => getRecentSessionsForStudent(student.id),
      session => exportStudentSingleSessionWord(student, session)
    );
  });

  $("session-picker-list").querySelector(".choice-today").addEventListener("click", () => {
    const today = getTodayString();
    const yesterday = (() => {
      const d = new Date(today + "T00:00:00"); d.setDate(d.getDate() - 1);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    })();
    const fmtShort = dateStr => {
      const [, m, d] = dateStr.split("-").map(Number);
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${d} ${months[m - 1]}`;
    };

    // Pre-fetch sessions immediately so ticks are ready by the time user clicks "Pick A Date"
    const sessionsFetch = getRecentSessionsForStudent(student.id);

    $("session-picker-list").innerHTML = `
      <div class="session-date-step">
        <p class="session-date-prompt">What date is this session for?</p>
        <div class="date-quick-btns">
          <button class="btn-date-quick" data-date="${yesterday}">Yesterday (${fmtShort(yesterday)})</button>
          <button class="btn-date-quick" data-date="${today}">Today (${fmtShort(today)})</button>
          <button class="btn-date-other">Pick A Date</button>
        </div>
      </div>`;

    $("session-picker-list").querySelectorAll(".btn-date-quick").forEach(btn => {
      btn.addEventListener("click", () => {
        closeSessionPicker();
        openSession(student, null, btn.dataset.date);
      });
    });

    $("session-picker-list").querySelector(".btn-date-other").addEventListener("click", () => {
      const [ty, tm] = today.split("-").map(Number);
      const displayDate = `${ty}-${String(tm).padStart(2,"0")}-01`;
      // Render immediately so iPad doesn't see a frozen UI while waiting for network
      renderStartSessionCalendar(student, today, displayDate, new Set());
      // Use the pre-fetched promise — likely already resolved by now
      sessionsFetch
        .then(sessions => {
          const takenDates = new Set(sessions.map(s => s.date));
          renderStartSessionCalendar(student, today, displayDate, takenDates);
        })
        .catch(() => {});
    });
  });
  $("session-picker-list").querySelector(".choice-other").addEventListener("click", () => {
    showSessionPicker(student);
  });
  $("session-picker-list").querySelector(".choice-manage").addEventListener("click", () => {
    closeSessionPicker();
    openManageModal(student, null);
  });
}

// Page 1: month grid
async function showSessionPicker(student) {
  $("session-picker-title").textContent = student.name;
  $("session-picker-list").innerHTML =
    `<div class="session-picker-loading">Loading sessions…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentSessionsForStudent(student.id); } catch (err) { console.error("getRecentSessionsForStudent failed:", err); }

  // Auto-delete sessions with no meaningful data for any currently existing target
  const currentTargetNames = new Set((student.targets || []).map(t => t.name));
  const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
  const hasUsefulData = s => {
    if (Object.values(s.fedcComments || {}).some(c => stripEmpty(c).length > 0)) return true;
    return Object.values(s.remarks || {}).some(r => {
      const act = (s.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      const hasText   = stripEmpty(r.text).length > 0;
      const hasTrials = (r.trials      || []).some(t => t !== null && t !== -1);
      const hasNote   = stripEmpty(r.masteryNote).length > 0;
      return hasText || hasTrials || hasNote;
    });
  };
  const emptySessions = sessions.filter(s => !hasUsefulData(s));
  emptySessions.forEach(s => deleteSession(s.id).catch(() => {}));
  if (emptySessions.length > 0) resequenceIndividualSessions(student.id).catch(() => {});
  sessions = sessions.filter(s => !emptySessions.some(e => e.id === s.id));

  const today = getTodayString();
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  if (byMonth.size === 0) {
    $("session-picker-list").innerHTML =
      `<div class="session-picker-loading">No sessions found.</div>`;
    return;
  }

  renderMonthGrid(student, byMonth, today, sessions);
}

function renderMonthGrid(student, byMonth, today, sessions) {
  $("session-picker-title").textContent = student.name;

  let html = `<div class="month-grid">
    <button class="month-grid-btn month-grid-btn-pickdate" data-action="pick-date">
      <span class="mgb-pickdate-label">Pick A Date</span>
    </button>`;
  for (const month of byMonth.keys()) {
    const [name, year] = month.split(" ");
    const abbr = name.slice(0, 3);
    html += `<button class="month-grid-btn" data-month="${escHtml(month)}">
      <span class="mgb-month">${escHtml(abbr)}</span>
      <span class="mgb-year">${escHtml(year)}</span>
    </button>`;
  }
  html += `</div>`;

  const list = $("session-picker-list");
  list.innerHTML = html;

  list.querySelector('[data-action="pick-date"]').addEventListener("click", () => {
    const mostRecent = sessions.reduce((max, s) => (s.date > max ? s.date : max), sessions[0].date);
    renderPickDateCalendar(student, sessions, byMonth, today, `${mostRecent.slice(0, 7)}-01`);
  });

  list.querySelectorAll(".month-grid-btn[data-month]").forEach(btn => {
    btn.addEventListener("click", () => {
      const month = btn.dataset.month;
      renderSessionsForMonth(student, month, byMonth.get(month), byMonth, today, sessions);
    });
  });
}

// Page 2: sessions for chosen month
function renderSessionsForMonth(student, month, monthSessions, byMonth, today, sessions) {
  $("session-picker-title").textContent = month;

  const list = $("session-picker-list");
  let html = `<button class="btn-picker-back">← Back</button>`;

  const sorted  = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  const display = [...sorted].reverse();
  html += renderSessionListRows(sorted, display, today);

  list.innerHTML = html;

  list.querySelector(".btn-picker-back").addEventListener("click", () => {
    renderMonthGrid(student, byMonth, today, sessions);
  });

  list.querySelectorAll(".session-list-item").forEach(item => {
    item.addEventListener("click", () => {
      closeSessionPicker();
      openSessionView(student, item.dataset.sessionId);
    });
  });
}

// "Pick a Date" calendar: jump straight to any past/today date's View/Edit
// screen — if that date has no session yet, one is created blank (and will
// be auto-deleted on the way out, same as any other empty session, if
// nothing ends up typed into it).
function renderPickDateCalendar(student, sessions, byMonth, today, displayDate) {
  const sessionIdByDate = new Map(sessions.map(s => [s.date, s.id]));
  const [y, m] = displayDate.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
  const [ty, tm] = today.split("-").map(Number);
  const canNext = y < ty || (y === ty && m < tm);
  const pad = n => String(n).padStart(2, "0");
  const prevM = m === 1  ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  const firstDow  = new Date(y, m - 1, 1).getDay();
  const daysInMon = new Date(y, m, 0).getDate();

  let html = `<button class="btn-picker-back">← Back</button>
    <div class="date-picker-wrap">
    <p class="date-picker-legend"><span class="date-taken-dot">✓︎</span> Session recorded on this day</p>
    <div class="date-picker-cal">
      <div class="date-picker-nav">
        <button class="btn-date-prev">‹</button>
        <span class="date-picker-month-label">${escHtml(monthLabel)}</span>
        <button class="btn-date-next"${canNext ? "" : " disabled"}>›</button>
      </div>
      <div class="date-picker-day-headers">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
        <span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="date-picker-grid">`;

  for (let cell = 0; cell < 42; cell++) {
    const d = cell - firstDow + 1;
    if (d < 1 || d > daysInMon) { html += `<span></span>`; continue; }
    const ds      = `${y}-${pad(m)}-${pad(d)}`;
    const isFut   = ds > today;
    const isTaken = sessionIdByDate.has(ds);
    let cls = "date-picker-day";
    if (isFut)   cls += " date-picker-day-future";
    if (isTaken) cls += " date-picker-day-taken";
    const dotCls = isTaken ? "date-taken-dot" : "day-dot-spacer";
    html += `<button class="${cls}" data-date="${ds}"${isFut ? " disabled" : ""}><span class="day-num">${d}</span><span class="${dotCls}">${isTaken ? "✓︎" : ""}</span></button>`;
  }
  html += `</div></div></div>`;

  $("session-picker-title").textContent = "Pick a Date";
  $("session-picker-list").innerHTML = html;

  $("session-picker-list").querySelector(".btn-picker-back").addEventListener("click", () =>
    renderMonthGrid(student, byMonth, today, sessions)
  );
  $("session-picker-list").querySelector(".btn-date-prev").addEventListener("click", () => {
    renderPickDateCalendar(student, sessions, byMonth, today, prevM);
  });
  if (canNext) {
    $("session-picker-list").querySelector(".btn-date-next").addEventListener("click", () => {
      renderPickDateCalendar(student, sessions, byMonth, today, nextM);
    });
  }
  $("session-picker-list").querySelectorAll(".date-picker-day:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      closeSessionPicker();
      const ds = btn.dataset.date;
      const sessionId = sessionIdByDate.get(ds) || await getOrCreateSessionForDate(student.id, ds, student.targets);
      openSessionView(student, sessionId);
    });
  });
}

function closeSessionPicker() {
  $("session-picker-modal").classList.add("hidden");
}

$("session-picker-close").addEventListener("click",    closeSessionPicker);
$("session-picker-backdrop").addEventListener("click", closeSessionPicker);

// ─── EXPORT TO EXCEL: Trials column choice ───────────────────
// Shared by individual students, group members, and the home screen's
// Backup Database — Excel export always asks this explicitly with two
// buttons rather than a browser confirm() dialog. onExport(includeTrials)
// does the actual export.
function showExportTrialsChoice(entityLabel, onExport) {
  $("session-picker-title").textContent = entityLabel;
  $("session-picker-list").innerHTML = `
    <div class="choice-list">
      <button class="choice-btn choice-trials-yes">
        <span class="choice-icon">📊</span>
        <div class="choice-text"><div class="choice-label">Export with Trials</div></div>
      </button>
      <button class="choice-btn choice-trials-no">
        <span class="choice-icon">📊</span>
        <div class="choice-text"><div class="choice-label">Export without Trials</div></div>
      </button>
    </div>`;
  $("session-picker-modal").classList.remove("hidden");

  const run = async (btn, includeTrials) => {
    btn.disabled = true;
    btn.querySelector(".choice-label").textContent = "Generating…";
    try { await onExport(includeTrials); } catch (err) { alert("Export failed: " + err.message); }
    closeSessionPicker();
  };
  $("session-picker-list").querySelector(".choice-trials-yes").addEventListener("click", e => run(e.currentTarget, true));
  $("session-picker-list").querySelector(".choice-trials-no").addEventListener("click", e => run(e.currentTarget, false));
}

// ─── EXPORT NOTES TO WORD (shared by individual students and group members) ─
// entityLabel: display name shown in the picker.
// getSessions(): fetches the full session list to populate the day picker.
// onExportSingle(session): exports the one picked session as a Word doc.
async function showExportSessionPickerGeneric(entityLabel, getSessions, onExportSingle) {
  $("session-picker-title").textContent = entityLabel;
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading sessions…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getSessions(); } catch (_) {}

  const today = getTodayString();
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  if (byMonth.size === 0) {
    $("session-picker-list").innerHTML = `<div class="session-picker-loading">No sessions found.</div>`;
    return;
  }

  renderExportMonthGrid(entityLabel, byMonth, today, onExportSingle);
}

function renderExportMonthGrid(entityLabel, byMonth, today, onExportSingle) {
  $("session-picker-title").textContent = entityLabel;
  let html = `<p class="session-date-prompt">Choose a session note to export:</p><div class="month-grid">`;
  for (const month of byMonth.keys()) {
    const [name, year] = month.split(" ");
    html += `<button class="month-grid-btn" data-month="${escHtml(month)}">
      <span class="mgb-month">${escHtml(name.slice(0, 3))}</span>
      <span class="mgb-year">${escHtml(year)}</span>
    </button>`;
  }
  html += `</div>`;

  const list = $("session-picker-list");
  list.innerHTML = html;

  list.querySelectorAll(".month-grid-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const month = btn.dataset.month;
      renderExportSessionsForMonth(entityLabel, month, byMonth.get(month), byMonth, today, onExportSingle);
    });
  });
}

function renderExportSessionsForMonth(entityLabel, month, monthSessions, byMonth, today, onExportSingle) {
  $("session-picker-title").textContent = month;

  const list = $("session-picker-list");
  let html = `<button class="btn-picker-back">← Back</button>`;
  html += `<p class="session-date-prompt">Choose a session note to export:</p>`;

  const sorted  = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  const display = [...sorted].reverse();
  html += renderSessionListRows(sorted, display, today);

  list.innerHTML = html;

  list.querySelector(".btn-picker-back").addEventListener("click", () => {
    renderExportMonthGrid(entityLabel, byMonth, today, onExportSingle);
  });

  list.querySelectorAll(".session-list-item").forEach(item => {
    item.addEventListener("click", async () => {
      const session = sorted.find(s => s.id === item.dataset.sessionId);
      $("session-picker-title").textContent = "Generating…";
      closeSessionPicker();
      try {
        await onExportSingle(session);
      } catch (err) {
        alert("Export failed: " + err.message);
      }
    });
  });
}

// Group export (Excel or Word) exports one student at a time — ask which
// student in this group first. mode "excel" exports that student's full
// yearly summary directly; mode "word" opens the day picker for a single
// session's daily note.
function showGroupExportStudentPicker(group, mode) {
  $("session-picker-title").textContent = group.name;
  const students = (group.students || []).filter(Boolean);
  $("session-picker-list").innerHTML = students.length
    ? `<div class="choice-list">` +
        students.map(name => `
          <button class="choice-btn choice-export-student" data-name="${escHtml(name)}">
            <span class="choice-icon">📤</span>
            <div class="choice-text"><div class="choice-label">${escHtml(name)}</div></div>
          </button>
        `).join("") +
      `</div>`
    : `<p class="empty-hint">No students in this group.</p>`;
  $("session-picker-modal").classList.remove("hidden");

  $("session-picker-list").querySelectorAll(".choice-export-student").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      if (mode === "word") {
        showExportSessionPickerGeneric(
          `${name} (Group)`,
          () => getRecentGroupSessions(group.id),
          session => exportGroupMemberSingleSessionWord(name, [group], session)
        );
        return;
      }
      showExportTrialsChoice(`${name} (Group)`, includeTrials => exportGroupMemberData(name, [group], includeTrials));
    });
  });
}

// ─── GO TO ANOTHER SESSION ───────────────────────────────────
// Opens session-picker starting at the current session's month.
async function showGoToAnotherSession(student) {
  $("session-picker-title").textContent = student.name;
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading sessions…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentSessionsForStudent(student.id); } catch (err) { console.error("getRecentSessionsForStudent failed:", err); }

  const currentTargetNames = new Set((student.targets || []).map(t => t.name));
  const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
  const hasUsefulData = s => {
    if (Object.values(s.fedcComments || {}).some(c => stripEmpty(c).length > 0)) return true;
    return Object.values(s.remarks || {}).some(r => {
      const act = (s.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      const hasText   = stripEmpty(r.text).length > 0;
      const hasTrials = (r.trials      || []).some(t => t !== null && t !== -1);
      const hasNote   = stripEmpty(r.masteryNote).length > 0;
      return hasText || hasTrials || hasNote;
    });
  };
  // Don't auto-delete the session currently being viewed
  const empties = sessions.filter(s => s.id !== state.viewSessionId && !hasUsefulData(s));
  empties.forEach(s => deleteSession(s.id).catch(() => {}));
  if (empties.length > 0) resequenceIndividualSessions(student.id).catch(() => {});
  sessions = sessions.filter(s => !empties.some(e => e.id === s.id));

  const today = getTodayString();
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  if (byMonth.size === 0) {
    $("session-picker-list").innerHTML = `<div class="session-picker-loading">No sessions found.</div>`;
    return;
  }

  // Start on the current session's month; fall back to month grid
  const currentMonth = state.viewSessionData?.month;
  if (currentMonth && byMonth.has(currentMonth)) {
    renderGoToSessionsForMonth(student, currentMonth, byMonth.get(currentMonth), byMonth, today);
  } else {
    renderGoToMonthGrid(student, byMonth, today);
  }
}

function renderGoToMonthGrid(student, byMonth, today) {
  $("session-picker-title").textContent = student.name;
  let html = `<div class="month-grid">`;
  for (const month of byMonth.keys()) {
    const [name, year] = month.split(" ");
    html += `<button class="month-grid-btn" data-month="${escHtml(month)}">
      <span class="mgb-month">${escHtml(name.slice(0, 3))}</span>
      <span class="mgb-year">${escHtml(year)}</span>
    </button>`;
  }
  html += `</div>`;
  $("session-picker-list").innerHTML = html;
  $("session-picker-list").querySelectorAll(".month-grid-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const month = btn.dataset.month;
      renderGoToSessionsForMonth(student, month, byMonth.get(month), byMonth, today);
    });
  });
}

function renderGoToSessionsForMonth(student, month, monthSessions, byMonth, today) {
  $("session-picker-title").textContent = month;
  const sorted  = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  const display = [...sorted].reverse();
  let html = `<button class="btn-picker-back">← Back</button>`;
  html += renderSessionListRows(sorted, display, today, { isCurrentId: state.viewSessionId });
  const list = $("session-picker-list");
  list.innerHTML = html;
  list.querySelector(".btn-picker-back").addEventListener("click", () => {
    renderGoToMonthGrid(student, byMonth, today);
  });
  list.querySelectorAll(".session-list-item").forEach(item => {
    item.addEventListener("click", () => {
      const sid = item.dataset.sessionId;
      closeSessionPicker();
      if (sid !== state.viewSessionId) openSessionView(student, sid);
    });
  });
}

// Header "Go To Another Session" button on the live entry screen — same
// month-grid-then-list flow as the View screen's equivalent button, but
// jumps into live entry instead of View/Edit (openSession instead of
// openSessionView) when a session is picked.
async function showGoToAnotherSessionForEntry(student) {
  $("session-picker-title").textContent = student.name;
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading sessions…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentSessionsForStudent(student.id); } catch (err) { console.error("getRecentSessionsForStudent failed:", err); }

  const currentTargetNames = new Set((student.targets || []).map(t => t.name));
  const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
  const hasUsefulData = s => {
    if (Object.values(s.fedcComments || {}).some(c => stripEmpty(c).length > 0)) return true;
    return Object.values(s.remarks || {}).some(r => {
      const act = (s.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      const hasText   = stripEmpty(r.text).length > 0;
      const hasTrials = (r.trials      || []).some(t => t !== null && t !== -1);
      const hasNote   = stripEmpty(r.masteryNote).length > 0;
      return hasText || hasTrials || hasNote;
    });
  };
  // Don't auto-delete the session currently being edited
  const empties = sessions.filter(s => s.id !== state.currentSessionId && !hasUsefulData(s));
  empties.forEach(s => deleteSession(s.id).catch(() => {}));
  if (empties.length > 0) resequenceIndividualSessions(student.id).catch(() => {});
  sessions = sessions.filter(s => !empties.some(e => e.id === s.id));

  const today = getTodayString();
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  if (byMonth.size === 0) {
    $("session-picker-list").innerHTML = `<div class="session-picker-loading">No sessions found.</div>`;
    return;
  }

  const currentMonth = state.sessionData?.month;
  if (currentMonth && byMonth.has(currentMonth)) {
    renderGoToSessionsForMonthEntry(student, currentMonth, byMonth.get(currentMonth), byMonth, today);
  } else {
    renderGoToMonthGridEntry(student, byMonth, today);
  }
}

function renderGoToMonthGridEntry(student, byMonth, today) {
  $("session-picker-title").textContent = student.name;
  let html = `<div class="month-grid">`;
  for (const month of byMonth.keys()) {
    const [name, year] = month.split(" ");
    html += `<button class="month-grid-btn" data-month="${escHtml(month)}">
      <span class="mgb-month">${escHtml(name.slice(0, 3))}</span>
      <span class="mgb-year">${escHtml(year)}</span>
    </button>`;
  }
  html += `</div>`;
  $("session-picker-list").innerHTML = html;
  $("session-picker-list").querySelectorAll(".month-grid-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const month = btn.dataset.month;
      renderGoToSessionsForMonthEntry(student, month, byMonth.get(month), byMonth, today);
    });
  });
}

function renderGoToSessionsForMonthEntry(student, month, monthSessions, byMonth, today) {
  $("session-picker-title").textContent = month;
  const sorted  = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  const display = [...sorted].reverse();
  let html = `<button class="btn-picker-back">← Back</button>`;
  html += renderSessionListRows(sorted, display, today, { isCurrentId: state.currentSessionId });
  const list = $("session-picker-list");
  list.innerHTML = html;
  list.querySelector(".btn-picker-back").addEventListener("click", () => {
    renderGoToMonthGridEntry(student, byMonth, today);
  });
  list.querySelectorAll(".session-list-item").forEach(item => {
    item.addEventListener("click", () => {
      const sid = item.dataset.sessionId;
      closeSessionPicker();
      if (sid !== state.currentSessionId) openSession(student, sid);
    });
  });
}

// ─── CUSTOM DATE PICKER ───────────────────────────────────────
async function showEditDatePicker() {
  const student     = state.viewStudent;
  const currentDate = state.viewSessionData.date;

  $("session-picker-title").textContent = "Edit Date";
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentSessionsForStudent(student.id); } catch (err) { console.error("getRecentSessionsForStudent failed:", err); }
  // Dates already occupied by another session
  const takenDates = new Set(
    sessions.filter(s => s.id !== state.viewSessionId).map(s => s.date)
  );
  renderDatePickerCalendar(currentDate, takenDates, getTodayString(), currentDate);
}

function renderStartSessionCalendar(student, today, displayDate, takenDates = new Set()) {
  const [y, m] = displayDate.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1)
    .toLocaleString("default", { month: "long", year: "numeric" });
  const [ty, tm] = today.split("-").map(Number);
  const canNext = y < ty || (y === ty && m < tm);
  const pad = n => String(n).padStart(2, "0");
  const prevM = m === 1  ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  const firstDow  = new Date(y, m - 1, 1).getDay();
  const daysInMon = new Date(y, m, 0).getDate();

  let html = `<div class="date-picker-wrap">
    <p class="date-picker-legend"><span class="date-taken-dot">✓︎</span> Session exists on this day</p>
    <div class="date-picker-cal">
      <div class="date-picker-nav">
        <button class="btn-date-prev">‹</button>
        <span class="date-picker-month-label">${escHtml(monthLabel)}</span>
        <button class="btn-date-next"${canNext ? "" : " disabled"}>›</button>
      </div>
      <div class="date-picker-day-headers">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
        <span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="date-picker-grid">`;

  for (let cell = 0; cell < 42; cell++) {
    const d = cell - firstDow + 1;
    if (d < 1 || d > daysInMon) { html += `<span></span>`; continue; }
    const ds      = `${y}-${pad(m)}-${pad(d)}`;
    const isFut   = ds > today;
    const isTaken = takenDates.has(ds);
    let cls = "date-picker-day";
    if (isFut)   cls += " date-picker-day-future";
    if (isTaken) cls += " date-picker-day-taken";
    const dotCls = isTaken ? "date-taken-dot" : "day-dot-spacer";
    html += `<button class="${cls}" data-date="${ds}"${isFut ? " disabled" : ""}><span class="day-num">${d}</span><span class="${dotCls}">${isTaken ? "✓︎" : ""}</span></button>`;
  }
  html += `</div></div></div>`;

  $("session-picker-title").textContent = "Pick a date";
  $("session-picker-list").innerHTML = html;

  $("session-picker-list").querySelector(".btn-date-prev").addEventListener("click", () => {
    renderStartSessionCalendar(student, today, prevM, takenDates);
  });
  if (canNext) {
    $("session-picker-list").querySelector(".btn-date-next").addEventListener("click", () => {
      renderStartSessionCalendar(student, today, nextM, takenDates);
    });
  }
  $("session-picker-list").querySelectorAll(".date-picker-day:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      closeSessionPicker();
      openSession(student, null, btn.dataset.date);
    });
  });
}

function renderGroupStartSessionCalendar(group, today, displayDate, takenDates = new Set()) {
  const [y, m] = displayDate.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1)
    .toLocaleString("default", { month: "long", year: "numeric" });
  const [ty, tm] = today.split("-").map(Number);
  const canNext = y < ty || (y === ty && m < tm);
  const pad = n => String(n).padStart(2, "0");
  const prevM = m === 1  ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  const firstDow  = new Date(y, m - 1, 1).getDay();
  const daysInMon = new Date(y, m, 0).getDate();

  let html = `<div class="date-picker-wrap">
    <p class="date-picker-legend"><span class="date-taken-dot">✓︎</span> Session exists on this day</p>
    <div class="date-picker-cal">
      <div class="date-picker-nav">
        <button class="btn-date-prev">‹</button>
        <span class="date-picker-month-label">${escHtml(monthLabel)}</span>
        <button class="btn-date-next"${canNext ? "" : " disabled"}>›</button>
      </div>
      <div class="date-picker-day-headers">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
        <span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="date-picker-grid">`;

  for (let cell = 0; cell < 42; cell++) {
    const d = cell - firstDow + 1;
    if (d < 1 || d > daysInMon) { html += `<span></span>`; continue; }
    const ds      = `${y}-${pad(m)}-${pad(d)}`;
    const isFut   = ds > today;
    const isTaken = takenDates.has(ds);
    let cls = "date-picker-day";
    if (isFut)   cls += " date-picker-day-future";
    if (isTaken) cls += " date-picker-day-taken";
    const dotCls = isTaken ? "date-taken-dot" : "day-dot-spacer";
    html += `<button class="${cls}" data-date="${ds}"${isFut ? " disabled" : ""}><span class="day-num">${d}</span><span class="${dotCls}">${isTaken ? "✓︎" : ""}</span></button>`;
  }
  html += `</div></div></div>`;

  $("session-picker-title").textContent = "Pick a date";
  $("session-picker-list").innerHTML = html;

  $("session-picker-list").querySelector(".btn-date-prev").addEventListener("click", () => {
    renderGroupStartSessionCalendar(group, today, prevM, takenDates);
  });
  if (canNext) {
    $("session-picker-list").querySelector(".btn-date-next").addEventListener("click", () => {
      renderGroupStartSessionCalendar(group, today, nextM, takenDates);
    });
  }
  $("session-picker-list").querySelectorAll(".date-picker-day:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      closeSessionPicker();
      openGroupSession(group, btn.dataset.date, group.students);
    });
  });
}

function renderDatePickerCalendar(displayDate, takenDates, today, currentDate) {
  const [y, m] = displayDate.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1)
    .toLocaleString("default", { month: "long", year: "numeric" });
  const [ty, tm] = today.split("-").map(Number);
  const canNext = y < ty || (y === ty && m < tm);

  const pad = n => String(n).padStart(2, "0");
  const prevM = m === 1  ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;

  const firstDow  = new Date(y, m - 1, 1).getDay();
  const daysInMon = new Date(y, m, 0).getDate();

  let html = `<div class="date-picker-wrap">
    <p class="date-picker-subtitle">Select a new date</p>
    <p class="date-picker-legend"><span class="date-taken-dot">✓︎</span> Session exists on this day</p>
    <div class="date-picker-cal">
      <div class="date-picker-nav">
        <button class="btn-date-prev">‹</button>
        <span class="date-picker-month-label">${escHtml(monthLabel)}</span>
        <button class="btn-date-next"${canNext ? "" : " disabled"}>›</button>
      </div>
      <div class="date-picker-day-headers">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
        <span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="date-picker-grid">`;

  // Always render 42 cells (6 rows) so height never changes between months
  for (let cell = 0; cell < 42; cell++) {
    const d = cell - firstDow + 1;
    if (d < 1 || d > daysInMon) { html += `<span></span>`; continue; }
    const ds     = `${y}-${pad(m)}-${pad(d)}`;
    const isCur  = ds === currentDate;
    const isFut  = ds > today;
    const isTaken = takenDates.has(ds);
    const dis    = isFut || isTaken;
    let cls = "date-picker-day";
    if (isCur)   cls += " date-picker-day-current";
    if (isFut)   cls += " date-picker-day-future";
    if (isTaken) cls += " date-picker-day-taken";
    const dotCls = isTaken ? "date-taken-dot" : "day-dot-spacer";
    html += `<button class="${cls}" data-date="${ds}"${dis ? " disabled" : ""}><span class="day-num">${d}</span><span class="${dotCls}">${isTaken ? "✓︎" : ""}</span></button>`;
  }
  html += `</div></div></div>`;

  $("session-picker-title").textContent = "Edit Date";
  $("session-picker-list").innerHTML = html;

  $("session-picker-list").querySelector(".btn-date-prev").addEventListener("click", () => {
    renderDatePickerCalendar(prevM, takenDates, today, currentDate);
  });
  if (canNext) {
    $("session-picker-list").querySelector(".btn-date-next").addEventListener("click", () => {
      renderDatePickerCalendar(nextM, takenDates, today, currentDate);
    });
  }
  $("session-picker-list").querySelectorAll(".date-picker-day:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      const newDate = btn.dataset.date;
      closeSessionPicker();
      if (newDate === currentDate) return;
      try {
        await updateSessionDate(state.viewSessionId, newDate, state.viewStudent.id);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// ============================================================
// SESSION SCREEN
// ============================================================

function getEffectiveTargets() {
  return state.currentStudent?.targets || [];
}

async function openSession(student, existingSessionId = null, dateStr = null) {
  // Jumping to another date for the SAME student via "Go To Another
  // Session" should land back on whatever target they were already
  // looking at, not silently reset to the first target in the list —
  // only a genuine student switch starts fresh.
  const preservedTargetName = state.currentStudent?.id === student.id ? state.selectedTargetName : null;
  state.currentStudent     = student;
  state.selectedTargetName = null;
  state.sessionData        = null;
  state.pendingNewActivity = null;
  state.pendingNewRemark   = null;
  state.renderPending      = false;

  showScreen("screen-session");
  $("session-student-name").textContent = student.name;
  $("session-meta").textContent = "";
  $("target-content").innerHTML = `<div class="loading">Loading…</div>`;
  $("target-select").innerHTML  = `<option value="">— loading —</option>`;
  $("btn-manage-targets")?.classList.add("hidden");
  $("target-type-chip")?.classList.add("hidden");

  const gotoEntryBtn = $("btn-entry-goto-session");
  if (gotoEntryBtn) {
    gotoEntryBtn.classList.remove("hidden");
    gotoEntryBtn.onclick = () => showGoToAnotherSessionForEntry(student);
  }

  if (state.fbUnsubscribe) { state.fbUnsubscribe(); state.fbUnsubscribe = null; }
  state.entryRemarkSaver?.cleanup();
  state.entryRemarkSaver = setupEntryRemarkSaving($("target-content"), () => state.currentSessionId, () => {
    if (!state.renderPending || state.entryActionsInFlight > 0) return;
    state.renderPending = false;
    renderTargetContent();
  });
  state.entryEnterKeyCleanup?.();
  state.entryEnterKeyCleanup = setupEntryEnterKeyDelegation($("target-content"),
    () => getEffectiveTargets().find(t => t.name === state.selectedTargetName));

  try {
    const sessionId = existingSessionId
      ? existingSessionId
      : await getOrCreateSessionForDate(student.id, dateStr || getTodayString(), student.targets);
    state.currentSessionId = sessionId;

    state.fbUnsubscribe = listenToSession(sessionId, async data => {
      const firstLoad = state.sessionData === null;
      state.sessionData = data;
      if (firstLoad) {
        const eff = getEffectiveTargets();
        state.selectedTargetName = (preservedTargetName && eff.some(t => t.name === preservedTargetName))
          ? preservedTargetName
          : (eff[0]?.name || null);
        populateTargetDropdown(eff);
        // Auto-create an empty remark for "pick from options" activities
        // (Select one / Tick boxes / Sentence Starter + either, or + Select
        // One + Free Text) so the boss can start picking immediately
        // instead of clicking "+ Add Remark & Trials" first. Free text and
        // Sentence Starter + Free Text stay collapsed — there's nothing to
        // pre-open for those. If any are created the Firestore write
        // triggers another snapshot which will render — so we return early
        // here to avoid a stale render. Wrapped in try/catch: an uncaught
        // error here (e.g. malformed target config) would otherwise leave
        // the screen stuck on "Loading…" forever, since nothing below this
        // line would ever run.
        try {
          const structuredFilled = await autoFillStructuredRemarks(student, sessionId);
          if (structuredFilled > 0) return;
        } catch (err) { console.error("autoFillStructuredRemarks failed:", err); }
      }
      // Mapped-score activities can become fillable any time during the
      // session (not just on open), so this check isn't gated to firstLoad.
      try {
        const mappedFilled = await autoFillMappedRemarks(student, sessionId);
        if (mappedFilled > 0) return;
      } catch (err) { console.error("autoFillMappedRemarks failed:", err); }
      // Keep score modal trial badges in sync with Firestore
      if (state.scorePicker?.open && state.scorePicker?.remId) {
        renderScoreModalTrials(state.scorePicker.remId);
      }
      // Busy = dropdown open, or a button's own multi-step Firestore write
      // still in flight. Typing/focus itself never needs to defer a render —
      // captureActiveEditState/restoreActiveEditState (see renderTargetContent)
      // protect an in-progress edit through any render regardless of timing,
      // so gating on "is a box focused" here would only ever add delay, never
      // safety — including deferring forever while the user keeps typing
      // (which is exactly what made "+Add Remark & Trials" look like it
      // wasn't registering when clicked soon after typing elsewhere).
      const isEntryBusy = () => document.activeElement === $("target-select")
        || state.entryActionsInFlight > 0;
      if (isEntryBusy()) {
        state.renderPending = true;
      } else {
        // Re-check at fire time, not just now — an action button can be
        // mousedown'd (and thus guarded via entryActionsInFlight, see its
        // "mousedown" listener) in the gap between scheduling and running
        // this timeout, and rendering would destroy that button before its
        // own "click" fires, silently swallowing the click.
        setTimeout(() => {
          if (isEntryBusy()) { state.renderPending = true; }
          else { renderTargetContent(); }
        }, 0);
      }
    });

  } catch (err) {
    $("target-content").innerHTML =
      `<div class="error-msg">Could not load session.<br>${escHtml(err.message)}</div>`;
  }
}

async function leaveSession() {
  commitTextEditorSheet();
  $("text-editor-sheet").classList.add("hidden");
  // Flush any not-yet-saved typing while the Firestore listener is still
  // live, so state.sessionData reflects it before we decide what's "empty".
  await state.entryRemarkSaver?.flush();
  state.entryRemarkSaver?.cleanup();
  state.entryRemarkSaver = null;
  state.entryEnterKeyCleanup?.();
  state.entryEnterKeyCleanup = null;
  if (state.fbUnsubscribe) { state.fbUnsubscribe(); state.fbUnsubscribe = null; }
  const sessionId = state.currentSessionId;
  const data      = state.sessionData;
  const student   = state.currentStudent;
  state.currentSessionId   = null;
  state.sessionData        = null;
  state.currentStudent     = null;
  state.pendingNewActivity = null;
  state.pendingNewRemark   = null;
  state.renderPending      = false;

  if (sessionId && data) {
    const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
    const currentTargetNames = new Set((student?.targets || []).map(t => t.name));
    const fedcHasData = Object.values(data.fedcComments || {}).some(c => stripEmpty(c).length > 0);
    const remarkHasData = Object.values(data.remarks || {}).some(r => {
      const act = (data.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      return stripEmpty(r.text).length > 0
        || (r.trials || []).some(t => t !== null && t !== -1)
        || stripEmpty(r.masteryNote).length > 0;
    });
    if (!fedcHasData && !remarkHasData) {
      deleteEmptyIndividualSession(sessionId, student.id, data.date).catch(() => {});
    } else {
      const allTargetNames = new Set(Object.values(data.activities || {}).map(a => a.targetName));
      allTargetNames.forEach(name => {
        const target = (student?.targets || []).find(t => t.name === name);
        cleanupEmptyEntries(sessionId, data, name, target).catch(() => {});
      });
    }
  }

  showHome();
}

function updateSessionHeader() {
  const d = state.sessionData;
  if (!d) return;
  // sessionNumber is this student's lifetime individual-session count (see
  // getIndividualSessionsForStudent — independent of their group session
  // count) — no longer scoped to "this month", so it's shown plainly
  // rather than as "X of [Month]".
  $("session-meta").textContent =
    `Session ${d.sessionNumber} · ${formatDate(d.date)}`;
}


// Shared by individual + group target dropdowns, the Manage Targets reorder
// list, and the Word/Excel exports — keeps display order consistent with
// whatever the boss last dragged it to, falling back to alphabetical for
// any target predating the order field.
function sortTargetsByOrder(targets) {
  return [...targets].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

function populateTargetDropdown(targets) {
  const sel = $("target-select");
  const sorted = sortTargetsByOrder(targets);
  const placeholder = sorted.length === 0
    ? `<option value="" disabled selected>— no targets yet —</option>` : "";
  sel.innerHTML = placeholder +
    sorted.map(t =>
      `<option value="${escHtml(t.name)}">${escHtml(t.name)}</option>`
    ).join("") + `<option value="__add_target__">+ Add Target…</option>`;

  sel.value = state.selectedTargetName || sorted[0]?.name || "";

  const reorderBtn = $("btn-reorder-targets");
  if (reorderBtn) {
    reorderBtn.classList.toggle("hidden", targets.length < 2);
    reorderBtn.onclick = () => showTargetReorderList(state.currentStudent);
  }

  sel.onchange = async () => {
    if (sel.value === "__add_target__") {
      sel.value = state.selectedTargetName || sorted[0]?.name || "";
      showAddTargetPicker(state.currentStudent);
      return;
    }
    const prevTarget = state.selectedTargetName;
    // Flush any not-yet-saved typing on the target we're leaving before the
    // cleanup below decides what's "empty" — otherwise a just-typed remark
    // can lose the race against the still-stale local session data and get
    // deleted as if it were never entered.
    await state.entryRemarkSaver?.flush();
    state.selectedTargetName = sel.value;
    state.pendingNewActivity = null;
    state.pendingNewRemark   = null;
    // Clean up empty entries from the previous target (fire-and-forget)
    if (prevTarget && prevTarget !== sel.value) {
      const prevTargetObj = (state.currentStudent?.targets || []).find(t => t.name === prevTarget);
      cleanupEmptyEntries(state.currentSessionId, state.sessionData, prevTarget, prevTargetObj).catch(() => {});
    }
    // A <select> keeps focus after its own change event fires, and the
    // busy-check in openSession's listener treats "the dropdown is focused"
    // as "still choosing" — so leaving it focused here would block every
    // future render until the user happens to click elsewhere.
    sel.blur();
    // Also run auto-fills on target switch: the Firestore snapshot listener
    // only fires when session data changes, but switching targets alone doesn't
    // cause a write, so newly-added structured/mapped activities would otherwise
    // never auto-fill until a write happened.
    (async () => {
      try {
        if (await autoFillStructuredRemarks(state.currentStudent, state.currentSessionId) > 0) return;
        if (await autoFillMappedRemarks(state.currentStudent, state.currentSessionId) > 0) return;
        renderTargetContent();
      } catch { renderTargetContent(); }
    })();
  };
}

$("btn-back").addEventListener("click", leaveSession);

// ============================================================
// TARGET CONTENT RENDERING
// ============================================================

// Resolves a mapped-score activity's live display: the label naming its
// mapped target, and that target's current day average (null if unmapped,
// the mapped target was deleted, or it has no data yet today).
function resolveMappedScoreDisplay(pa, visited) {
  const mappedTarget = pa.mappedTargetId
    ? getEffectiveTargets().find(t => t.id === pa.mappedTargetId)
    : null;
  if (!mappedTarget) return { label: "Score (Not Mapped Yet)", pct: null };
  return {
    label: `Score (Mapped to ${mappedTarget.name}'s Average)`,
    pct: calcDaysAverage(mappedTarget, visited)
  };
}

// visited guards against a circular mapping chain (A maps to B, B maps back
// to A) recursing forever — direct self-mapping is already blocked in the
// Edit Target picker, but this is a defensive backstop, not the primary guard.
// One percentage per remark/activity, averaged equally — same method as
// calcViewDayAvg (View screen) and export.js's calcDailyAverage, so the live
// entry screen's day average always agrees with the View screen and every
// export instead of pooling raw trial points (which let activities with more
// trials outweigh ones with fewer, purely from incidental trial-count
// differences rather than how well each activity actually went).
function calcDaysAverage(target, visited = new Set()) {
  if (visited.has(target.id)) return null;
  visited.add(target.id);

  const avgs = [];
  const maxPts = target.maxPoints || 3;
  for (const act of getActivitiesForTarget(target.name)) {
    const pa = (target.predefinedActivities || []).find(p => p.isMapped && p.name === act.activityName);
    if (pa) {
      if (getRemarksForActivity(act.id).length === 0) continue;
      const mappedPct = resolveMappedScoreDisplay(pa, visited).pct;
      if (mappedPct !== null) avgs.push(mappedPct);
      continue;
    }
    for (const rem of getRemarksForActivity(act.id)) {
      const trials = (rem.trials || []).filter(t => t !== -1);
      if (trials.length === 0) continue;
      avgs.push(trials.reduce((a, b) => a + b, 0) / (trials.length * maxPts) * 100);
    }
  }
  return avgs.length > 0 ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null;
}

function renderTargetContent() {
  if (!state.sessionData) return;
  updateSessionHeader();
  if (!state.selectedTargetName) {
    const mb = $("btn-manage-targets");
    if (mb) mb.classList.add("hidden");
    $("target-type-chip")?.classList.add("hidden");
    $("target-content").innerHTML =
      `<p class="empty-hint" contenteditable="false" style="padding:2rem;text-align:center">
        No targets added yet. Use the dropdown above to add one.
      </p>`;
    return;
  }
  const target = getEffectiveTargets().find(t => t.name === state.selectedTargetName);
  const manageBtn = $("btn-manage-targets");
  if (!target) {
    if (manageBtn) manageBtn.classList.add("hidden");
    $("target-type-chip")?.classList.add("hidden");
    return;
  }

  if (manageBtn) {
    manageBtn.classList.toggle("hidden", target.isStructured !== true);
  }

  $("target-type-chip")?.classList.add("hidden");

  const avg = calcDaysAverage(target);
  const avgEl = $("days-average-value");
  if (avgEl) avgEl.textContent = avg !== null ? avg + "%" : "—";

  const container = $("target-content");
  // Replacing innerHTML resets the scrolling ancestor's scrollTop to 0 in
  // every browser — capture/restore around the swap so clicking a button
  // (which has no cursor position for captureActiveEditState to preserve)
  // doesn't yank the page back to the top.
  const scrollHost = container.closest(".session-body");
  const scrollTop  = scrollHost?.scrollTop;
  const captured = captureActiveEditState(container);
  container.innerHTML = target.predefinedActivities?.length > 0
    ? renderFedcTarget(target)
    : renderRegularTarget(target);

  attachTargetListeners(target);
  restoreActiveEditState(container, captured);
  if (scrollHost) scrollHost.scrollTop = scrollTop;
}

// ─── FEDC TARGET ─────────────────────────────────────────────

function renderFedcTarget(target) {
  let html = "";

  const letters = "abcdefghij";
  let lastGroup = null;
  const allPas = target.predefinedActivities || [];
  const firstMnIdx = allPas.findIndex(pa => pa.isMaintain);
  // Headings that appear at or after the first maintain item belong in the maintain section
  const maintainSectionIdxs = new Set(
    allPas.reduce((acc, pa, i) => {
      if (pa.isMaintainHeading) { acc.push(i); return acc; }
      if (firstMnIdx !== -1 && i >= firstMnIdx && (pa.isMaintain || pa.isHeading)) acc.push(i);
      return acc;
    }, [])
  );
  allPas.forEach((pa, idx) => {
    // Headings/maintains in the maintain section are rendered below
    if (maintainSectionIdxs.has(idx)) return;

    // Note item — render inline in order, styled like a section heading
    if (pa.isNote) {
      if (pa.text) html += `<div class="activity-note-heading" contenteditable="false">${noteToHtml(pa.text)}</div>`;
      return;
    }

    // New format: explicit heading row
    if (pa.isHeading) {
      html += `<div class="activity-group-heading" contenteditable="false">${escHtml(pa.name)}</div>`;
      return;
    }

    if (pa.isCompleted || pa.isArchived || pa.isStopped || pa.isMaintain) return;

    // Old format: group field per activity (backward compat)
    if (pa.group && pa.group !== lastGroup) {
      lastGroup = pa.group;
      html += `<div class="activity-group-heading" contenteditable="false">${escHtml(pa.group)}</div>`;
    } else if (!pa.group) {
      lastGroup = null;
    }

    const pendingKey = pa.name;
    const actData    = findActivityByName(target.name, pa.name);
    const actId      = actData ? actData.id : null;
    const remarks    = actId ? getRemarksForActivity(actId) : [];
    const isPending  = state.pendingNewRemark?.pendingKey === pendingKey;
    const mappedInfo = pa.isMapped ? resolveMappedScoreDisplay(pa) : null;

    html += `<div class="entry-block entry-block-predefined"${pa.isMaintainLive ? ' style="background:#f3f4f6;border:1px solid #e5e7eb;border-left:4px solid #d1d5db"' : ''}>
      <div class="entry-field" contenteditable="false">
        <span class="field-label">Activity</span>
        <span class="field-value-fixed">${formatActivityMarkup(pa.name)}</span>
      </div>`;

    if (pa.actNote && pa.actNote.trim()) {
      html += `<div class="entry-field" contenteditable="false">
        <span class="field-label">Note</span>
        <span class="field-value-note">${formatActivityMarkup(pa.actNote)}</span>
      </div>`;
    }

    // Reference notes (a, b, c… sub-items)
    if (pa.note && pa.note.length > 0) {
      const noteHtml = pa.note.map((line, i) =>
        `${letters[i]}) ${escHtml(line)}`
      ).join("<br>");
      html += `<div class="activity-note" contenteditable="false">${noteHtml}</div>`;
    }

    if (pa.predefinedRemarks) {
      for (const predRemName of pa.predefinedRemarks) {
        const rem = actId ? findRemarkByPredefinedKey(actId, predRemName) : null;
        if (rem) {
          html += renderPredefinedRemarkFields(rem, predRemName, target);
        } else {
          html += renderGhostRemarkFields(predRemName, actId, pa, idx, target);
        }
      }
    } else {
      for (const rem of remarks) {
        html += renderRemarkFields(rem, target, getActivityInlineOptions(pa), pa.sentenceStarter || null, pa.optionsMulti || false, mappedInfo, pa.remarkHasNote || false);
      }
      if (isPending) {
        html += renderPendingRemarkFields(pendingKey, actId, pa.name, idx, target);
      } else {
        html += `<button class="btn-add-remark" contenteditable="false"
          data-pending-key="${escHtml(pendingKey)}"
          data-act-id="${actId || ""}"
          data-pa-name="${escHtml(pa.name)}"
          data-pa-order="${idx}"
          data-is-mapped="${pa.isMapped ? "1" : ""}"
          data-target="${escHtml(target.name)}">+ Add Remark${pa.isMapped ? "" : " &amp; Trials"}</button>`;
      }
    }

    html += `</div>`;
  });

  // ── Maintain section ────────────────────────────────────────────────────────
  if (firstMnIdx !== -1) {
    const mnItems = allPas.filter((pa, i) => maintainSectionIdxs.has(i));
    if (mnItems.some(pa => pa.isMaintain)) {
      for (const pa of mnItems) {
        if (pa.isHeading || pa.isMaintainHeading) {
          html += `<div class="activity-group-heading" contenteditable="false" style="background:#d1d5db;border-color:#9ca3af;color:#374151">${escHtml(pa.name || "")}</div>`;
        } else if (pa.isMaintain && pa.name) {
          html += `<div class="entry-block entry-block-predefined" style="background:#f3f4f6;border:1px solid #e5e7eb;border-left:4px solid #d1d5db">
            <div class="entry-field" contenteditable="false">
              <span class="field-label">Activity</span>
              <span class="field-value-fixed">${formatActivityMarkup(pa.name)}</span>
            </div>
            <div class="entry-field" contenteditable="false">
              <span class="field-label">Remark</span>
              <span class="field-value-fixed" style="white-space:pre-wrap;color:#111827">${escHtml(pa.maintainRemark || "")}</span>
            </div>
          </div>`;
        }
      }
    }
  }

  // One-off activities added just for this session (white, same as free-form)
  const manualActivities = getActivitiesForTarget(target.name).filter(a => !a.isPredefined);
  for (const act of manualActivities) {
    const pendingKey = act.id;
    const isPending  = state.pendingNewRemark?.pendingKey === pendingKey;
    const remarks    = getRemarksForActivity(act.id);

    html += `<div class="entry-block" data-act-id="${act.id}">
      <div class="entry-field">
        <span class="field-label" contenteditable="false">Activity</span>
        <input type="text" class="field-input activity-name-input"
          data-act-id="${act.id}"
          data-original="${escHtml(act.activityName)}"
          data-saved-html="${escHtml(act.activityName)}" value="${escHtml(act.activityName)}" />
        <button class="btn-icon btn-delete-activity" contenteditable="false"
          data-act-id="${act.id}" title="Delete activity">🗑</button>
      </div>`;

    for (const rem of remarks) {
      html += renderRemarkFields(rem, target);
    }
    if (isPending) {
      html += renderPendingRemarkFields(pendingKey, act.id, null, null, target);
    } else {
      html += `<button class="btn-add-remark" contenteditable="false"
        data-pending-key="${escHtml(pendingKey)}"
        data-act-id="${act.id}"
        data-target="${escHtml(target.name)}">+ Add Remark &amp; Trials</button>`;
    }
    html += `</div>`;
  }

  // Pending new one-off activity
  if (state.pendingNewActivity?.targetName === target.name) {
    html += `<div class="entry-block">
      <div class="entry-field">
        <span class="field-label" contenteditable="false">Activity</span>
        <input type="text" id="new-activity-textarea" class="field-input"
          placeholder="Type activity name… (Ctrl+Enter to save)" />
        <button class="btn-icon btn-cancel-new-activity" contenteditable="false" title="Cancel">✕</button>
      </div>
    </div>`;
  }

  html += `<button class="btn-add-activity" contenteditable="false" data-target="${escHtml(target.name)}">+ Add Activity (This activity only appears in this session)</button>`;

  return html;
}

// ─── REGULAR TARGET ──────────────────────────────────────────

function renderRegularTarget(target) {
  const activities = getActivitiesForTarget(target.name);
  let html = "";

  if (target.notes?.length > 0) {
    html += `<div class="target-notes" contenteditable="false">`;
    for (const n of target.notes) {
      if (n.text) html += `<div class="target-note-item">📌 ${escHtml(n.text)}</div>`;
    }
    html += `</div>`;
  }

  for (const act of activities) {
    const pendingKey = act.id;
    const isPending  = state.pendingNewRemark?.pendingKey === pendingKey;
    const remarks    = getRemarksForActivity(act.id);

    html += `<div class="entry-block" data-act-id="${act.id}">
      <div class="entry-field">
        <span class="field-label" contenteditable="false">Activity</span>
        <input type="text" class="field-input activity-name-input"
          data-act-id="${act.id}"
          data-original="${escHtml(act.activityName)}"
          data-saved-html="${escHtml(act.activityName)}" value="${escHtml(act.activityName)}" />
        <button class="btn-icon btn-delete-activity" contenteditable="false"
          data-act-id="${act.id}" title="Delete activity">🗑</button>
      </div>`;

    for (const rem of remarks) {
      html += renderRemarkFields(rem, target);
    }

    if (isPending) {
      html += renderPendingRemarkFields(pendingKey, act.id, null, null, target);
    } else {
      html += `<button class="btn-add-remark" contenteditable="false"
        data-pending-key="${escHtml(pendingKey)}"
        data-act-id="${act.id}"
        data-target="${escHtml(target.name)}">+ Add Remark &amp; Trials</button>`;
    }

    html += `</div>`;
  }

  // Pending new activity block
  if (state.pendingNewActivity?.targetName === target.name) {
    html += `<div class="entry-block">
      <div class="entry-field">
        <span class="field-label" contenteditable="false">Activity</span>
        <input type="text" id="new-activity-textarea" class="field-input"
          placeholder="Type activity name… (Ctrl+Enter to save)" />
        <button class="btn-icon btn-cancel-new-activity" contenteditable="false" title="Cancel">✕</button>
      </div>
    </div>`;
  }

  html += `<button class="btn-add-activity" contenteditable="false" data-target="${escHtml(target.name)}">+ Add Activity (This activity only appears in this session)</button>`;

  return html;
}

// Returns the inline options string for an activity (new inlineOptions field,
// falling back to old remarkPresetId preset for backward compat).
function getActivityInlineOptions(a) {
  if (a.inlineOptions) return a.inlineOptions;
  if (a.remarkPresetId) {
    const preset = state.remarkPresets.find(p => p.id === a.remarkPresetId);
    if (preset?.options?.length) return preset.options.join("/");
  }
  return null;
}

function parseOpts(str) {
  return (str || "").split("/").map(s => s.trim()).filter(Boolean);
}

// Converts stored remark text (plain or legacy **bold**) to HTML for contenteditable display
function remarkToHtml(text) {
  if (!text) return "";
  return text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

// Session-entry remark/note boxes are real <textarea>/<input> elements (not
// contenteditable) so Grammarly, Enter, backspace and Ctrl+A all behave
// natively per-field. Stored text can still contain legacy HTML markup
// (literal "<br>" from the old contenteditable boxes, "<b>" from
// remarkToHtml) — these two functions round-trip between that stored format
// and the plain text a textarea's .value can actually hold.
function plainTextForEdit(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?b>/gi, "**")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}
function htmlForStorage(text) {
  return escHtml(text || "").replace(/\n/g, "<br>");
}

// Read-only display of activity name/note text that may contain
// *bold*/_underline_ markers (typed via wrapTextareaSelection below) —
// escapes the raw text first so it can't inject arbitrary HTML, then turns
// the markers into real tags.
function formatActivityMarkup(text) {
  return escHtml(text || "")
    .replace(/\*(.+?)\*/g, "<b>$1</b>")
    .replace(/_(.+?)_/g, "<u>$1</u>");
}

// A "word" for cursor-with-no-selection formatting — letters/digits/'/- so
// "Self-Regulation" or "don't" count as one word, but stops at punctuation
// like ":" or "(" so parenthesised text doesn't get swept in.
function wordBoundsAt(value, pos) {
  const isWordChar = c => /[A-Za-z0-9'-]/.test(c);
  let start = pos, end = pos;
  while (start > 0 && isWordChar(value[start - 1])) start--;
  while (end < value.length && isWordChar(value[end])) end++;
  return { start, end };
}

// Finds a marker...marker pair anywhere in the text whose span (including
// the markers themselves) overlaps [selStart, selEnd] — covers all 3 ways a
// boss might re-select already-formatted text: just the inner words, the
// whole "**text**" including the markers, or just a bare cursor resting
// somewhere inside it.
function findMarkerSpan(value, selStart, selEnd, marker) {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(esc + "(.+?)" + esc, "g");
  let m;
  while ((m = re.exec(value)) !== null) {
    const mStart = m.index, mEnd = m.index + m[0].length;
    if (mStart <= selEnd && mEnd >= selStart) return { start: mStart, end: mEnd, inner: m[1] };
  }
  return null;
}

// Formats the current selection in a plain <textarea>/<input> with a marker
// (* for bold, _ for underline) without going through the contenteditable
// sketch popup — Activity Name/Notes are the only fields that use this; a
// plain textarea can't render the result as real bold/underline inline, but
// this avoids the popup entirely, which is what the boss asked for.
//
// Same toggle behaviour as a word processor's Ctrl+B: if the cursor/selection
// overlaps an existing marker pair *in any way* (see findMarkerSpan above),
// that pair is removed — it can never stack into "**text**" no matter
// how it's re-selected. Otherwise, a bare cursor (no selection) expands to
// the whole word under it before wrapping, instead of dropping markers with
// nothing between them. Caller is responsible for keeping the field focused
// (see the mousedown handlers on the format buttons) so the selection
// survives long enough to read it.
function wrapTextareaSelection(el, marker) {
  const value = el.value;
  const mLen = marker.length;
  let start = el.selectionStart, end = el.selectionEnd;

  const existing = findMarkerSpan(value, start, end, marker);
  if (existing) {
    el.value = value.slice(0, existing.start) + existing.inner + value.slice(existing.end);
    el.setSelectionRange(existing.start, existing.start + existing.inner.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (start === end) {
    const word = wordBoundsAt(value, start);
    if (word.end === word.start) return; // no word under the cursor — nothing to format
    start = word.start; end = word.end;
  }

  const before = value.slice(0, start);
  const selected = value.slice(start, end);
  const after = value.slice(end);
  el.value = before + marker + selected + marker + after;
  el.setSelectionRange(start + mLen, end + mLen);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// Small "B"/"U"/"•" buttons next to an Activity Name/Notes field — same wrap
// action as Ctrl+B/Ctrl+U/Ctrl+Shift+L, for anyone who doesn't know/use the shortcut.
function formatButtonsHtml(inputId) {
  return `<span class="fmt-btn-group">
    <button class="btn-fmt btn-fmt-bold" type="button" data-input-id="${inputId}" title="Bold (Ctrl+B)">B</button>
    <button class="btn-fmt btn-fmt-underline" type="button" data-input-id="${inputId}" title="Underline (Ctrl+U)">U</button>
    <button class="btn-fmt btn-fmt-bullet" type="button" data-input-id="${inputId}" title="Bullet point (Ctrl+Shift+L)">•</button>
  </span>`;
}

// Finds the start/end of the line containing `pos` in a plain textarea value.
function lineBoundsAt(value, pos) {
  const start = value.lastIndexOf("\n", pos - 1) + 1;
  let end = value.indexOf("\n", pos);
  if (end === -1) end = value.length;
  return { start, end };
}

// A line "has a bullet" if it starts with the • marker (whatever indentation
// precedes it) — checked with a plain regex, not a hidden flag, so a bullet
// typed by hand (bypassing the button entirely) is still recognized and can
// still be toggled off, same as the bold/underline markers.
function isBulletLine(line) {
  return /^\s*•\s?/.test(line);
}
function addBulletMarker(line) {
  return isBulletLine(line) ? line : "• " + line.replace(/^\s+/, "");
}
function stripBulletMarker(line) {
  return line.replace(/^(\s*)•\s?/, "$1");
}

// Toggle bullet points on the line(s) touched by the current selection in a
// plain <textarea> — same "format like Word" intent as wrapTextareaSelection,
// but bullets are a per-line prefix rather than a paired inline marker, so
// the logic works on whole lines instead of an arbitrary text span:
// - A highlighted range only needs to touch part of a line to affect the
//   whole line (selecting one character is enough), matching how Word's
//   bullet button always applies to the full paragraph(s) touched.
// - Re-toggling never accumulates: every line's bullet state is read fresh
//   from the text itself (via isBulletLine) each time, never assumed, so
//   clicking twice always returns to the original state.
// - A mixed selection (some lines already bulleted, some not) always adds
//   bullets to every line, matching Word's behaviour for a mixed selection.
// - Blank lines inside a multi-line selection are left alone (they're used
//   as readability separators between rubric sections, not list items) —
//   but a bare cursor resting on a single blank line starts a fresh bullet
//   right there, same as clicking the bullet button on an empty paragraph.
function toggleBulletSelection(el) {
  const value = el.value;
  const selStart = el.selectionStart, selEnd = el.selectionEnd;

  if (selStart === selEnd) {
    const { start, end } = lineBoundsAt(value, selStart);
    if (value.slice(start, end).trim() === "") {
      el.value = value.slice(0, start) + "• " + value.slice(end);
      el.setSelectionRange(start + 2, start + 2);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
  }

  const blockStart = lineBoundsAt(value, selStart).start;
  const blockEnd = lineBoundsAt(value, Math.max(selEnd - 1, selStart)).end;
  const lines = value.slice(blockStart, blockEnd).split("\n");

  const nonBlank = lines.filter(ln => ln.trim() !== "");
  const shouldAdd = nonBlank.length === 0 || !nonBlank.every(isBulletLine);

  const newLines = lines.map(ln => {
    if (ln.trim() === "") return ln;
    return shouldAdd ? addBulletMarker(ln) : stripBulletMarker(ln);
  });

  const newBlock = newLines.join("\n");
  el.value = value.slice(0, blockStart) + newBlock + value.slice(blockEnd);
  el.setSelectionRange(blockStart, blockStart + newBlock.length);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ─── REMARK FIELDS ───────────────────────────────────────────

function renderRemarkFields(rem, target, inlineOptions = null, sentenceStarter = null, multiSelect = false, mappedInfo = null, remarkHasNote = false) {
  const opts = parseOpts(inlineOptions);

  const trials = rem.trials || [];
  const badgesHtml = trials.map((score, idx) =>
    `<span class="trial-badge">${score === -1 ? "—" : score}<button class="btn-trial-delete"
      data-rem-id="${rem.id}" data-idx="${idx}">×</button></span>`
  ).join("");

  const trailingField = mappedInfo
    ? `<div class="entry-field" contenteditable="false">
        <span class="field-label">${escHtml(mappedInfo.label)}</span>
        <span class="field-value-fixed">${mappedInfo.pct !== null ? mappedInfo.pct + "%" : "—"}</span>
      </div>`
    : `<div class="entry-field" contenteditable="false">
        <span class="field-label">Trials</span>
        <div class="trials-row">
          <div class="trials-badges">${badgesHtml}</div>
          <button class="btn-add-trial btn-primary-sm"
            data-rem-id="${rem.id}"
            data-target="${escHtml(target.name)}">+ Trial</button>
        </div>
      </div>`;

  function makeOptPills(remId, remText) {
    if (opts.length === 0) return null;
    if (multiSelect) {
      const sel = (remText || "").split(", ").map(s => s.trim()).filter(Boolean);
      return `<div class="remark-preset-opts remark-preset-opts-multi" contenteditable="false">${opts.map(opt =>
        `<button class="btn-remark-opt${sel.includes(opt) ? " active" : ""}"
          data-rem-id="${remId}" data-opt="${escHtml(opt)}">${escHtml(opt)}</button>`
      ).join("")}</div>`;
    }
    return `<div class="remark-preset-opts" contenteditable="false">${opts.map(opt =>
      `<button class="btn-remark-opt${remText === opt ? " active" : ""}"
        data-rem-id="${remId}" data-opt="${escHtml(opt)}">${escHtml(opt)}</button>`
    ).join("")}</div>`;
  }

  const optBtns = makeOptPills(rem.id, rem.text)
    || `<textarea class="field-input remark-text-input" rows="1"
        data-rem-id="${rem.id}" data-saved-html="${escHtml(rem.text || "")}">${escHtml(plainTextForEdit(rem.text))}</textarea>`;

  // Sketch board button only shown when there's a free-text input (no preset opt pills)
  const sketchBtn = opts.length === 0
    ? `<button class="btn-sketch" contenteditable="false" data-rem-id="${rem.id}" aria-label="Open sketch board">✏</button>`
    : "";

  let remarkContent;
  if (sentenceStarter) {
    const starterClass = opts.length > 0 ? "remark-starter-wrap remark-starter-wrap--opts" : "remark-starter-wrap";
    remarkContent = `<div class="${starterClass}">
      <span class="remark-starter-prefix" contenteditable="false">${escHtml(sentenceStarter)}</span>
      ${makeOptPills(rem.id, rem.text)
        || `<textarea class="field-input remark-text-input" rows="1"
            data-rem-id="${rem.id}" data-saved-html="${escHtml(rem.text || "")}">${escHtml(plainTextForEdit(rem.text))}</textarea>`
      }
    </div>`;
  } else {
    remarkContent = optBtns;
  }

  // Generalized version of Mastery's separate Notes field — same idea, but
  // the select-one options above are whatever the boss configured (not
  // hardcoded mastery values), so this reuses the same .mastery-note-input
  // class/rem.masteryNote field to pick up the existing save wiring for free.
  const noteField = remarkHasNote
    ? `<div class="entry-field" contenteditable="false">
        <span class="field-label">Notes</span>
        <button class="btn-sketch" data-rem-id="${rem.id}" aria-label="Open sketch board">✏</button>
        <textarea class="field-input mastery-note-input" rows="1"
          data-rem-id="${rem.id}" placeholder="Notes…"
          data-saved-html="${escHtml(rem.masteryNote || "")}">${escHtml(plainTextForEdit(rem.masteryNote || ""))}</textarea>
      </div>`
    : "";

  return `
    <div class="entry-divider" contenteditable="false"></div>
    <div class="entry-field">
      <span class="field-label" contenteditable="false">Remark</span>
      ${sketchBtn}
      ${remarkContent}
      <button class="btn-icon btn-delete-remark" contenteditable="false"
        data-rem-id="${rem.id}" title="Delete remark">🗑</button>
    </div>
    ${noteField}
    ${trailingField}`;
}

function renderPendingRemarkFields(pendingKey, actId, paName, paOrder, target) {
  return `
    <div class="entry-divider" contenteditable="false"></div>
    <div class="entry-field">
      <span class="field-label" contenteditable="false">Remark</span>
      <button class="btn-sketch btn-sketch-pending" contenteditable="false" aria-label="Open sketch board">✏</button>
      <textarea id="new-remark-textarea" class="field-input" rows="1"
        placeholder="Type remark…"></textarea>
    </div>
    <div class="pending-remark-actions" contenteditable="false">
      <button class="btn-cancel-remark btn-remark-cancel">✕ Cancel</button>
      <button class="btn-save-remark btn-remark-save">✓ Save</button>
    </div>`;
}

// Predefined remark that exists in Firebase — label as field-label, editable text input
function renderPredefinedRemarkFields(rem, predRemName, target) {
  const trials = rem.trials || [];
  const badgesHtml = trials.map((score, idx) =>
    `<span class="trial-badge">${score === -1 ? "—" : score}<button class="btn-trial-delete"
      data-rem-id="${rem.id}" data-idx="${idx}">×</button></span>`
  ).join("");
  return `
    <div class="entry-divider" contenteditable="false"></div>
    <div class="entry-field">
      <span class="field-label" contenteditable="false">${escHtml(predRemName)}</span>
      <input type="text" class="field-input predef-remark-input-live"
        data-rem-id="${rem.id}"
        data-original="${escHtml(rem.text || "")}"
        data-saved-html="${escHtml(rem.text || "")}"
        placeholder="e.g. 80%" value="${escHtml(rem.text || "")}" />
    </div>
    <div class="entry-field" contenteditable="false">
      <span class="field-label">Trials</span>
      <div class="trials-row">
        <div class="trials-badges">${badgesHtml}</div>
        <button class="btn-add-trial btn-primary-sm"
          data-rem-id="${rem.id}"
          data-target="${escHtml(target.name)}">+ Trial</button>
      </div>
    </div>`;
}

// Predefined remark not yet in Firebase — label + empty text input
function renderGhostRemarkFields(predRemName, actId, pa, paIdx, target) {
  return `
    <div class="entry-divider" contenteditable="false"></div>
    <div class="entry-field">
      <span class="field-label" contenteditable="false">${escHtml(predRemName)}</span>
      <input type="text" class="field-input predef-remark-input"
        data-rem-name="${escHtml(predRemName)}"
        data-act-id="${actId || ""}"
        data-pa-name="${escHtml(pa.name)}"
        data-pa-order="${paIdx}"
        data-target="${escHtml(target.name)}"
        placeholder="e.g. 80%" />
    </div>
    <div class="entry-field" contenteditable="false">
      <span class="field-label">Trials</span>
      <div class="trials-row">
        <div class="trials-badges"></div>
        <button class="btn-primary-sm btn-init-predef-remark"
          data-rem-name="${escHtml(predRemName)}"
          data-act-id="${actId || ""}"
          data-pa-name="${escHtml(pa.name)}"
          data-pa-order="${paIdx}"
          data-target="${escHtml(target.name)}">+ Trial</button>
      </div>
    </div>`;
}

// ─── ATTACH LISTENERS ────────────────────────────────────────

function attachTargetListeners(target) {
  const c = $("target-content");

  // Free-text boxes here are real <textarea>/<input> elements now, so their
  // own native Enter/backspace/Ctrl+A handling just works — only the app's
  // own Escape/Ctrl+Enter shortcuts are delegated from the host (set up ONCE
  // per session-open by setupEntryEnterKeyDelegation, see openSession).
  c.querySelectorAll("textarea.field-input").forEach(autoResizeTextarea);

  // Activity name (.activity-name-input) is saved by the shared merged-editing
  // host — see setupEntryRemarkSaving. Just revert-if-emptied here (Ctrl+Enter
  // is handled by the delegated keydown listener above).
  c.querySelectorAll(".activity-name-input").forEach(input => {
    input.addEventListener("blur", () => {
      if (!input.value.trim()) input.value = input.dataset.original;
    });
  });

  // ── New activity input ───────────────────────────────────
  c.querySelector(".btn-add-activity")?.addEventListener("click", () => {
    state.pendingNewActivity = { targetName: target.name };
    state.pendingNewRemark   = null;
    renderTargetContent();
    setTimeout(() => $("new-activity-textarea")?.focus(), 50);
  });

  $("new-activity-textarea")?.addEventListener("blur", e => {
    // Small delay so cancel button click can fire first
    setTimeout(() => {
      const input = $("new-activity-textarea");
      if (!input) return; // already removed by cancel
      const name = input.value.trim();
      state.pendingNewActivity = null;
      if (name) {
        addActivity(state.currentSessionId, target.name, name, Date.now(), false);
      } else {
        renderTargetContent();
      }
    }, 150);
  });

  c.querySelector(".btn-cancel-new-activity")?.addEventListener("click", cancelPendingActivity);

  // ── Delete activity ───────────────────────────────────────
  c.querySelectorAll(".btn-delete-activity").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this activity and all its remarks?")) return;
      const remIds = getRemarksForActivity(btn.dataset.actId).map(r => r.id);
      await deleteActivity(state.currentSessionId, btn.dataset.actId, remIds);
    });
  });

  // Saving for .remark-text-input / .mastery-note-input / .activity-name-input /
  // .predef-remark-input / .predef-remark-input-live is handled by the shared
  // host-level saver (state.entryRemarkSaver, set up in openSession) rather
  // than per-element blur — these boxes get torn down and rebuilt on every
  // render, so per-element listeners would need re-attaching constantly. See
  // setupEntryRemarkSaving.

  // ── Add remark (immediate creation) ──────────────────────
  c.querySelectorAll(".btn-add-remark").forEach(btn => {
    // Guards against a render (triggered by the blur this mousedown is
    // about to cause on whatever box the boss was just typing in, or by an
    // already-scheduled render from that typing's own autosave) replacing
    // this button before "click" fires — Chrome silently drops "click" if
    // its target is removed from the DOM between mousedown and mouseup.
    btn.addEventListener("mousedown", () => {
      state.entryActionsInFlight++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        state.entryActionsInFlight = Math.max(0, state.entryActionsInFlight - 1);
        // If "click" never actually fired (e.g. the press was dragged away),
        // the main click handler's own increment/decrement never ran either,
        // so catch up on any render its finally would otherwise have done.
        if (state.entryActionsInFlight === 0 && state.renderPending) {
          state.renderPending = false;
          renderTargetContent();
        }
      };
      // Released the instant "click" actually fires, proving the button
      // survived the gap — the main click handler renders synchronously
      // once it's done (no further write to guard against). The timeout is
      // only a fallback for a press that never resolves into a click at all.
      btn.addEventListener("click", release, { once: true });
      setTimeout(release, 600);
    });
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const paName  = btn.dataset.paName || null;
        const paOrder = Number(btn.dataset.paOrder) || 0;
        let   actId   = btn.dataset.actId  || null;
        state.pendingNewActivity = null;
        // Mapped activities use autoFillMappedRemarks instead of the normal
        // path to avoid a race: addActivity's Firestore snapshot can re-enter
        // autoFillMappedRemarks before this handler adds the remark, creating
        // a duplicate. autoFillMappedRemarks's in-flight guard prevents that.
        if (btn.dataset.isMapped === "1") {
          await autoFillMappedRemarks(state.currentStudent, state.currentSessionId);
          return; // Firestore write will trigger snapshot → re-render
        }
        if (paName) actId = await ensureFedcActivity(target.name, paName, paOrder);
        if (!actId) { btn.disabled = false; return; }
        const initialText = "";
        // Write the remark into local state and render right away instead of
        // waiting on the Firestore round trip — addRemark() is handed the
        // same ID so it just confirms this row server-side in the background.
        const remId = generateId("r");
        state.sessionData.remarks = state.sessionData.remarks || {};
        state.sessionData.remarks[remId] = { activityId: actId, text: initialText, trials: [], order: Date.now() };
        renderTargetContent();
        addRemark(state.currentSessionId, actId, initialText, null, remId).catch(err => {
          delete state.sessionData.remarks[remId];
          renderTargetContent();
          alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
        });
      } catch (err) {
        btn.disabled = false;
        alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
      }
    });
  });

  // ── Remark option buttons (single-select) ─────────────────
  c.querySelectorAll(".remark-preset-opts:not(.remark-preset-opts-multi) .btn-remark-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      const isActive = btn.classList.contains("active");
      btn.closest(".remark-preset-opts")?.querySelectorAll(".btn-remark-opt").forEach(b => b.classList.remove("active"));
      const newText = isActive ? "" : btn.dataset.opt;
      if (!isActive) btn.classList.add("active");
      // Update state.sessionData synchronously, not just the DOM — see
      // leaveSession()'s cleanup-empty-remarks check, which reads it straight
      // off a snapshot taken on the way out with no guard for an in-flight write.
      const remId = btn.dataset.remId;
      const rem = state.sessionData?.remarks?.[remId];
      const prevText = rem?.text;
      if (rem) rem.text = newText;
      updateRemarkText(state.currentSessionId, remId, newText).catch(err => {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // ── Remark option buttons (multi-select) ──────────────────
  c.querySelectorAll(".remark-preset-opts-multi .btn-remark-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      const container = btn.closest(".remark-preset-opts-multi");
      const selected = [...container.querySelectorAll(".btn-remark-opt.active")].map(b => b.dataset.opt);
      const newText = selected.join(", ");
      const remId = btn.dataset.remId;
      const rem = state.sessionData?.remarks?.[remId];
      const prevText = rem?.text;
      if (rem) rem.text = newText;
      updateRemarkText(state.currentSessionId, remId, newText).catch(err => {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      });
    });
  });


  // ── New remark: ✓ Save button or Ctrl/Cmd+Enter saves ───
  c.querySelectorAll(".btn-save-remark").forEach(btn => {
    btn.addEventListener("click", () => saveNewRemark(target));
  });
  // Enter/Ctrl+Enter inside #new-remark-textarea is handled by the delegated
  // keydown listener set up at the top of this function.

  // ── Cancel new remark ─────────────────────────────────────
  c.querySelectorAll(".btn-cancel-remark").forEach(btn => {
    btn.addEventListener("click", () => {
      state.pendingNewRemark = null;
      renderTargetContent();
    });
  });

  // ── Sketch board buttons (session screen) ─────────────────
  c.querySelectorAll(".btn-sketch[data-rem-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.remId;
      const field = c.querySelector(`.remark-text-input[data-rem-id="${id}"]`)
                 || c.querySelector(`.mastery-note-input[data-rem-id="${id}"]`);
      if (field) openTextEditorSheet(field);
    });
  });
  c.querySelector(".btn-sketch-pending")?.addEventListener("click", () => {
    const field = $("new-remark-textarea");
    if (field) openTextEditorSheet(field);
  });

  // ── Delete remark ─────────────────────────────────────────
  c.querySelectorAll(".btn-delete-remark").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("Delete this remark and its trials?")) return;
      const remId = btn.dataset.remId;
      const rem = state.sessionData?.remarks?.[remId];
      if (!rem) return;
      delete state.sessionData.remarks[remId];
      renderTargetContent();
      deleteRemark(state.currentSessionId, remId).catch(err => {
        state.sessionData.remarks[remId] = rem;
        renderTargetContent();
        alert("Couldn't delete remark — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // Ghost (.predef-remark-input) and live (.predef-remark-input-live) predefined
  // remark inputs are also saved by the shared merged-editing host — see above.
  // Enter is handled by the delegated keydown listener at the top of this function.

  // ── Init predefined remark + open score picker ────────────
  c.querySelectorAll(".btn-init-predef-remark").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tgt = state.currentStudent.targets.find(t => t.name === btn.dataset.target);
      if (!tgt) return;
      const paOrder = btn.dataset.paOrder !== "" ? Number(btn.dataset.paOrder) : 0;
      const actId = await ensureFedcActivity(tgt.name, btn.dataset.paName, paOrder);
      // Capture any text the boss already typed in the ghost input
      const ghostInput = [...c.querySelectorAll(".predef-remark-input")].find(
        inp => inp.dataset.remName === btn.dataset.remName
      );
      const initialText = ghostInput?.value.trim() || "";
      const remId = await ensurePredefinedRemark(actId, btn.dataset.remName, initialText);
      openScorePicker(remId, tgt.maxPoints || 3);
      // ensurePredefinedRemark already wrote initialText when creating a brand-new
      // remark — this only matters for the rare case where it already existed
      // with stale text, so don't block opening the score picker on it.
      if (initialText) updateRemarkText(state.currentSessionId, remId, initialText).catch(() => {});
    });
  });

  // ── Add trial ─────────────────────────────────────────────
  c.querySelectorAll(".btn-add-trial").forEach(btn => {
    btn.addEventListener("click", () => {
      const tgt = state.currentStudent.targets.find(t => t.name === btn.dataset.target);
      openScorePicker(btn.dataset.remId, tgt?.maxPoints || 3);
    });
  });

  // ── Delete trial ──────────────────────────────────────────
  c.querySelectorAll(".btn-trial-delete").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const rem = state.sessionData?.remarks?.[btn.dataset.remId];
      if (!rem) return;
      const idx = Number(btn.dataset.idx);
      const prevTrials = rem.trials || [];
      rem.trials = prevTrials.filter((_, i) => i !== idx);
      renderTargetContent();
      deleteTrial(state.currentSessionId, btn.dataset.remId, idx, prevTrials).catch(err => {
        rem.trials = prevTrials;
        renderTargetContent();
        alert("Couldn't delete trial — check your connection and try again.\n\n" + err.message);
      });
    });
  });

}

// ─── ACTION HELPERS ──────────────────────────────────────────

async function confirmNewActivity(target) {
  const input = $("new-activity-textarea");
  if (!input) return;
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  state.pendingNewActivity = null;
  flashSaved(input);
  input.value = "";  // blur handler sees empty → calls renderTargetContent at +150ms
  input.blur();      // dismiss keyboard; flash shows for ~150ms then input removed
  await addActivity(state.currentSessionId, target.name, name, Date.now(), false);
}

function cancelPendingActivity() {
  state.pendingNewActivity = null;
  renderTargetContent();
}

async function saveNewRemark(target) {
  const ta = $("new-remark-textarea");
  if (!ta || !state.pendingNewRemark) return;

  const text    = htmlForStorage(ta.value);
  const p       = state.pendingNewRemark;
  const paName  = p.paName || null;
  const paOrder = p.paOrder ?? 0;
  let   actId   = p.actId  || null;

  state.pendingNewRemark = null; // prevent blur-handler double-save
  flashSaved(ta);
  ta.blur(); // clear focus so Firebase snapshot can trigger re-render

  if (paName) actId = await ensureFedcActivity(target.name, paName, paOrder);
  if (!actId) return;
  await addRemark(state.currentSessionId, actId, text);
}

// True for the remark types where there's a fixed set of things to pick from
// (Select one / Tick boxes / Sentence Starter + either, or + Select One +
// Free Text) — these warrant auto-opening a remark since there's no typing
// to do first. Free text and Sentence Starter + Free Text are excluded:
// there's nothing to pre-select, so they stay collapsed behind "+ Add
// Remark & Trials" until the boss actually has something to type.
function isAutoOpenRemarkType(pa) {
  if (pa.remarkHasNote) return true;
  if (pa.sentenceStarter && pa.inlineOptions) return true;
  if (pa.sentenceStarter) return false;
  return !!(pa.inlineOptions || pa.remarkPresetId);
}

// Auto-create an empty remark for every "pick from options" activity on
// session open, unconditionally — the point is just to skip the extra click,
// there's no "previous value" to wait for first.
// Same in-flight guard as autoFillMappedRemarks below (structuredRemarkAutoFillInFlight,
// keyed the same way) — without it, a duplicate activity could be created
// here too if firstLoad re-entered before a prior addActivity+addRemark
// pair finished, the exact shape mergeDuplicateActivity (firebase-service.js)
// exists to clean up. This only protects re-entrancy within one open tab —
// it can't stop two devices/tabs racing each other, which is why the
// Data Integrity Check's duplicate-activity section exists as a backstop.
async function autoFillStructuredRemarks(student, sessionId) {
  const data = state.sessionData;
  let count = 0;
  for (const target of (student.targets || [])) {
    for (const pa of (target.predefinedActivities || [])) {
      if (pa.isCompleted || pa.isArchived || pa.isStopped || pa.isMaintain || pa.isMaintainHeading) continue;
      if (!isAutoOpenRemarkType(pa)) continue;

      const existingAct = Object.entries(data.activities || {})
        .find(([, a]) => a.targetName === target.name && a.activityName === pa.name);
      let actId = existingAct?.[0] || null;

      if (actId) {
        const hasRemark = Object.values(data.remarks || {}).some(r => r.activityId === actId);
        if (hasRemark) continue;
      }

      const key = `${sessionId}:${target.name}:${pa.name}`;
      if (structuredRemarkAutoFillInFlight.has(key)) continue;
      structuredRemarkAutoFillInFlight.add(key);
      try {
        if (!actId) {
          actId = await addActivity(sessionId, target.name, pa.name, pa.order ?? 0, true);
        }
        await addRemark(sessionId, actId, "");
        count++;
      } finally {
        structuredRemarkAutoFillInFlight.delete(key);
      }
    }
  }
  return count;
}

// Auto-create an empty remark for a mapped-score activity as soon as its
// mapped target gains a computable average — otherwise the row stays
// collapsed (no remark of its own) even after the target it pulls from has
// real data. Unlike autoFillStructuredRemarks this runs on every snapshot,
// not just first load: the trigger ("the other target now has data") can
// become true at any point while this session stays open, not only when
// it's opened.
// Creating a mapped-score activity's first remark is two separate Firestore
// writes (addActivity, then addRemark) — each one's own snapshot can re-enter
// these auto-fill functions before the second write lands, racing into a
// duplicate remark for the same activity (or, for group sessions, the same
// attendee). Shared by all four autoFill*MappedRemarks functions below so a
// re-entrant call for the same key skips instead of double-adding.
const mappedRemarkAutoFillInFlight = new Set();

async function autoFillMappedRemarks(student, sessionId) {
  const data = state.sessionData;
  let count = 0;
  for (const target of (student.targets || [])) {
    for (const pa of (target.predefinedActivities || [])) {
      if (pa.isCompleted || pa.isArchived || pa.isStopped || pa.isMaintain || pa.isMaintainHeading) continue;
      if (!pa.isMapped) continue;

      const existingAct = Object.entries(data.activities || {})
        .find(([, a]) => a.targetName === target.name && a.activityName === pa.name);
      let actId = existingAct?.[0] || null;

      if (actId) {
        const hasRemark = Object.values(data.remarks || {}).some(r => r.activityId === actId);
        if (hasRemark) continue;
      }

      const key = `${sessionId}:${target.name}:${pa.name}`;
      if (mappedRemarkAutoFillInFlight.has(key)) continue;
      mappedRemarkAutoFillInFlight.add(key);
      try {
        if (!actId) {
          actId = await addActivity(sessionId, target.name, pa.name, pa.order ?? 0, true);
        }
        await addRemark(sessionId, actId, "");
        count++;
      } finally {
        mappedRemarkAutoFillInFlight.delete(key);
      }
    }
  }
  return count;
}

// Deletes remarks that have no text, no mastery note, and no valid trials for
// the given target, then removes any activity that is left with no remarks.
// A "-1" trial is the View/Edit screen's "+" placeholder for a slot that was
// added but never given an actual score — it never counts as real data: a
// remark that's otherwise empty gets deleted outright (as if "+" was never
// clicked), and one that has other real content just has that stray slot
// quietly dropped from its trials array.
async function cleanupEmptyEntries(sessionId, data, targetName, target = null) {
  if (!sessionId || !data) return;
  // Mapped-score activities are designed to have no remark of their own until
  // their mapped target gains an average (see autoFillMappedRemarks) — an
  // empty one isn't stale data, it's the activity waiting to auto-fill. Treat
  // them as exempt so this cleanup never races that auto-fill and deletes it.
  const mappedNames   = new Set((target?.predefinedActivities || []).filter(pa => pa.isMapped).map(pa => pa.name));
  // Auto-open activities (Select One / Tickbox / Sentence Starter + select) get
  // an empty placeholder remark on session open so the user can pick immediately.
  // Don't delete it on target switch — it's not stale, it's waiting for input.
  const autoOpenNames = new Set((target?.predefinedActivities || []).filter(pa => isAutoOpenRemarkType(pa)).map(pa => pa.name));
  const acts = Object.entries(data.activities || {})
    .filter(([, a]) => a.targetName === targetName && !mappedNames.has(a.activityName) && !autoOpenNames.has(a.activityName));
  for (const [actId] of acts) {
    const rems = Object.entries(data.remarks || {}).filter(([, r]) => r.activityId === actId);
    const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
    const emptyIds = [];
    for (const [remId, r] of rems) {
      const trials     = r.trials || [];
      const realTrials = trials.filter(t => t !== -1);
      const hasText = stripEmpty(r.text).length > 0;
      const hasNote = stripEmpty(r.masteryNote).length > 0;
      if (!hasText && !hasNote && realTrials.length === 0) {
        emptyIds.push(remId);
      } else if (realTrials.length !== trials.length) {
        await setTrials(sessionId, remId, realTrials);
      }
    }
    if (!emptyIds.length) continue;
    if (emptyIds.length === rems.length) {
      await deleteActivity(sessionId, actId, emptyIds); // removes activity + all its empty remarks
    } else {
      for (const remId of emptyIds) await deleteRemark(sessionId, remId);
    }
  }
}

async function ensureFedcActivity(targetName, activityName, order) {
  const existing = findActivityByName(targetName, activityName);
  if (existing) return existing.id;
  return await addActivity(state.currentSessionId, targetName, activityName, order, true);
}

async function ensurePredefinedRemark(actId, remarkName, initialText = "") {
  const existing = findRemarkByPredefinedKey(actId, remarkName);
  if (existing) return existing.id;
  return await addRemark(state.currentSessionId, actId, initialText, remarkName);
}

function findRemarkByPredefinedKey(actId, key) {
  const found = Object.entries(state.sessionData?.remarks || {}).find(
    ([, r]) => r.activityId === actId && r.predefinedKey === key
  );
  return found ? { id: found[0], ...found[1] } : null;
}

// ─── SCORE PICKER MODAL ──────────────────────────────────────

function _activeSessionData() {
  return state.scorePicker?.isGroup ? state.groupSessionData : state.sessionData;
}
function _activeSessionId() {
  return state.scorePicker?.isGroup ? state.groupSessionId : state.currentSessionId;
}

function renderScoreModalTrials(remId) {
  const el = $("score-modal-trials");
  if (!el) return;
  const allTrials = _activeSessionData()?.remarks?.[remId]?.trials || [];
  const visible = allTrials.map((t, i) => ({ t, i })).filter(({ t }) => t !== -1);
  if (!visible.length) { el.innerHTML = ""; return; }

  el.innerHTML =
    `<span class="score-modal-trials-label">Added:</span>` +
    visible.map(({ t, i }) =>
      `<span class="score-modal-trial-badge">
        ${t}<button class="score-trial-del" data-idx="${i}" aria-label="Remove">×</button>
      </span>`
    ).join("");

  el.querySelectorAll(".score-trial-del").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      btn.closest(".score-modal-trial-badge").remove(); // optimistic
      const rem = _activeSessionData()?.remarks?.[remId];
      if (rem) await deleteTrial(_activeSessionId(), remId, idx, rem.trials || []);
    });
  });
}

function openScorePicker(remId, target) {
  const maxPoints = (typeof target === "object" ? target?.maxPoints : target) || 3;
  const isGroup   = !!state.scorePicker?.isGroup;
  state.scorePicker = { open: true, remId, isGroup };
  const labels = CONFIG.SCORE_LABELS[maxPoints] || CONFIG.SCORE_LABELS[3];

  renderScoreModalTrials(remId);

  $("score-buttons").innerHTML = Object.entries(labels).map(([score, label]) =>
    `<button class="score-btn" data-score="${score}">
      <span class="score-num">${score}</span>
      <span class="score-label">${escHtml(label)}</span>
    </button>`
  ).join("");

  $("score-buttons").querySelectorAll(".score-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const rem = _activeSessionData()?.remarks?.[remId];
      if (!rem) return;
      const score = Number(btn.dataset.score);
      await addTrial(_activeSessionId(), remId, score, rem.trials || []);
      // Firestore snapshot will call renderScoreModalTrials to update badges
    });
  });

  $("score-modal").classList.remove("hidden");
}

function closeScorePicker() {
  state.scorePicker = { open: false, remId: null };
  $("score-modal").classList.add("hidden");
}

$("score-modal-close").addEventListener("click",    closeScorePicker);
$("score-modal-backdrop").addEventListener("click", closeScorePicker);

// ============================================================
// SESSION VIEW SCREEN (table-based view/edit for past sessions)
// ============================================================

function getViewEffectiveTargets() {
  const currentTargets = state.viewStudent?.targets || [];
  if (!state.viewSessionData) return currentTargets;
  // Always use the current target list: new targets appear in old sessions,
  // deleted targets disappear from all sessions (data removed by deleteTargetDataFromSessions).
  return currentTargets;
}

async function openSessionView(student, sessionId) {
  commitTextEditorSheet();
  state.viewStudent         = student;
  state.viewSessionId       = sessionId;
  state.viewSessionData     = null;
  state.viewRenderPending   = false;
  state.viewActionsInFlight = 0;

  showScreen("screen-session-view");
  $("view-student-name").textContent = student.name;
  $("view-session-meta").textContent = "";
  $("session-view-body").innerHTML = `<div class="loading">Loading…</div>`;

  if (state.fbViewUnsubscribe) { state.fbViewUnsubscribe(); state.fbViewUnsubscribe = null; }

  state.viewRemarkSaver?.cleanup();
  state.viewRemarkSaver = setupViewRemarkSaving($("session-view-body"), () => state.viewSessionId, "viewActionsInFlight", () => {
    if (!state.viewRenderPending || isViewBusy() || state.viewActionsInFlight > 0) return;
    state.viewRenderPending = false;
    renderSessionView();
  }, () => state.viewSessionData);

  try {
    state.fbViewUnsubscribe = listenToSession(sessionId, async data => {
      state.viewSessionData = data;
      try {
        const filled = await autoFillViewMappedRemarks(student, sessionId, data);
        if (filled > 0) return; // the write triggers another snapshot, which renders
      } catch (err) { console.error("autoFillViewMappedRemarks failed:", err); }
      if (isViewBusy() || state.viewActionsInFlight > 0) { state.viewRenderPending = true; }
      else               { renderSessionView(); }
    });
  } catch (err) {
    $("session-view-body").innerHTML =
      `<div class="error-msg">Could not load session.<br>${escHtml(err.message)}</div>`;
  }
}

async function leaveSessionView() {
  commitTextEditorSheet();
  $("text-editor-sheet").classList.add("hidden");
  $("btn-delete-session")?.classList.add("hidden");
  $("btn-goto-session")?.classList.add("hidden");
  // Flush (and await it) while the Firestore listener is still live, same as
  // leaveSession() does for the live entry screen — flush() only writes to
  // Firestore, state.viewSessionData only updates once the listener echoes
  // it back, so unsubscribing first or not waiting for the flush both risk
  // the cleanup below seeing stale "empty" data for a remark just edited.
  await state.viewRemarkSaver?.flush();
  if (state.fbViewUnsubscribe) { state.fbViewUnsubscribe(); state.fbViewUnsubscribe = null; }
  state.viewRemarkSaver?.cleanup();
  state.viewRemarkSaver = null;
  const sessionId = state.viewSessionId;
  const data      = state.viewSessionData;
  const student   = state.viewStudent;
  state.viewSessionId       = null;
  state.viewSessionData     = null;
  state.viewStudent         = null;
  state.viewRenderPending   = false;
  state.viewActionsInFlight = 0;

  if (sessionId && data) {
    const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
    const currentTargetNames = new Set((student?.targets || []).map(t => t.name));
    const fedcHasData = Object.values(data.fedcComments || {}).some(c => stripEmpty(c).length > 0);
    const remarkHasData = Object.values(data.remarks || {}).some(r => {
      const act = (data.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      return stripEmpty(r.text).length > 0
        || (r.trials || []).some(t => t !== null && t !== -1)
        || stripEmpty(r.masteryNote).length > 0;
    });
    if (!fedcHasData && !remarkHasData) {
      deleteEmptyIndividualSession(sessionId, student.id, data.date).catch(() => {});
    } else {
      const allTargetNames = new Set(Object.values(data.activities || {}).map(a => a.targetName));
      allTargetNames.forEach(name => {
        const target = (student?.targets || []).find(t => t.name === name);
        cleanupEmptyEntries(sessionId, data, name, target).catch(() => {});
      });
    }
  }

  showHome();
}

$("btn-view-back").addEventListener("click", leaveSessionView);
$("btn-student-registry-back").addEventListener("click", showHome);

function renderSessionView() {
  const data    = state.viewSessionData;
  const student = state.viewStudent;
  if (!data || !student) return;

  $("view-session-meta").innerHTML =
    `Session ${data.sessionNumber}: ${formatDateWithDay(data.date)}${relativeDaySuffix(data.date)}`
    + ` <button class="btn-edit-session-date">Edit Date</button>`;

  const delBtn = $("btn-delete-session");
  if (delBtn) delBtn.classList.remove("hidden");

  $("view-session-meta").querySelector(".btn-edit-session-date").addEventListener("click", () => {
    showEditDatePicker();
  });

  const gotoBtn = $("btn-goto-session");
  if (gotoBtn) {
    gotoBtn.classList.remove("hidden");
    gotoBtn.onclick = () => showGoToAnotherSession(state.viewStudent);
  }

  // Wire delete button (static element in header — re-attach each time)
  const _delBtn = $("btn-delete-session");
  if (_delBtn) {
    const newDelBtn = _delBtn.cloneNode(true); // remove old listeners
    newDelBtn.classList.remove("hidden");
    _delBtn.replaceWith(newDelBtn);
    newDelBtn.addEventListener("click", async () => {
      const typed = prompt(`Delete Session ${data.sessionNumber} (${formatDate(data.date)})?\n\nThis cannot be undone. Type DELETE to confirm:`);
      if (typed !== "DELETE") return;
      const sid = state.viewSessionId;
      leaveSessionView();
      await deleteSession(sid).catch(() => {});
    });
  }

  const targets = getViewEffectiveTargets();
  const sorted  = sortTargetsByOrder(targets);

  const body = $("session-view-body");
  // body itself scrolls (overflow-y:auto) — replacing its innerHTML resets
  // scrollTop to 0 in every browser, so capture/restore around the swap.
  const scrollTop = body.scrollTop;
  const captured = captureActiveEditState(body);
  body.innerHTML = sorted.length
    ? sorted.map(t => buildTargetViewTable(t, data)).join("")
    : `<p style="color:var(--text-muted);padding:1rem">No targets recorded.</p>`;

  attachViewListeners();
  restoreActiveEditState(body, captured);
  body.scrollTop = scrollTop;
}

function buildTargetViewTable(target, data) {
  const dayAvg = calcViewDayAvg(data, target);

  let rows = "";
  if (target.predefinedActivities?.length > 0) {
    let no = 0;
    for (const pa of target.predefinedActivities) {
      if (pa.isHeading) {
        rows += `<tr class="view-heading-row"><td colspan="6" contenteditable="false">${escHtml(pa.name)}</td></tr>`;
        continue;
      }
      if (pa.isNote) {
        rows += `<tr class="view-note-row"><td colspan="6" contenteditable="false">${noteToHtml(pa.text)}</td></tr>`;
        continue;
      }
      no++;
      const entry = Object.entries(data.activities || {})
        .find(([, a]) => a.targetName === target.name && a.activityName === pa.name);
      rows += viewActivityRows(no, pa.name, entry?.[0] || null, data, target, true);
    }
    // manual (non-predefined) activities added during session
    Object.entries(data.activities || {})
      .filter(([, a]) => a.targetName === target.name && !a.isPredefined)
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
      .forEach(([actId, act]) => {
        no++;
        rows += viewActivityRows(no, act.activityName, actId, data, target, false);
      });
  } else {
    let no = 0;
    Object.entries(data.activities || {})
      .filter(([, a]) => a.targetName === target.name)
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
      .forEach(([actId, act]) => {
        no++;
        rows += viewActivityRows(no, act.activityName, actId, data, target, false);
      });
  }

  if (target.hasComment) {
    const key     = sanitizeKey(target.name);
    const comment = (data.fedcComments || {})[key] || "";
    rows += `<tr class="view-comment-row">
      <td colspan="2" class="view-comment-label" contenteditable="false">Comment</td>
      <td colspan="4" contenteditable="false">
        <textarea class="view-comment-edit" data-target-key="${escHtml(key)}" rows="3"
        >${escHtml(comment)}</textarea>
      </td>
    </tr>`;
  }

  if (dayAvg !== null) {
    rows += `<tr class="view-dayavg-row">
      <td colspan="5" style="text-align:right" contenteditable="false">Day's Average</td>
      <td class="vcol-score" contenteditable="false">${dayAvg}%</td>
    </tr>`;
  }

  return `<div class="target-view-section">
    <div class="target-view-header" contenteditable="false">
      <span class="target-view-name">${escHtml(target.name)}</span>
      ${dayAvg !== null ? `<span class="target-view-avg">${dayAvg}%</span>` : ""}
    </div>
    <div class="view-table-wrapper">
      <table class="view-table">
        <thead><tr>
          <th class="vcol-no">No.</th>
          <th class="vcol-act">Activity</th>
          <th class="vcol-rem">Remark</th>
          <th class="vcol-trials">Trials</th>
          <th class="vcol-total">Total</th>
          <th class="vcol-score">% Score</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <button class="view-add-remark-target" data-target="${escHtml(target.name)}">+ Add Remark &amp; Trials</button>
  </div>`;
}

function viewActivityRows(no, actName, actId, data, target, isPredefined = true) {
  const remarks = actId ? viewGetRemarks(data, actId) : [];

  const paEntry = isPredefined
    ? target.predefinedActivities?.find(pa => pa.name === actName)
    : null;

  const actCell = isPredefined
    ? formatActivityMarkup(actName) + (paEntry?.actNote?.trim() ? `<div class="view-act-note">${formatActivityMarkup(paEntry.actNote)}</div>` : "")
    : `<div style="display:flex;align-items:center;gap:.3rem">
        <input class="view-act-edit" type="text" value="${escHtml(actName)}"
          data-act-id="${escHtml(actId || "")}" data-original="${escHtml(actName)}" />
        <button class="view-act-del" data-act-id="${escHtml(actId || "")}"
          data-target-name="${escHtml(target.name)}" title="Delete activity">×</button>
       </div>`;

  const inlineOptions   = paEntry ? getActivityInlineOptions(paEntry) : null;
  const sentenceStarter = paEntry?.sentenceStarter || null;
  const multiSelect     = paEntry?.optionsMulti || false;
  const remarkHasNote   = paEntry?.remarkHasNote || false;
  const mappedInfo      = paEntry?.isMapped ? resolveViewMappedScoreDisplay(paEntry, data) : null;

  if (remarks.length === 0) {
    // For free-text remark types (no preset opts), show a clickable empty input
    const opts = parseOpts(inlineOptions);
    const showEmpty = opts.length === 0;
    if (showEmpty) {
      const emptyCell = `<textarea class="view-remark-edit view-remark-empty" rows="1"
           data-act-id="${escHtml(actId || "")}"
           data-act-name="${escHtml(actName)}"
           data-target="${escHtml(target.name)}"
           data-is-predefined="${isPredefined}"></textarea>`;
      // "+ " shows even with no remark yet — clicking it creates the activity/
      // remark and a first trial in one go, so a score can be logged without
      // first having to type something into the remark box. Mapped-score
      // activities have no trials at all, so they skip this button entirely —
      // typing into the empty box above is the only way to create the remark.
      // No score/label shown here even though mappedInfo resolves to a real
      // percentage — that percentage is the mapped TARGET's own average, which
      // exists independently of whether THIS activity has any remark yet, so
      // showing it here would look like this row already has live data when
      // it actually contributes nothing until a remark exists (matches the
      // group screen's equivalent empty case, which already left this blank).
      const addTrialBtn = mappedInfo
        ? ""
        : `<button class="view-add-trial-new" data-act-id="${escHtml(actId || "")}"
        data-act-name="${escHtml(actName)}" data-target-name="${escHtml(target.name)}"
        data-is-predefined="${isPredefined}">+</button>`;
      return `<tr>
        <td class="vcol-no" contenteditable="false">${no}</td>
        <td class="vcol-act" contenteditable="false">${actCell}</td>
        <td class="vcol-rem">${emptyCell}</td>
        <td class="vcol-trials" contenteditable="false">${addTrialBtn || "&nbsp;"}</td>
        <td class="vcol-total" contenteditable="false">&nbsp;</td>
        <td class="vcol-score" contenteditable="false">&nbsp;</td>
      </tr>`;
    }
    // Preset-option / sentence-starter activities have no typeable
    // empty box (there's no free text to click into), so without an explicit
    // button here the Remark cell was just blank with no way to create the
    // first remark at all.
    const addRowLabel = opts.length > 0
      ? "+ Show Selections"
      : `+ Add Remark${mappedInfo ? "" : " &amp; Trials"}`;
    return `<tr>
      <td class="vcol-no" contenteditable="false">${no}</td>
      <td class="vcol-act" contenteditable="false">${actCell}</td>
      <td class="vcol-rem" contenteditable="false">
        <button class="view-add-remark-row" data-act-id="${escHtml(actId || "")}"
          data-act-name="${escHtml(actName)}" data-target-name="${escHtml(target.name)}"
          data-is-predefined="${isPredefined}">${addRowLabel}</button>
      </td>
      <td class="vcol-trials" contenteditable="false">&nbsp;</td>
      <td class="vcol-total" contenteditable="false">&nbsp;</td>
      <td class="vcol-score" contenteditable="false">${mappedInfo ? (mappedInfo.pct !== null ? mappedInfo.pct + "%" : "—") : "&nbsp;"}</td>
    </tr>`;
  }
  return remarks.map((rem, ri) => viewRemarkRow(
    ri === 0 ? no : null,
    ri === 0 ? actCell : null,
    rem, target, inlineOptions, sentenceStarter, multiSelect, mappedInfo, remarkHasNote
  )).join("");
}

// Shared by viewRemarkRow/viewGroupRemarkRow (initial render) and
// refreshViewTrialRow/refreshGroupViewTrialRow (surgical in-place update
// after a trial add/delete/score change — see the comment on
// bindViewTrialCellListeners for why those don't go through a full render).
function calcViewTrialSummary(trials, maxPts) {
  const validTrials = (trials || []).filter(t => t !== -1);
  const total       = validTrials.reduce((a, b) => a + b, 0);
  const scorePct    = validTrials.length > 0
    ? Math.round(total / (validTrials.length * maxPts) * 100) + "%" : "";
  return { validTrials, total, scorePct };
}

function buildTrialCellsHtml(rem, maxPts) {
  const allTrials = rem.trials || [];
  return allTrials.map((t, ti) => `
    <span class="trial-cell">
      <select class="view-trial-select" data-rem-id="${escHtml(rem.id)}" data-trial-idx="${ti}">
        <option value="-1"${t === -1 ? " selected" : ""}>—</option>
        ${Array.from({ length: maxPts + 1 }, (_, i) => maxPts - i)
          .map(v => `<option value="${v}"${v === t ? " selected" : ""}>${v}</option>`).join("")}
      </select>
      <button class="view-trial-del" data-rem-id="${escHtml(rem.id)}" data-trial-idx="${ti}">×</button>
    </span>`).join("") +
    `<button class="view-add-trial" data-rem-id="${escHtml(rem.id)}">+</button>`;
}

function viewRemarkRow(no, actName, rem, target, inlineOptions = null, sentenceStarter = null, multiSelect = false, mappedInfo = null, remarkHasNote = false) {
  const maxPts = target.maxPoints || 3;
  const { validTrials, total, scorePct } = calcViewTrialSummary(rem.trials, maxPts);
  const trialCells = mappedInfo
    ? `<span class="view-mapped-label">${escHtml(mappedInfo.label)}</span>`
    : `<div class="trial-cells">${buildTrialCellsHtml(rem, maxPts)}</div>`;
  const totalCell = mappedInfo ? "&nbsp;" : (validTrials.length > 0 ? total : "&nbsp;");
  const scoreDisplay = mappedInfo
    ? (mappedInfo.pct !== null ? mappedInfo.pct + "%" : "—")
    : scorePct;

  const opts = parseOpts(inlineOptions);

  function makeViewOpts(remId, remText) {
    if (opts.length === 0) return null;
    if (multiSelect) {
      const sel = (remText || "").split(", ").map(s => s.trim()).filter(Boolean);
      return `<div class="view-remark-multi-opts" contenteditable="false">${opts.map(opt =>
        `<button class="view-remark-multi-btn${sel.includes(opt) ? " active" : ""}"
          data-rem-id="${escHtml(remId)}" data-opt="${escHtml(opt)}">${escHtml(opt)}</button>`
      ).join("")}</div>`;
    }
    return `<select class="view-remark-preset-select" data-rem-id="${escHtml(remId)}">
        <option value="">— select —</option>
        ${opts.map(opt =>
          `<option value="${escHtml(opt)}"${remText === opt ? " selected" : ""}>${escHtml(opt)}</option>`
        ).join("")}
       </select>`;
  }

  const optSelect = makeViewOpts(rem.id, rem.text)
    || `<textarea class="view-remark-edit" rows="1" data-rem-id="${escHtml(rem.id)}"
          data-saved-html="${escHtml(rem.text || "")}">${escHtml(plainTextForEdit(rem.text))}</textarea>`;

  const noteField = remarkHasNote
    ? `<textarea class="view-mastery-note" rows="1" data-rem-id="${escHtml(rem.id)}"
        data-saved-html="${escHtml(rem.masteryNote || "")}"
        placeholder="Notes…">${escHtml(plainTextForEdit(rem.masteryNote))}</textarea>`
    : "";

  let remarkCell;
  if (sentenceStarter) {
    const starterTopRow = `<span class="view-starter-prefix">${escHtml(sentenceStarter)}</span>
      ${makeViewOpts(rem.id, rem.text)
        || `<input type="text" class="view-starter-input" data-rem-id="${escHtml(rem.id)}"
            value="${escHtml(rem.text || "")}">`
      }`;
    remarkCell = remarkHasNote
      ? `<div class="view-starter-wrap view-starter-wrap-note" contenteditable="false">
          <div class="view-starter-top-row">${starterTopRow}</div>
          ${noteField}
        </div>`
      : `<div class="view-starter-wrap" contenteditable="false">${starterTopRow}</div>`;
  } else {
    remarkCell = optSelect;
  }

  return `<tr>
    <td class="vcol-no" contenteditable="false">${no !== null ? no : ""}</td>
    <td class="vcol-act" contenteditable="false">${actName !== null ? actName : ""}</td>
    <td class="vcol-rem">${remarkCell}</td>
    <td class="vcol-trials" contenteditable="false">${trialCells}</td>
    <td class="vcol-total" contenteditable="false">${totalCell}</td>
    <td class="vcol-score" contenteditable="false">
      <div style="display:flex;align-items:center;gap:.3rem;justify-content:flex-end">
        <span>${scoreDisplay}</span>
        <button class="view-rem-del" data-rem-id="${escHtml(rem.id)}" title="Delete remark">×</button>
      </div>
    </td>
  </tr>`;
}

function viewGetRemarks(data, actId) {
  return Object.entries(data.remarks || {})
    .filter(([, r]) => r.activityId === actId)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .map(([id, r]) => ({ id, ...r }));
}

// visited guards against a circular mapping chain recursing forever — see
// calcDaysAverage's comment (this is the View-screen counterpart, working off
// a passed-in `data` snapshot instead of the live session's global state, so
// it doubles as both the individual and group View/Edit Past Sessions calc).
// Group sessions fold in each attendee's own per-attendee mapped score
// separately (one push per attendee with a remark on the activity) rather
// than a single blended number, per the boss's "per-attendee" decision —
// detected via data.attendees, same signal already used elsewhere for group
// session data.
function calcViewDayAvg(data, target, visited = new Set()) {
  if (visited.has(target.id)) return null;
  visited.add(target.id);

  const attendees = data.attendees || state.viewGroup?.students || null;
  const avgs = [];
  Object.entries(data.activities || {})
    .filter(([, a]) => a.targetName === target.name)
    .forEach(([actId, act]) => {
      const pa = (target.predefinedActivities || []).find(p => p.isMapped && p.name === act.activityName);
      if (pa) {
        const mappedTarget = pa.mappedTargetId
          ? (state.viewGroup?.targets || state.viewStudent?.targets || []).find(t => t.id === pa.mappedTargetId)
          : null;
        if (!mappedTarget) return;
        if (attendees) {
          attendees.forEach(studentName => {
            const hasRemark = Object.values(data.remarks || {})
              .some(r => r.activityId === actId && r.studentName === studentName);
            if (!hasRemark) return;
            const pct = calcGroupStudentDaysAverage(mappedTarget, data, studentName, visited);
            if (pct !== null) avgs.push(pct);
          });
        } else {
          if (viewGetRemarks(data, actId).length === 0) return;
          const pct = calcViewDayAvg(data, mappedTarget, visited);
          if (pct !== null) avgs.push(pct);
        }
        return;
      }
      viewGetRemarks(data, actId).forEach(rem => {
        const trials = (rem.trials || []).filter(t => t !== -1);
        if (!trials.length) return;
        avgs.push(trials.reduce((a, b) => a + b, 0) / (trials.length * (target.maxPoints || 3)) * 100);
      });
    });
  return avgs.length ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null;
}

// Resolves a mapped-score activity's display on the individual View/Edit Past
// Sessions screen — see resolveMappedScoreDisplay (live-entry counterpart).
function resolveViewMappedScoreDisplay(pa, data, visited) {
  const mappedTarget = pa.mappedTargetId
    ? getViewEffectiveTargets().find(t => t.id === pa.mappedTargetId)
    : null;
  if (!mappedTarget) return { label: "Score (Not Mapped Yet)", pct: null };
  return {
    label: `Score (Mapped to ${mappedTarget.name}'s Average)`,
    pct: calcViewDayAvg(data, mappedTarget, visited)
  };
}

// View/Edit Past Sessions counterpart of autoFillMappedRemarks (live-entry
// session) — same trigger (mapped target gained a computable average), but
// runs on every snapshot here since this screen has no "first load" gate and
// the mapped-to target's data could change at any time while it's open.
async function autoFillViewMappedRemarks(student, sessionId, data) {
  let count = 0;
  for (const target of (student.targets || [])) {
    for (const pa of (target.predefinedActivities || [])) {
      if (pa.isCompleted || pa.isArchived || pa.isStopped || pa.isMaintain || pa.isMaintainHeading) continue;
      if (!pa.isMapped) continue;

      const existingAct = Object.entries(data.activities || {})
        .find(([, a]) => a.targetName === target.name && a.activityName === pa.name);
      let actId = existingAct?.[0] || null;

      if (actId) {
        const hasRemark = Object.values(data.remarks || {}).some(r => r.activityId === actId);
        if (hasRemark) continue;
      }

      const key = `${sessionId}:${target.name}:${pa.name}`;
      if (mappedRemarkAutoFillInFlight.has(key)) continue;
      mappedRemarkAutoFillInFlight.add(key);
      try {
        if (!actId) {
          actId = await addActivity(sessionId, target.name, pa.name, pa.order ?? 0, true);
        }
        await addRemark(sessionId, actId, "");
        count++;
      } finally {
        mappedRemarkAutoFillInFlight.delete(key);
      }
    }
  }
  return count;
}

// Resolves a mapped-score activity's display for one attendee on the group
// View/Edit Past Sessions screen — see resolveGroupMappedScoreDisplay
// (live-entry counterpart). Per-attendee throughout, per the boss's decision.
function resolveViewGroupMappedScoreDisplay(pa, data, studentName, visited) {
  const mappedTarget = pa.mappedTargetId
    ? getViewGroupEffectiveTargets().find(t => t.id === pa.mappedTargetId)
    : null;
  if (!mappedTarget) return { label: "Score (Not Mapped Yet)", pct: null };
  return {
    label: `Score (Mapped to ${mappedTarget.name}'s Average)`,
    pct: calcGroupStudentDaysAverage(mappedTarget, data, studentName, visited)
  };
}

// Group View/Edit Past Sessions counterpart of autoFillMappedRemarks — unlike
// the live group entry version, this screen renders every target at once (no
// per-target lazy loading), so it checks all of them on every snapshot, same
// as the individual View screen's autoFillViewMappedRemarks.
async function autoFillViewGroupMappedRemarks(group, sessionId, data) {
  const attendees = data.attendees || (group.students || []).filter(Boolean);
  let count = 0;
  for (const target of (group.targets || [])) {
    for (const pa of (target.predefinedActivities || [])) {
      if (pa.isCompleted || pa.isArchived || pa.isStopped || pa.isMaintain || pa.isMaintainHeading) continue;
      if (!pa.isMapped) continue;
      const existingAct = Object.entries(data.activities || {})
        .find(([, a]) => a.targetName === target.name && a.activityName === pa.name);
      let actId = existingAct?.[0] || null;

      for (const studentName of attendees) {
        const hasRemark = actId && Object.values(data.remarks || {})
          .some(r => r.activityId === actId && r.studentName === studentName);
        if (hasRemark) continue;
        const key = `${sessionId}:${target.name}:${pa.name}:${studentName}`;
        if (mappedRemarkAutoFillInFlight.has(key)) continue;
        mappedRemarkAutoFillInFlight.add(key);
        try {
          if (!actId) {
            actId = await addActivity(sessionId, target.name, pa.name, pa.order ?? 0, true);
          }
          await addGroupRemark(sessionId, actId, studentName, "");
          count++;
        } finally {
          mappedRemarkAutoFillInFlight.delete(key);
        }
      }
    }
  }
  return count;
}

// ── View-screen remark editing ───────────────────────────────
// Replaces the old merged-contenteditable-host saver. The View screens'
// remark/mastery-note boxes are real <textarea> elements now (same as the
// already-proven Session Entry screens via setupEntryRemarkSaving) — native
// Enter/backspace/Ctrl+A all just work per-field, with no nested-
// contenteditable quirks to fight, and no buttons-need-2-clicks issue since
// a normal table of buttons next to normal textareas never needs to
// preventDefault its own mousedown.
//
// counterKey (state.viewActionsInFlight / state.viewGroupActionsInFlight) is
// the same in-flight counter the screen's other action buttons already use
// to keep the background snapshot listener from rendering mid-write. Ghost
// boxes need it too: creating an activity/remark for a box that has none
// yet is multi-step (addActivity, then addRemark), and a render landing
// partway through would destroy this exact textarea — including the
// dataset.creating/actId/remId tracking that lives only on it — leaving a
// fresh-looking ghost box behind. If the user was still typing, that looked
// like the typed text vanishing and then reappearing as a duplicate remark
// a moment later, because the next flush had no way to know a remark was
// already being created for it.
function setupViewRemarkSaving(body, getSessionId, counterKey, onIdle, getData) {
  let saveTimer = null;

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const sid = getSessionId();
    if (!sid) return Promise.resolve();

    const pending = [];
    const trackWrite = p => { pending.push(Promise.resolve(p)); };

    const diffAndSave = (selector, getValue, doSave) => {
      body.querySelectorAll(selector).forEach(el => {
        const value = getValue(el);
        if (el.dataset.savedHtml === value) return;
        el.dataset.savedHtml = value;
        trackWrite(Promise.resolve(doSave(el, value)).catch(err => {
          // savedHtml already says this is saved — if the write actually
          // failed, leaving it pointing at the unsaved value means nothing
          // ever retries it, and the next render (from anything else on the
          // page) shows the server's older text instead, looking exactly
          // like what was just typed silently vanished.
          if (el.dataset.savedHtml === value) el.dataset.savedHtml = " ";
          alert("Couldn't save remark — check your connection and try again.\n\n" + err.message);
        }));
      });
    };

    diffAndSave(".view-remark-edit[data-rem-id]:not(.view-remark-empty)", el => htmlForStorage(el.value),
      (el, html) => updateRemarkText(sid, el.dataset.remId, html));

    diffAndSave(".view-mastery-note[data-rem-id]", el => htmlForStorage(el.value),
      (el, html) => updateRemarkNote(sid, el.dataset.remId, html));

    diffAndSave(".group-remark-input-combined[data-rem-ids]", el => htmlForStorage(el.value),
      (el, html) => {
        const remIds = el.dataset.remIds.split(",").filter(Boolean);
        return Promise.all(remIds.map(id => updateRemarkText(sid, id, html)));
      });

    body.querySelectorAll(".view-remark-empty").forEach(el => {
      const text = el.value.trim();
      // dataset.remId guards against flush() running a second time for this
      // exact box before a re-render ever replaces its markup — e.g. the
      // 700ms debounce timer firing and THEN focusout firing (or vice versa)
      // both call flush(); without this check, the second call sees
      // dataset.creating already reset to "false" by the first call's
      // completion and the same typed text still sitting in the box, and
      // creates a second, duplicate remark with identical text.
      if (!text || el.dataset.creating === "true" || el.dataset.remId) return;
      el.dataset.creating = "true";
      state[counterKey]++;
      const create = async () => {
        try {
          let actId = el.dataset.actId;
          if (!actId) {
            actId = await addActivity(
              sid, el.dataset.target, el.dataset.actName, Date.now(), el.dataset.isPredefined === "true"
            );
          }
          // Group view's empty boxes are scoped to one attendee (data-student);
          // the individual view's aren't.
          const studentName = el.dataset.student;
          const remId = studentName
            ? await addGroupRemark(sid, actId, studentName, text)
            : await addRemark(sid, actId, text);
          el.dataset.actId     = actId;
          el.dataset.remId     = remId;
          el.dataset.savedHtml = htmlForStorage(text);
          // addRemark resolving doesn't mean state.viewSessionData has the new
          // remark yet — the snapshot listener delivers that a beat later.
          // Without waiting here, a render could land in that gap, see "no
          // remark yet" (since this textarea's local dataset tracking lives
          // only on the DOM, not in state), and redraw this exact box back to
          // its empty starting markup — which is what caused the typed text
          // to "vanish" and then get saved a second time as a duplicate when
          // re-typed into the fresh-looking box.
          await waitForSessionData(() => {
            const d = getData?.();
            return !!d?.activities?.[actId] && !!d?.remarks?.[remId];
          });
        } catch (err) {
          // Leaves remId/savedHtml unset — the next flush (next keystroke or
          // focusout) sees "no remark created yet" and retries from scratch,
          // instead of the typed text just sitting there unsaved forever.
          alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
        } finally {
          el.dataset.creating = "false";
          state[counterKey]--;
        }
      };
      trackWrite(create());
    });

    return Promise.all(pending);
  }

  const onInput = e => {
    if (e.target.tagName === "TEXTAREA") autoResizeTextarea(e.target);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flush(); onIdle?.(); }, 700);
  };
  const onFocusOut = () => { flush(); onIdle?.(); };

  body.addEventListener("input", onInput);
  body.addEventListener("focusout", onFocusOut);

  return {
    flush,
    cleanup() {
      clearTimeout(saveTimer);
      body.removeEventListener("input", onInput);
      body.removeEventListener("focusout", onFocusOut);
    }
  };
}

// Same idea as setupViewRemarkSaving, but for the live Session Entry screens
// (#target-content / #group-target-content). The free-text boxes there are
// real <textarea>/<input> elements, not contenteditable — but they're still
// scattered across many activity/remark cards that get torn down and rebuilt
// on every render, so saving is still centralized on the host via debounced
// "input" + "focusout", same as the View screens. flush() returns a Promise
// so callers that are about to read session data to decide what's "empty"
// (switching targets, leaving the session) can await it first instead of
// racing a still-in-flight write.
function setupEntryRemarkSaving(host, getSessionId, onIdle) {
  let saveTimer = null;

  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const sid = getSessionId();
    if (!sid) return Promise.resolve();

    const pending = [];
    const trackWrite = promiseLike => { pending.push(Promise.resolve(promiseLike)); };

    const diffAndSave = (selector, getValue, doSave) => {
      host.querySelectorAll(selector).forEach(el => {
        const value = getValue(el);
        if (el.dataset.savedHtml === value) return;
        el.dataset.savedHtml = value;
        trackWrite(doSave(el, value));
      });
    };

    diffAndSave(".remark-text-input[data-rem-id]", el => htmlForStorage(el.value),
      (el, html) => updateRemarkText(sid, el.dataset.remId, html));

    diffAndSave(".mastery-note-input[data-rem-id]", el => htmlForStorage(el.value),
      (el, html) => updateRemarkNote(sid, el.dataset.remId, html));

    diffAndSave(".activity-name-input[data-act-id]", el => el.value.trim(),
      (el, name) => {
        if (!name) return; // don't persist an emptied-out name; blur reverts the box visually
        el.dataset.original = name;
        return updateActivityName(sid, el.dataset.actId, name);
      });

    diffAndSave(".predef-remark-input-live[data-rem-id]", el => el.value.trim(),
      (el, text) => {
        el.dataset.original = text;
        return updateRemarkText(sid, el.dataset.remId, text);
      });

    diffAndSave(".group-remark-input[data-rem-id]:not(.group-remark-input-empty)", el => htmlForStorage(el.value),
      (el, html) => updateRemarkText(sid, el.dataset.remId, html));

    diffAndSave(".group-remark-input-combined[data-rem-ids]", el => htmlForStorage(el.value),
      (el, html) => {
        const remIds = el.dataset.remIds.split(",").filter(Boolean);
        return Promise.all(remIds.map(id => updateRemarkText(sid, id, html)));
      });

    // Ghost predefined-remark inputs don't have a remark (or sometimes even an
    // activity) yet, so they need to be created first — guarded against
    // double-creation if flush() runs again before the first creation lands.
    host.querySelectorAll(".predef-remark-input[data-pa-name]").forEach(el => {
      const text = el.value.trim();
      if (!text || el.dataset.creating === "true") return;
      el.dataset.creating = "true";
      const create = async () => {
        try {
          const paOrder = el.dataset.paOrder !== "" ? Number(el.dataset.paOrder) : 0;
          const actId = await ensureFedcActivity(el.dataset.target, el.dataset.paName, paOrder);
          const remId = await ensurePredefinedRemark(actId, el.dataset.remName, text);
          await updateRemarkText(sid, remId, text);
        } finally {
          el.dataset.creating = "false";
        }
      };
      trackWrite(create());
    });

    // Free-text empty box for a pending group attendee (see
    // renderGroupStudentEmptyRow) — same "don't write anything until there's
    // real text" guard as above, plus a remId/creating check so a debounce
    // timer firing right after focusout (or vice versa) can't create a
    // second, duplicate remark from the same typed text.
    host.querySelectorAll(".group-remark-input-empty[data-student]").forEach(el => {
      const text = el.value.trim();
      if (!text || el.dataset.creating === "true" || el.dataset.remId) return;
      el.dataset.creating = "true";
      const create = async () => {
        try {
          let actId = el.dataset.actId;
          if (!actId) {
            actId = await addActivity(
              sid, el.dataset.target, el.dataset.actName, Date.now(), el.dataset.isPredefined === "true"
            );
          }
          const remId = await addGroupRemark(sid, actId, el.dataset.student, text);
          el.dataset.actId = actId;
          el.dataset.remId = remId;
          el.dataset.savedHtml = htmlForStorage(text);
        } finally {
          el.dataset.creating = "false";
        }
      };
      trackWrite(create());
    });

    return Promise.all(pending);
  }

  // onIdle re-checks state.renderPending after a save settles, in case a
  // render was deferred for a reason unrelated to typing (dropdown open,
  // active text selection) and is now safe to run.
  const onInput = e => {
    if (e.target.tagName === "TEXTAREA") autoResizeTextarea(e.target);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flush(); onIdle?.(); }, 700);
  };
  const onFocusOut = () => { flush(); onIdle?.(); };

  host.addEventListener("input", onInput);
  host.addEventListener("focusout", onFocusOut);

  return {
    flush,
    cleanup() {
      clearTimeout(saveTimer);
      host.removeEventListener("input", onInput);
      host.removeEventListener("focusout", onFocusOut);
    }
  };
}

// Every previous fix for the caret-disappearing/text-flickering bug tried to
// predict and defer renders that land mid-edit (focus grace windows, write
// cooldowns, etc.) — all still left a timing race on a slow enough
// connection. This closes the gap a different way: instead of trying to
// avoid re-rendering while the user is mid-keystroke, make the re-render
// itself non-destructive. Before a render replaces #target-content's whole
// innerHTML, capture whichever box currently has focus (its identity,
// current — possibly unsaved — value, and caret/selection). After the
// render, if a box with that same identity exists in the fresh markup,
// restore the captured value and re-focus it at the same selection — so a
// render landing at the worst possible moment no longer matters. Real
// <textarea>/<input> elements expose selectionStart/selectionEnd directly,
// so this no longer needs any manual Range/offset math.
const EDITABLE_BOX_SELECTOR =
  ".remark-text-input, .mastery-note-input, .activity-name-input, .predef-remark-input-live, .group-remark-input, .group-remark-input-combined, " +
  ".view-remark-edit, .view-mastery-note, .view-act-edit, .view-starter-input";

function captureActiveEditState(host) {
  const el = document.activeElement;
  if (!el || !host.contains(el)) return null;
  if (el.tagName !== "TEXTAREA" && el.tagName !== "INPUT") return null;
  if (!el.matches(EDITABLE_BOX_SELECTOR)) return null;
  const idAttr = el.dataset.remId ? "remId" : el.dataset.actId ? "actId" : el.dataset.remIds ? "remIds" : null;
  if (!idAttr) return null;
  return {
    className: el.className,
    idAttr,
    idValue: el.dataset[idAttr],
    value: el.value,
    selectionStart: el.selectionStart,
    selectionEnd: el.selectionEnd
  };
}

function restoreActiveEditState(host, captured) {
  if (!captured) return;
  const el = [...host.querySelectorAll(`.${captured.className.split(" ").join(".")}`)]
    .find(e => e.dataset[captured.idAttr] === captured.idValue);
  if (!el) return;
  el.value = captured.value;
  if (el.tagName === "TEXTAREA") autoResizeTextarea(el);
  el.focus();
  el.setSelectionRange(captured.selectionStart, captured.selectionEnd);
}

// Delegated Escape/Ctrl+Enter handling for the individual session-entry
// screen's free-text fields. These are real <textarea>/<input> elements now
// (not contenteditable), so native Enter, backspace and Ctrl+A already work
// correctly per-field without any help — this only needs to cover the app's
// own confirm/cancel shortcuts. MUST be set up once per session-open (not
// per-render) — host is a persistent container whose children get replaced
// on every render, but the host itself never does, so re-attaching this on
// every render would stack up duplicate listeners.
function setupEntryEnterKeyDelegation(host, getTarget) {
  const onKeydown = e => {
    if (e.key !== "Enter" && e.key !== "Escape") return;
    const el = e.target.closest?.(
      ".activity-name-input, #new-activity-textarea, #new-remark-textarea, .predef-remark-input-live"
    );
    if (!el || !host.contains(el)) return;

    if (e.key === "Escape") {
      if (el.id === "new-activity-textarea") cancelPendingActivity();
      return;
    }
    const target = getTarget();
    if (el.matches(".activity-name-input")) {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); el.blur(); }
      return;
    }
    if (el.id === "new-activity-textarea") {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); confirmNewActivity(target); }
      return;
    }
    if (el.id === "new-remark-textarea") {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); saveNewRemark(target); }
      return;
    }
    if (el.matches(".predef-remark-input-live")) {
      e.preventDefault();
      el.blur();
    }
  };
  host.addEventListener("keydown", onKeydown);
  return () => host.removeEventListener("keydown", onKeydown);
}

function getViewMaxPtsForRemark(remId) {
  const data = state.viewSessionData;
  const rem  = data?.remarks?.[remId];
  const act  = rem && data.activities?.[rem.activityId];
  const target = act && getViewEffectiveTargets().find(t => t.name === act.targetName);
  return target?.maxPoints || 3;
}

// Patches just one remark's trial cells/running total/score in place instead
// of going through a full renderSessionView() — a render is safe to do at
// any time now (see isViewBusy/captureActiveEditState), but updating just
// this one row's own cells is still faster and avoids momentarily rebuilding
// anything else on the page for what's normally a quick, repeated action.
// Updating just this row's own cells sidesteps that defer system entirely:
// there's nothing else on the page this could disturb, so it's always safe
// to do immediately, no busy-check needed.
function refreshViewTrialRow(remId) {
  const rem = state.viewSessionData?.remarks?.[remId];
  if (!rem) return;
  const body = $("session-view-body");
  const tr   = body.querySelector(`.view-rem-del[data-rem-id="${remId}"]`)?.closest("tr");
  if (!tr) return;
  const maxPts = getViewMaxPtsForRemark(remId);
  const { validTrials, total, scorePct } = calcViewTrialSummary(rem.trials, maxPts);
  const trialCellsDiv = tr.querySelector(".trial-cells");
  if (trialCellsDiv) {
    trialCellsDiv.innerHTML = buildTrialCellsHtml(rem, maxPts);
    bindViewTrialCellListeners(trialCellsDiv);
  }
  const totalTd = tr.querySelector(".vcol-total");
  if (totalTd) totalTd.innerHTML = validTrials.length > 0 ? String(total) : "&nbsp;";
  const scoreSpan = tr.querySelector(".vcol-score span");
  if (scoreSpan) scoreSpan.textContent = scorePct;
}

// Each trial click fires its own independent Firestore write rather than
// awaiting the previous one (so clicking + repeatedly stays instant) — but
// openSessionView's snapshot listener overwrites state.viewSessionData and
// can trigger a full renderSessionView() the moment it's not "busy",
// regardless of whether every one of those writes has actually landed yet.
// If a render lands using a snapshot that only reflects some of several
// rapid-fire writes, it shows a stale (lower) trial count until the next
// snapshot catches up — visible as cells appearing then disappearing.
// Tracking each write against the same viewActionsInFlight counter the
// snapshot listener already checks defers that render until every write
// here has actually settled, instead of mid-flight.
function trackViewTrialWrite(promise) {
  state.viewActionsInFlight++;
  promise.finally(() => {
    state.viewActionsInFlight--;
    if (state.viewActionsInFlight === 0 && state.viewRenderPending && !isViewBusy()) {
      state.viewRenderPending = false;
      renderSessionView();
    }
  });
}

function bindViewTrialCellListeners(container) {
  container.querySelectorAll(".view-trial-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const rem = state.viewSessionData?.remarks?.[sel.dataset.remId];
      if (!rem) return;
      const prevTrials = rem.trials || [];
      const trials = [...prevTrials];
      trials[Number(sel.dataset.trialIdx)] = Number(sel.value);
      rem.trials = trials;
      refreshViewTrialRow(sel.dataset.remId);
      trackViewTrialWrite(setTrials(state.viewSessionId, sel.dataset.remId, trials).catch(err => {
        rem.trials = prevTrials;
        refreshViewTrialRow(sel.dataset.remId);
        alert("Couldn't update — check your connection and try again.\n\n" + err.message);
      }));
    });
  });

  container.querySelectorAll(".view-trial-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const rem = state.viewSessionData?.remarks?.[btn.dataset.remId];
      if (!rem) return;
      const prevTrials = rem.trials || [];
      const trials = prevTrials.filter((_, i) => i !== Number(btn.dataset.trialIdx));
      rem.trials = trials;
      refreshViewTrialRow(btn.dataset.remId);
      trackViewTrialWrite(setTrials(state.viewSessionId, btn.dataset.remId, trials).catch(err => {
        rem.trials = prevTrials;
        refreshViewTrialRow(btn.dataset.remId);
        alert("Couldn't update — check your connection and try again.\n\n" + err.message);
      }));
    });
  });

  container.querySelectorAll(".view-add-trial").forEach(btn => {
    btn.addEventListener("click", () => {
      const rem = state.viewSessionData?.remarks?.[btn.dataset.remId];
      if (!rem) return;
      const prevTrials = rem.trials || [];
      const trials = [...prevTrials, -1];
      rem.trials = trials;
      refreshViewTrialRow(btn.dataset.remId);
      trackViewTrialWrite(setTrials(state.viewSessionId, btn.dataset.remId, trials).catch(err => {
        rem.trials = prevTrials;
        refreshViewTrialRow(btn.dataset.remId);
        alert("Couldn't add trial — check your connection and try again.\n\n" + err.message);
      }));
    });
  });
}

function showViewAddRemarkPicker(targetName) {
  const data = state.viewSessionData;
  const choices = Object.entries(data.activities || {})
    .filter(([actId, a]) => a.targetName === targetName && viewGetRemarks(data, actId).length > 0)
    .map(([actId, a]) => ({ actId, name: a.activityName }));

  $("session-picker-title").textContent = "Add Remark & Trials to which Activity?";
  $("session-picker-list").innerHTML = choices.length
    ? `<div class="choice-list">` + choices.map(c => `
        <button class="choice-btn view-add-remark-choice" data-act-id="${escHtml(c.actId)}">
          <div class="choice-text"><div class="choice-label">${escHtml(c.name)}</div></div>
        </button>`).join("") + `</div>`
    : `<p class="empty-hint">No activities with a remark yet — use the + under an activity's Trials column to start one.</p>`;
  $("session-picker-modal").classList.remove("hidden");

  $("session-picker-list").querySelectorAll(".view-add-remark-choice").forEach(btn => {
    btn.addEventListener("click", () => {
      const actId = btn.dataset.actId;
      closeSessionPicker();
      const remId = generateId("r");
      state.viewSessionData.remarks = state.viewSessionData.remarks || {};
      state.viewSessionData.remarks[remId] = { activityId: actId, text: "", trials: [], order: Date.now() };
      renderViewOrDefer("viewRenderPending", isViewBusy, renderSessionView);
      addRemark(state.viewSessionId, actId, "", null, remId).catch(err => {
        delete state.viewSessionData.remarks[remId];
        renderViewOrDefer("viewRenderPending", isViewBusy, renderSessionView);
        alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
      });
    });
  });
}

function attachViewListeners() {
  const body = $("session-view-body");

  body.querySelectorAll("textarea.view-remark-edit, textarea.view-mastery-note").forEach(autoResizeTextarea);

  bindViewTrialCellListeners(body);

  body.querySelectorAll(".view-add-remark-target").forEach(btn => {
    btn.addEventListener("click", () => showViewAddRemarkPicker(btn.dataset.target));
  });

  // ── Sketch board buttons (view screen) ────────────────────
  body.querySelectorAll(".btn-sketch[data-rem-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.remId;
      const field = body.querySelector(`.view-remark-edit[data-rem-id="${id}"]`)
                 || body.querySelector(`.view-mastery-note[data-rem-id="${id}"]`);
      if (field) openTextEditorSheet(field);
    });
  });

  // Saving for .view-remark-edit / .view-remark-empty / .view-mastery-note is
  // handled by the shared host saver (state.viewRemarkSaver) set up once in
  // openSessionView, not here — this function runs on every render, and the
  // body persists across renders, so attaching per-box listeners here would
  // stack up duplicates.

  // These three handlers update state.viewSessionData synchronously (not
  // just the DOM/Firestore) before awaiting the write — leaveSessionView()
  // reads state.viewSessionData straight off a captured snapshot on the way
  // out with no guard for an in-flight write, so without this, leaving the
  // screen right after a click could see the OLD value and let
  // cleanupEmptyEntries() delete a remark the boss just set.
  body.querySelectorAll(".view-remark-preset-select").forEach(sel => {
    sel.addEventListener("change", withViewAction("viewActionsInFlight", "viewRenderPending", isViewBusy, renderSessionView, async () => {
      if (!sel.value) return;
      const rem = state.viewSessionData?.remarks?.[sel.dataset.remId];
      const prevText = rem?.text;
      if (rem) rem.text = sel.value;
      try {
        await updateRemarkText(state.viewSessionId, sel.dataset.remId, sel.value);
      } catch (err) {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      }
    }));
  });

  body.querySelectorAll(".view-remark-multi-btn").forEach(btn => {
    btn.addEventListener("click", withViewAction("viewActionsInFlight", "viewRenderPending", isViewBusy, renderSessionView, async () => {
      btn.classList.toggle("active");
      const container = btn.closest(".view-remark-multi-opts");
      const selected = [...container.querySelectorAll(".view-remark-multi-btn.active")].map(b => b.dataset.opt);
      const newText = selected.join(", ");
      const rem = state.viewSessionData?.remarks?.[btn.dataset.remId];
      const prevText = rem?.text;
      if (rem) rem.text = newText;
      try {
        await updateRemarkText(state.viewSessionId, btn.dataset.remId, newText);
      } catch (err) {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      }
    }));
  });

  body.querySelectorAll(".view-starter-input").forEach(input => {
    input.addEventListener("blur", async () => {
      const rem = state.viewSessionData?.remarks?.[input.dataset.remId];
      if (!rem || input.value === (rem.text || "")) return;
      const prevText = rem.text;
      rem.text = input.value;
      try {
        await updateRemarkText(state.viewSessionId, input.dataset.remId, input.value);
      } catch (err) {
        rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      }
    });
  });

  body.querySelectorAll(".view-remark-new").forEach(ta => {
    ta.addEventListener("blur", async () => {
      const text = ta.value.trim();
      if (!text) return;
      let actId = ta.dataset.actId;
      if (!actId) actId = await addActivity(state.viewSessionId, ta.dataset.targetName, ta.dataset.actName, Date.now(), true);
      await addRemark(state.viewSessionId, actId, text, null);
    });
  });

  body.querySelectorAll(".view-add-trial-new").forEach(btn => {
    btn.addEventListener("click", withViewAction("viewActionsInFlight", "viewRenderPending", isViewBusy, renderSessionView, async () => {
      let actId = btn.dataset.actId;
      if (!actId) {
        actId = await addActivity(
          state.viewSessionId, btn.dataset.targetName, btn.dataset.actName, Date.now(),
          btn.dataset.isPredefined === "true"
        );
      }
      const remId = await addRemark(state.viewSessionId, actId, "", null);
      await setTrials(state.viewSessionId, remId, [-1]);
      await waitForSessionData(() => !!state.viewSessionData?.remarks?.[remId]?.trials?.length);
    }));
  });

  // "+ Add Remark" for preset-option/sentence-starter activities with
  // no remark yet — these don't get the typeable empty box (there's no free
  // text to click into), so without this the Remark cell is just blank with
  // no way to create the first remark at all.
  // Writes to local state and renders immediately (optimistic) instead of
  // awaiting both Firestore round trips first — addActivity/addRemark are
  // handed the same ids used locally so the writes settle into the exact
  // same keys once the snapshot listener catches up, with no mismatch.
  body.querySelectorAll(".view-add-remark-row").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const data       = state.viewSessionData;
      const targetName = btn.dataset.targetName;
      const actName    = btn.dataset.actName;
      const isPredef   = btn.dataset.isPredefined === "true";
      const isNewAct   = !btn.dataset.actId;
      const actId      = btn.dataset.actId || generateId("a");
      const remId      = generateId("r");
      const actOrder   = Date.now();
      data.activities = data.activities || {};
      data.remarks    = data.remarks || {};
      if (isNewAct) {
        data.activities[actId] = { targetName, activityName: actName, order: actOrder, isPredefined: isPredef };
      }
      data.remarks[remId] = { activityId: actId, text: "", trials: [], order: actOrder };
      renderSessionView();
      (async () => {
        try {
          if (isNewAct) await addActivity(state.viewSessionId, targetName, actName, actOrder, isPredef, actId);
          await addRemark(state.viewSessionId, actId, "", null, remId);
        } catch (err) {
          if (isNewAct) delete data.activities[actId];
          delete data.remarks[remId];
          renderSessionView();
          alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
        }
      })();
    });
  });

  body.querySelectorAll(".view-act-edit").forEach(input => {
    input.addEventListener("blur", async () => {
      const newName = input.value.trim();
      if (!newName || newName === input.dataset.original) return;
      if (!input.dataset.actId) return;
      input.dataset.original = newName;
      await updateActivityName(state.viewSessionId, input.dataset.actId, newName);
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    });
  });

  body.querySelectorAll(".view-act-del").forEach(btn => {
    btn.addEventListener("click", withViewAction("viewActionsInFlight", "viewRenderPending", isViewBusy, renderSessionView, async () => {
      if (!confirm("Delete this activity and all its remarks?")) return;
      const actId = btn.dataset.actId;
      if (!actId) return;
      const remIds = viewGetRemarks(state.viewSessionData, actId).map(r => r.id);
      await deleteActivity(state.viewSessionId, actId, remIds);
    }));
  });

  body.querySelectorAll(".view-rem-del").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("Delete this remark?")) return;
      const remId = btn.dataset.remId;
      const rem = state.viewSessionData?.remarks?.[remId];
      if (!rem) return;
      delete state.viewSessionData.remarks[remId];
      renderViewOrDefer("viewRenderPending", isViewBusy, renderSessionView);
      deleteRemark(state.viewSessionId, remId).catch(err => {
        state.viewSessionData.remarks[remId] = rem;
        renderViewOrDefer("viewRenderPending", isViewBusy, renderSessionView);
        alert("Couldn't delete remark — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  body.querySelectorAll(".view-comment-edit").forEach(ta => {
    ta.addEventListener("blur", async () => {
      const key    = ta.dataset.targetKey;
      const target = getViewEffectiveTargets().find(t => sanitizeKey(t.name) === key);
      if (!target) return;
      const current = (state.viewSessionData?.fedcComments || {})[key] || "";
      if (ta.value === current) return;
      await updateFedcComment(state.viewSessionId, target.name, ta.value);
    });
  });

}

// ============================================================
// GROUP SESSION VIEW (table-based view/edit of a past group session)
// Mirrors the individual screen-session-view above, with an added
// Student column and "Combine/Separate Remarks" support per activity.
// ============================================================

function getViewGroupEffectiveTargets() {
  return state.viewGroup?.targets || [];
}

async function openGroupSessionView(group, sessionId) {
  commitTextEditorSheet();
  state.viewGroup              = group;
  state.viewGroupSessionId     = sessionId;
  state.viewGroupSessionData   = null;
  state.viewGroupRenderPending = false;
  state.viewGroupActionsInFlight = 0;

  showScreen("screen-group-session-view");
  $("group-view-group-name").textContent = group.name;
  $("group-view-session-meta").textContent = "";
  $("group-session-view-body").innerHTML = `<div class="loading">Loading…</div>`;

  if (state.fbViewGroupUnsubscribe) { state.fbViewGroupUnsubscribe(); state.fbViewGroupUnsubscribe = null; }

  state.viewGroupRemarkSaver?.cleanup();
  state.viewGroupRemarkSaver = setupViewRemarkSaving($("group-session-view-body"), () => state.viewGroupSessionId, "viewGroupActionsInFlight", () => {
    if (!state.viewGroupRenderPending || isGroupViewBusy() || state.viewGroupActionsInFlight > 0) return;
    state.viewGroupRenderPending = false;
    renderGroupSessionView();
  }, () => state.viewGroupSessionData);

  try {
    state.fbViewGroupUnsubscribe = listenToSession(sessionId, async data => {
      state.viewGroupSessionData = data;
      try {
        const filled = await autoFillViewGroupMappedRemarks(group, sessionId, data);
        if (filled > 0) return; // the write triggers another snapshot, which renders
      } catch (err) { console.error("autoFillViewGroupMappedRemarks failed:", err); }
      if (isGroupViewBusy() || state.viewGroupActionsInFlight > 0) { state.viewGroupRenderPending = true; }
      else                   { renderGroupSessionView(); }
    });
  } catch (err) {
    $("group-session-view-body").innerHTML =
      `<div class="error-msg">Could not load session.<br>${escHtml(err.message)}</div>`;
  }
}

async function leaveGroupSessionView() {
  commitTextEditorSheet();
  $("text-editor-sheet").classList.add("hidden");
  $("btn-group-delete-session")?.classList.add("hidden");
  $("btn-group-goto-session")?.classList.add("hidden");
  // See the matching comment in leaveSessionView() — flush (and await it)
  // before unsubscribing, not after, so the listener is still alive to
  // reflect the flushed write into state.viewGroupSessionData before the
  // cleanup below reads it.
  await state.viewGroupRemarkSaver?.flush();
  if (state.fbViewGroupUnsubscribe) { state.fbViewGroupUnsubscribe(); state.fbViewGroupUnsubscribe = null; }
  state.viewGroupRemarkSaver?.cleanup();
  state.viewGroupRemarkSaver = null;
  const sessionId = state.viewGroupSessionId;
  const data      = state.viewGroupSessionData;
  const group     = state.viewGroup;
  state.viewGroupSessionId     = null;
  state.viewGroupSessionData   = null;
  state.viewGroup               = null;
  state.viewGroupRenderPending = false;
  state.viewGroupActionsInFlight = 0;

  if (sessionId && data) {
    const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
    const currentTargetNames = new Set((group?.targets || []).map(t => t.name));
    const fedcHasData = Object.values(data.fedcComments || {}).some(c => stripEmpty(c).length > 0);
    const remarkHasData = Object.values(data.remarks || {}).some(r => {
      const act = (data.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      return stripEmpty(r.text).length > 0
        || (r.trials || []).some(t => t !== null && t !== -1)
        || stripEmpty(r.masteryNote).length > 0;
    });
    if (!fedcHasData && !remarkHasData) {
      deleteSession(sessionId).catch(() => {});
    } else {
      const allTargetNames = new Set(Object.values(data.activities || {}).map(a => a.targetName));
      allTargetNames.forEach(name => {
        const target = (group?.targets || []).find(t => t.name === name);
        cleanupEmptyEntries(sessionId, data, name, target).catch(() => {});
      });
    }
  }

  showHome();
}

$("btn-group-view-back").addEventListener("click", leaveGroupSessionView);

function renderGroupSessionView() {
  const data  = state.viewGroupSessionData;
  const group = state.viewGroup;
  if (!data || !group) return;

  $("group-view-session-meta").innerHTML =
    `Session ${data.sessionNumber}: ${formatDateWithDay(data.date)}${relativeDaySuffix(data.date)}`
    + ` <button class="btn-edit-session-date">Edit Date</button>`;

  const delBtn = $("btn-group-delete-session");
  if (delBtn) delBtn.classList.remove("hidden");

  $("group-view-session-meta").querySelector(".btn-edit-session-date").addEventListener("click", () => {
    showEditGroupDatePicker();
  });

  const gotoBtn = $("btn-group-goto-session");
  if (gotoBtn) {
    gotoBtn.classList.remove("hidden");
    gotoBtn.onclick = () => showGoToAnotherGroupSession(state.viewGroup);
  }

  // Wire delete button (static element in header — re-attach each time)
  const _delBtn = $("btn-group-delete-session");
  if (_delBtn) {
    const newDelBtn = _delBtn.cloneNode(true); // remove old listeners
    newDelBtn.classList.remove("hidden");
    _delBtn.replaceWith(newDelBtn);
    newDelBtn.addEventListener("click", async () => {
      const typed = prompt(`Delete Session ${data.sessionNumber} of ${data.month.split(" ")[0]} (${formatDate(data.date)})?\n\nThis cannot be undone. Type DELETE to confirm:`);
      if (typed !== "DELETE") return;
      const sid = state.viewGroupSessionId;
      leaveGroupSessionView();
      await deleteSession(sid).catch(() => {});
    });
  }

  const attendees = data.attendees || (group.students || []).filter(Boolean);
  const targets   = getViewGroupEffectiveTargets();
  const sorted    = sortTargetsByOrder(targets);

  const body = $("group-session-view-body");
  const scrollTop = body.scrollTop;
  const captured = captureActiveEditState(body);
  body.innerHTML = sorted.length
    ? sorted.map(t => buildGroupTargetViewTable(t, data, attendees)).join("")
    : `<p style="color:var(--text-muted);padding:1rem">No targets recorded.</p>`;

  attachGroupViewListeners();
  restoreActiveEditState(body, captured);
  body.scrollTop = scrollTop;
}

// Pairs each attending student's remarks for one activity into "rounds" by creation order,
// with a { studentName, pending: true } placeholder for any attendee with no entry yet in that round.
function viewGroupGetRounds(data, actId, attendees) {
  const byStudent = {};
  for (const studentName of attendees) {
    byStudent[studentName] = Object.entries(data.remarks || {})
      .filter(([, r]) => r.activityId === actId && r.studentName === studentName)
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
      .map(([id, r]) => ({ id, ...r }));
  }
  const maxRounds = Math.max(...Object.values(byStudent).map(arr => arr.length), 0);
  const rounds = [];
  for (let i = 0; i < maxRounds; i++) {
    rounds.push(attendees.map(studentName => {
      const rem = byStudent[studentName][i];
      return rem ? { studentName, ...rem } : { studentName, pending: true };
    }));
  }
  return rounds;
}

function groupAttendeeLabel(studentName) {
  return escHtml(firstNameOf(studentName));
}

function buildGroupTargetViewTable(target, data, attendees) {
  // Per-attendee, not one blended figure — a group's two students can be at
  // very different stages, so a single combined "Day's Average" would hide
  // that. See calcGroupStudentDaysAverage (shared with the live-entry screen).
  const studentAvgs = attendees
    .map(studentName => ({ studentName, pct: calcGroupStudentDaysAverage(target, data, studentName, new Set()) }))
    .filter(sa => sa.pct !== null);

  let rows = "";
  if (target.predefinedActivities?.length > 0) {
    let no = 0;
    for (const pa of target.predefinedActivities) {
      if (pa.isHeading) {
        rows += `<tr class="view-heading-row"><td colspan="7" contenteditable="false">${escHtml(pa.name)}</td></tr>`;
        continue;
      }
      if (pa.isNote) {
        rows += `<tr class="view-note-row"><td colspan="7" contenteditable="false">${noteToHtml(pa.text)}</td></tr>`;
        continue;
      }
      no++;
      const entry = Object.entries(data.activities || {})
        .find(([, a]) => a.targetName === target.name && a.activityName === pa.name);
      rows += viewGroupActivityRows(no, pa.name, entry?.[0] || null, data, target, attendees, true);
    }
    Object.entries(data.activities || {})
      .filter(([, a]) => a.targetName === target.name && !a.isPredefined)
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
      .forEach(([actId, act]) => {
        no++;
        rows += viewGroupActivityRows(no, act.activityName, actId, data, target, attendees, false);
      });
  } else {
    let no = 0;
    Object.entries(data.activities || {})
      .filter(([, a]) => a.targetName === target.name)
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
      .forEach(([actId, act]) => {
        no++;
        rows += viewGroupActivityRows(no, act.activityName, actId, data, target, attendees, false);
      });
  }

  if (target.hasComment) {
    const key     = sanitizeKey(target.name);
    const comment = (data.fedcComments || {})[key] || "";
    rows += `<tr class="view-comment-row">
      <td colspan="3" class="view-comment-label" contenteditable="false">Comment</td>
      <td colspan="4" contenteditable="false">
        <textarea class="view-comment-edit" data-target-key="${escHtml(key)}" rows="3"
        >${escHtml(comment)}</textarea>
      </td>
    </tr>`;
  }

  if (studentAvgs.length > 0) {
    rows += studentAvgs.map(sa => `<tr class="view-dayavg-row">
      <td colspan="6" style="text-align:right" contenteditable="false">Day's Average (${escHtml(firstNameOf(sa.studentName))})</td>
      <td class="vcol-score" contenteditable="false">${sa.pct}%</td>
    </tr>`).join("");
  }

  return `<div class="target-view-section">
    <div class="target-view-header" contenteditable="false">
      <span class="target-view-name">${escHtml(target.name)}</span>
      ${studentAvgs.map(sa => `<span class="target-view-avg">${escHtml(firstNameOf(sa.studentName))}: ${sa.pct}%</span>`).join("")}
    </div>
    <div class="view-table-wrapper">
      <table class="view-table">
        <thead><tr>
          <th class="vcol-no">No.</th>
          <th class="vcol-act">Activity</th>
          <th class="vcol-student">Student</th>
          <th class="vcol-rem">Remark</th>
          <th class="vcol-trials">Trials</th>
          <th class="vcol-total">Total</th>
          <th class="vcol-score">% Score</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function viewGroupActivityRows(no, actName, actId, data, target, attendees, isPredefined = true) {
  const rounds = actId ? viewGroupGetRounds(data, actId, attendees) : [];
  const combineFlagForAct = !!(actId && data.activities?.[actId]?.combineRemarks);

  const paEntry = isPredefined
    ? target.predefinedActivities?.find(pa => pa.name === actName)
    : null;

  const actCell = isPredefined
    ? formatActivityMarkup(actName) + (paEntry?.actNote?.trim() ? `<div class="view-act-note">${formatActivityMarkup(paEntry.actNote)}</div>` : "")
    : `<div style="display:flex;align-items:center;gap:.3rem">
        <input class="view-act-edit" type="text" value="${escHtml(actName)}"
          data-act-id="${escHtml(actId || "")}" data-original="${escHtml(actName)}" />
        <button class="view-act-del" data-act-id="${escHtml(actId || "")}"
          data-target-name="${escHtml(target.name)}" title="Delete activity">×</button>
       </div>`;

  // Mapped-score activities have no trials/combine-remarks concept — bypass
  // the rounds/combine machinery entirely and list every attendee's own
  // remark + their own per-attendee mapped score (see renderGroupActivityCard's
  // live-entry counterpart for the same per-attendee bypass).
  if (paEntry?.isMapped) {
    const mappedInlineOptions   = getActivityInlineOptions(paEntry);
    const mappedSentenceStarter = paEntry.sentenceStarter || null;
    const mappedMultiSelect     = paEntry.optionsMulti || false;
    const mappedHasNote         = paEntry.remarkHasNote || false;
    let firstRow = true;
    return attendees.map(studentName => {
      const remarks = actId
        ? Object.entries(data.remarks || {})
            .filter(([, r]) => r.activityId === actId && r.studentName === studentName)
            .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
            .map(([id, r]) => ({ id, ...r }))
        : [];
      const noVal  = firstRow ? no : null;
      const actVal = firstRow ? actCell : null;
      firstRow = false;
      if (remarks.length === 0) {
        return `<tr>
          <td class="vcol-no" contenteditable="false">${noVal !== null ? noVal : ""}</td>
          <td class="vcol-act" contenteditable="false">${actVal !== null ? actVal : ""}</td>
          <td class="vcol-student" contenteditable="false">${groupAttendeeLabel(studentName)}</td>
          <td class="vcol-rem" contenteditable="false">
            <button class="btn-view-group-add-remark-mapped-pending" data-act-id="${escHtml(actId || "")}"
              data-act-name="${escHtml(actName)}" data-target-name="${escHtml(target.name)}"
              data-student="${escHtml(studentName)}">+ Add Remark</button>
          </td>
          <td class="vcol-trials" contenteditable="false">&nbsp;</td>
          <td class="vcol-total" contenteditable="false">&nbsp;</td>
          <td class="vcol-score" contenteditable="false">&nbsp;</td>
        </tr>`;
      }
      const mappedInfo = resolveViewGroupMappedScoreDisplay(paEntry, data, studentName);
      return remarks.map((rem, ri) => viewGroupRemarkRow(
        ri === 0 ? noVal : null, ri === 0 ? actVal : null, studentName, rem, target,
        mappedInlineOptions, mappedSentenceStarter, mappedMultiSelect, null, mappedInfo, mappedHasNote
      )).join("");
    }).join("");
  }

  const combineToggle = actId
    ? `<button class="btn-combine-toggle${combineFlagForAct ? " active" : ""}" data-act-id="${escHtml(actId)}">
        ${combineFlagForAct ? "Combined Remarks" : "Separate Remarks"}
      </button>`
    : "";
  const actCellWithToggle = `<div class="view-act-cell-row"><span>${actCell}</span>${combineToggle}</div>`;

  const inlineOptions   = paEntry ? getActivityInlineOptions(paEntry) : null;
  const sentenceStarter = paEntry?.sentenceStarter || null;
  const multiSelect     = paEntry?.optionsMulti || false;
  const remarkHasNote   = paEntry?.remarkHasNote || false;
  const opts            = parseOpts(inlineOptions);

  if (rounds.length === 0) {
    // Free-text activities (no presets): show a ready-to-type empty box per
    // attendee, like the individual screen does, instead of a generic "+ Add
    // Remark & Trials" bulk button — this activity is already in "Separate
    // Remarks" mode, so each student gets their own row from the start.
    const showEmpty = opts.length === 0;

    if (showEmpty) {
      // "+ " shows even with no remark yet — see the individual screen's
      // viewActivityRows for why (lets a score be logged without first
      // typing a remark).
      return attendees.map((studentName, idx) => `<tr>
        <td class="vcol-no" contenteditable="false">${idx === 0 ? no : ""}</td>
        <td class="vcol-act" contenteditable="false">${idx === 0 ? actCellWithToggle : ""}</td>
        <td class="vcol-student" contenteditable="false">${groupAttendeeLabel(studentName)}</td>
        <td class="vcol-rem">
          <textarea class="view-remark-edit view-remark-empty" rows="1"
            data-act-id="${escHtml(actId || "")}"
            data-act-name="${escHtml(actName)}"
            data-target="${escHtml(target.name)}"
            data-is-predefined="${isPredefined}"
            data-student="${escHtml(studentName)}"></textarea>
        </td>
        <td class="vcol-trials" contenteditable="false">
          <button class="view-group-add-trial-new" data-act-id="${escHtml(actId || "")}"
            data-act-name="${escHtml(actName)}" data-target-name="${escHtml(target.name)}"
            data-is-predefined="${isPredefined}" data-student="${escHtml(studentName)}">+</button>
        </td>
        <td class="vcol-total" contenteditable="false">&nbsp;</td>
        <td class="vcol-score" contenteditable="false">&nbsp;</td>
      </tr>`).join("");
    }

    const addAllLabel = opts.length > 0 ? "+ Show Selections" : "+ Add Remark &amp; Trials";
    return `<tr>
      <td class="vcol-no" contenteditable="false">${no}</td>
      <td class="vcol-act" contenteditable="false">${actCellWithToggle}</td>
      <td class="vcol-student" contenteditable="false"></td>
      <td class="vcol-rem" contenteditable="false">
        <button class="btn-view-group-add-remark-all" data-act-id="${escHtml(actId || "")}"
          data-act-name="${escHtml(actName)}" data-target-name="${escHtml(target.name)}">${addAllLabel}</button>
      </td>
      <td class="vcol-trials" contenteditable="false">&nbsp;</td>
      <td class="vcol-total" contenteditable="false">&nbsp;</td>
      <td class="vcol-score" contenteditable="false">&nbsp;</td>
    </tr>`;
  }

  let firstRowOverall = true;
  let html = "";
  for (const round of rounds) {
    const presentEntries  = round.filter(e => !e.pending);
    const combineThisRound = combineFlagForAct && presentEntries.length > 1;
    const sharedRemIds     = combineThisRound ? presentEntries.map(e => e.id) : null;
    const sharedText       = combineThisRound ? presentEntries[0].text : null;
    let usedRowspanCell    = false;

    for (const entry of round) {
      const noVal  = firstRowOverall ? no : null;
      const actVal = firstRowOverall ? actCellWithToggle : null;

      if (entry.pending) {
        // Free-text activities (no presets) get a ready-to-type empty box
        // here too, same as the "nobody has a remark yet" case below — only
        // preset-option/sentence-starter activities (which have no typeable
        // free text) still need an explicit button.
        if (opts.length === 0) {
          html += `<tr>
            <td class="vcol-no" contenteditable="false">${noVal !== null ? noVal : ""}</td>
            <td class="vcol-act" contenteditable="false">${actVal !== null ? actVal : ""}</td>
            <td class="vcol-student" contenteditable="false">${groupAttendeeLabel(entry.studentName)}</td>
            <td class="vcol-rem">
              <textarea class="view-remark-edit view-remark-empty" rows="1"
                data-act-id="${escHtml(actId || "")}"
                data-act-name="${escHtml(actName)}"
                data-target="${escHtml(target.name)}"
                data-is-predefined="${isPredefined}"
                data-student="${escHtml(entry.studentName)}"></textarea>
            </td>
            <td class="vcol-trials" contenteditable="false">
              <button class="view-group-add-trial-new" data-act-id="${escHtml(actId || "")}"
                data-act-name="${escHtml(actName)}" data-target-name="${escHtml(target.name)}"
                data-is-predefined="${isPredefined}" data-student="${escHtml(entry.studentName)}">+</button>
            </td>
            <td class="vcol-total" contenteditable="false">&nbsp;</td>
            <td class="vcol-score" contenteditable="false">&nbsp;</td>
          </tr>`;
          firstRowOverall = false;
          continue;
        }
        html += `<tr>
          <td class="vcol-no" contenteditable="false">${noVal !== null ? noVal : ""}</td>
          <td class="vcol-act" contenteditable="false">${actVal !== null ? actVal : ""}</td>
          <td class="vcol-student" contenteditable="false">${groupAttendeeLabel(entry.studentName)}</td>
          <td class="vcol-rem" contenteditable="false">
            <button class="btn-view-group-add-remark-pending" data-act-id="${escHtml(actId || "")}"
              data-student="${escHtml(entry.studentName)}">${opts.length > 0 ? "+ Show Selections" : "+ Add Remark &amp; Trials"}</button>
          </td>
          <td class="vcol-trials" contenteditable="false">&nbsp;</td>
          <td class="vcol-total" contenteditable="false">&nbsp;</td>
          <td class="vcol-score" contenteditable="false">&nbsp;</td>
        </tr>`;
        firstRowOverall = false;
        continue;
      }

      const combineOpts = !combineThisRound ? null
        : usedRowspanCell
          ? { skipRemarkCell: true }
          : { rowspan: presentEntries.length, combinedRemIds: sharedRemIds, sharedText };
      if (combineThisRound) usedRowspanCell = true;

      html += viewGroupRemarkRow(
        noVal, actVal, entry.studentName, entry, target,
        inlineOptions, sentenceStarter, multiSelect, combineOpts, null, remarkHasNote
      );
      firstRowOverall = false;
    }
  }
  return html;
}

function viewGroupRemarkRow(no, actName, studentName, rem, target, inlineOptions = null, sentenceStarter = null, multiSelect = false, combineOpts = null, mappedInfo = null, remarkHasNote = false) {
  const maxPts = target.maxPoints || 3;
  const { validTrials, total, scorePct } = calcViewTrialSummary(rem.trials, maxPts);
  const trialCells = mappedInfo
    ? `<span class="view-mapped-label">${escHtml(mappedInfo.label)}</span>`
    : `<div class="trial-cells">${buildTrialCellsHtml(rem, maxPts)}</div>`;
  const totalCell = mappedInfo ? "&nbsp;" : (validTrials.length > 0 ? total : "&nbsp;");
  const scoreDisplay = mappedInfo
    ? (mappedInfo.pct !== null ? mappedInfo.pct + "%" : "—")
    : scorePct;

  let remarkTd = "";
  if (!combineOpts?.skipRemarkCell) {
    if (combineOpts) {
      // Combined round — one shared plain-text box across remIds (mirrors the live
      // group session editor's "Combined Remarks" mode, which is free-text only).
      const idList = combineOpts.combinedRemIds.join(",");
      remarkTd = `<td class="vcol-rem" rowspan="${combineOpts.rowspan}">
        <textarea class="view-remark-edit group-remark-input-combined" rows="1"
          data-rem-ids="${idList}"
          data-saved-html="${escHtml(combineOpts.sharedText || "")}">${escHtml(plainTextForEdit(combineOpts.sharedText))}</textarea>
      </td>`;
    } else {
      const opts = parseOpts(inlineOptions);

      const makeViewOpts = (remId, remText) => {
        if (opts.length === 0) return null;
        if (multiSelect) {
          const sel = (remText || "").split(", ").map(s => s.trim()).filter(Boolean);
          return `<div class="view-remark-multi-opts" contenteditable="false">${opts.map(opt =>
            `<button class="view-remark-multi-btn${sel.includes(opt) ? " active" : ""}"
              data-rem-id="${escHtml(remId)}" data-opt="${escHtml(opt)}">${escHtml(opt)}</button>`
          ).join("")}</div>`;
        }
        return `<select class="view-remark-preset-select" data-rem-id="${escHtml(remId)}">
            <option value="">— select —</option>
            ${opts.map(opt =>
              `<option value="${escHtml(opt)}"${remText === opt ? " selected" : ""}>${escHtml(opt)}</option>`
            ).join("")}
           </select>`;
      };

      const optSelect = makeViewOpts(rem.id, rem.text)
        || `<textarea class="view-remark-edit" rows="1" data-rem-id="${escHtml(rem.id)}"
              data-saved-html="${escHtml(rem.text || "")}">${escHtml(plainTextForEdit(rem.text))}</textarea>`;

      const noteField = remarkHasNote
        ? `<textarea class="view-mastery-note" rows="1" data-rem-id="${escHtml(rem.id)}"
            data-saved-html="${escHtml(rem.masteryNote || "")}"
            placeholder="Notes…">${escHtml(plainTextForEdit(rem.masteryNote))}</textarea>`
        : "";

      let remarkCell;
      if (sentenceStarter) {
        const starterTopRow = `<span class="view-starter-prefix">${escHtml(sentenceStarter)}</span>
          ${makeViewOpts(rem.id, rem.text)
            || `<input type="text" class="view-starter-input" data-rem-id="${escHtml(rem.id)}"
                value="${escHtml(rem.text || "")}">`
          }`;
        remarkCell = remarkHasNote
          ? `<div class="view-starter-wrap view-starter-wrap-note" contenteditable="false">
              <div class="view-starter-top-row">${starterTopRow}</div>
              ${noteField}
            </div>`
          : `<div class="view-starter-wrap" contenteditable="false">${starterTopRow}</div>`;
      } else {
        remarkCell = optSelect;
      }
      remarkTd = `<td class="vcol-rem">${remarkCell}</td>`;
    }
  }

  return `<tr>
    <td class="vcol-no" contenteditable="false">${no !== null ? no : ""}</td>
    <td class="vcol-act" contenteditable="false">${actName !== null ? actName : ""}</td>
    <td class="vcol-student" contenteditable="false">${groupAttendeeLabel(studentName)}</td>
    ${remarkTd}
    <td class="vcol-trials" contenteditable="false">${trialCells}</td>
    <td class="vcol-total" contenteditable="false">${totalCell}</td>
    <td class="vcol-score" contenteditable="false">
      <div style="display:flex;align-items:center;gap:.3rem;justify-content:flex-end">
        <span>${scoreDisplay}</span>
        <button class="view-rem-del" data-rem-id="${escHtml(rem.id)}" title="Delete remark">×</button>
      </div>
    </td>
  </tr>`;
}

function getGroupViewMaxPtsForRemark(remId) {
  const data = state.viewGroupSessionData;
  const rem  = data?.remarks?.[remId];
  const act  = rem && data.activities?.[rem.activityId];
  const target = act && getViewGroupEffectiveTargets().find(t => t.name === act.targetName);
  return target?.maxPoints || 3;
}

// Group-view counterpart of refreshViewTrialRow — same reasoning applies
// (see its comment): the Trials column's buttons can't blur the shared
// contenteditable host, so a full renderGroupSessionView() after clicking
// one gets deferred by isGroupViewBusy() until something unrelated finally
// blurs the host. Patching just this row sidesteps that entirely.
function refreshGroupViewTrialRow(remId) {
  const rem = state.viewGroupSessionData?.remarks?.[remId];
  if (!rem) return;
  const body = $("group-session-view-body");
  const tr   = body.querySelector(`.view-rem-del[data-rem-id="${remId}"]`)?.closest("tr");
  if (!tr) return;
  const maxPts = getGroupViewMaxPtsForRemark(remId);
  const { validTrials, total, scorePct } = calcViewTrialSummary(rem.trials, maxPts);
  const trialCellsDiv = tr.querySelector(".trial-cells");
  if (trialCellsDiv) {
    trialCellsDiv.innerHTML = buildTrialCellsHtml(rem, maxPts);
    bindGroupViewTrialCellListeners(trialCellsDiv);
  }
  const totalTd = tr.querySelector(".vcol-total");
  if (totalTd) totalTd.innerHTML = validTrials.length > 0 ? String(total) : "&nbsp;";
  const scoreSpan = tr.querySelector(".vcol-score span");
  if (scoreSpan) scoreSpan.textContent = scorePct;
}

// See trackViewTrialWrite's comment — same race, group-view counterpart.
function trackGroupViewTrialWrite(promise) {
  state.viewGroupActionsInFlight++;
  promise.finally(() => {
    state.viewGroupActionsInFlight--;
    if (state.viewGroupActionsInFlight === 0 && state.viewGroupRenderPending && !isGroupViewBusy()) {
      state.viewGroupRenderPending = false;
      renderGroupSessionView();
    }
  });
}

function bindGroupViewTrialCellListeners(container) {
  container.querySelectorAll(".view-trial-select").forEach(sel => {
    sel.addEventListener("change", () => {
      const rem = state.viewGroupSessionData?.remarks?.[sel.dataset.remId];
      if (!rem) return;
      const prevTrials = rem.trials || [];
      const trials = [...prevTrials];
      trials[Number(sel.dataset.trialIdx)] = Number(sel.value);
      rem.trials = trials;
      refreshGroupViewTrialRow(sel.dataset.remId);
      trackGroupViewTrialWrite(setTrials(state.viewGroupSessionId, sel.dataset.remId, trials).catch(err => {
        rem.trials = prevTrials;
        refreshGroupViewTrialRow(sel.dataset.remId);
        alert("Couldn't update — check your connection and try again.\n\n" + err.message);
      }));
    });
  });

  container.querySelectorAll(".view-trial-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const rem = state.viewGroupSessionData?.remarks?.[btn.dataset.remId];
      if (!rem) return;
      const prevTrials = rem.trials || [];
      const trials = prevTrials.filter((_, i) => i !== Number(btn.dataset.trialIdx));
      rem.trials = trials;
      refreshGroupViewTrialRow(btn.dataset.remId);
      trackGroupViewTrialWrite(setTrials(state.viewGroupSessionId, btn.dataset.remId, trials).catch(err => {
        rem.trials = prevTrials;
        refreshGroupViewTrialRow(btn.dataset.remId);
        alert("Couldn't update — check your connection and try again.\n\n" + err.message);
      }));
    });
  });

  container.querySelectorAll(".view-add-trial").forEach(btn => {
    btn.addEventListener("click", () => {
      const rem = state.viewGroupSessionData?.remarks?.[btn.dataset.remId];
      if (!rem) return;
      const prevTrials = rem.trials || [];
      const trials = [...prevTrials, -1];
      rem.trials = trials;
      refreshGroupViewTrialRow(btn.dataset.remId);
      trackGroupViewTrialWrite(setTrials(state.viewGroupSessionId, btn.dataset.remId, trials).catch(err => {
        rem.trials = prevTrials;
        refreshGroupViewTrialRow(btn.dataset.remId);
        alert("Couldn't add trial — check your connection and try again.\n\n" + err.message);
      }));
    });
  });
}

function attachGroupViewListeners() {
  const body = $("group-session-view-body");
  const sid  = () => state.viewGroupSessionId;

  body.querySelectorAll("textarea.view-remark-edit, textarea.view-mastery-note").forEach(autoResizeTextarea);

  const wrap = fn => withViewAction("viewGroupActionsInFlight", "viewGroupRenderPending", isGroupViewBusy, renderGroupSessionView, fn);

  bindGroupViewTrialCellListeners(body);

  // ── Sketch board buttons (group view screen) ────────────────
  body.querySelectorAll(".btn-sketch[data-rem-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.remId;
      const field = body.querySelector(`.view-remark-edit[data-rem-id="${id}"]`)
                 || body.querySelector(`.view-mastery-note[data-rem-id="${id}"]`);
      if (field) openTextEditorSheet(field);
    });
  });

  // Saving for .view-remark-edit / .group-remark-input-combined is handled by
  // the shared host saver (state.viewGroupRemarkSaver) set up once in
  // openGroupSessionView, not here — this function runs on every render, and
  // the body persists across renders, so attaching per-box listeners here
  // would stack up duplicates.

  // Combine/Separate remarks toggle (mirrors the live group session editor's confirm logic)
  body.querySelectorAll(".btn-combine-toggle").forEach(btn => {
    btn.addEventListener("click", wrap(async () => {
      state.viewGroupRemarkSaver?.flush();
      const actId = btn.dataset.actId;
      const data  = state.viewGroupSessionData;
      const current = !!data?.activities?.[actId]?.combineRemarks;

      if (!current) {
        const attendees = data.attendees || (state.viewGroup?.students || []).filter(Boolean);
        const byStudent = {};
        for (const studentName of attendees) {
          byStudent[studentName] = Object.entries(data.remarks || {})
            .filter(([, r]) => r.activityId === actId && r.studentName === studentName)
            .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
            .map(([id, r]) => ({ id, ...r }));
        }
        const maxRounds = Math.max(...Object.values(byStudent).map(arr => arr.length), 0);
        const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();

        const remIdsToClear = [];
        let conflict = null;
        for (let i = 0; i < maxRounds; i++) {
          const present = attendees
            .map(name => ({ name, rem: byStudent[name][i] }))
            .filter(e => e.rem);
          if (present.length < 2) continue;
          const [kept, ...others] = present;
          const keptHasText = stripEmpty(kept.rem.text).length > 0;
          for (const other of others) {
            if (keptHasText && stripEmpty(other.rem.text).length > 0) {
              if (!conflict) conflict = { keptName: kept.name, clearedName: other.name };
              remIdsToClear.push(other.rem.id);
            }
          }
        }

        if (remIdsToClear.length > 0) {
          const ok = confirm(
            `${conflict.clearedName}'s remark will be deleted and ${conflict.keptName}'s remark will be kept after combining. Continue?`
          );
          if (!ok) return;
          btn.disabled = true;
          for (const remId of remIdsToClear) await updateRemarkText(sid(), remId, "");
        }
      }

      btn.disabled = true;
      await updateActivityCombineRemarks(sid(), actId, !current);
    }));
  });

  // Saving for .view-remark-edit / .view-remark-empty / .group-remark-input-
  // combined / .view-mastery-note is handled by the shared host saver
  // (state.viewGroupRemarkSaver) set up once in openGroupSessionView.

  // These three handlers update state.viewGroupSessionData synchronously
  // (not just the DOM/Firestore) before awaiting the write — see the matching
  // comment on the individual view screen's equivalent handlers for why:
  // leaveGroupSessionView()'s cleanup reads a captured snapshot with no guard
  // for an in-flight write, which could otherwise let it delete a remark the
  // boss just set.
  body.querySelectorAll(".view-remark-preset-select").forEach(sel => {
    sel.addEventListener("change", wrap(async () => {
      if (!sel.value) return;
      const rem = state.viewGroupSessionData?.remarks?.[sel.dataset.remId];
      const prevText = rem?.text;
      if (rem) rem.text = sel.value;
      try {
        await updateRemarkText(sid(), sel.dataset.remId, sel.value);
      } catch (err) {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      }
    }));
  });

  body.querySelectorAll(".view-remark-multi-btn").forEach(btn => {
    btn.addEventListener("click", wrap(async () => {
      btn.classList.toggle("active");
      const container = btn.closest(".view-remark-multi-opts");
      const selected = [...container.querySelectorAll(".view-remark-multi-btn.active")].map(b => b.dataset.opt);
      const newText = selected.join(", ");
      const rem = state.viewGroupSessionData?.remarks?.[btn.dataset.remId];
      const prevText = rem?.text;
      if (rem) rem.text = newText;
      try {
        await updateRemarkText(sid(), btn.dataset.remId, newText);
      } catch (err) {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      }
    }));
  });

  body.querySelectorAll(".view-starter-input").forEach(input => {
    input.addEventListener("blur", async () => {
      const rem = state.viewGroupSessionData?.remarks?.[input.dataset.remId];
      if (!rem || input.value === (rem.text || "")) return;
      const prevText = rem.text;
      rem.text = input.value;
      try {
        await updateRemarkText(sid(), input.dataset.remId, input.value);
      } catch (err) {
        rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      }
    });
  });

  // "+ Add Remark & Trials" on a brand-new (round-less) activity — adds one
  // remark for every attendee. Writes to local state and renders immediately
  // (optimistic) instead of awaiting addActivity + addGroupRemarksBatch
  // first — both are handed the same ids used locally, so the background
  // writes settle into the exact same keys once the snapshot catches up.
  body.querySelectorAll(".btn-view-group-add-remark-all").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const data       = state.viewGroupSessionData;
      const targetName = btn.dataset.targetName;
      const actName    = btn.dataset.actName;
      const attendees  = data.attendees || (state.viewGroup?.students || []).filter(Boolean);
      data.activities = data.activities || {};
      data.remarks    = data.remarks || {};
      let actId = btn.dataset.actId || Object.entries(data.activities)
        .find(([, a]) => a.targetName === targetName && a.activityName === actName)?.[0] || null;
      const isNewAct = !actId;
      const actOrder = Date.now();
      if (isNewAct) {
        actId = generateId("a");
        data.activities[actId] = { targetName, activityName: actName, order: actOrder, isPredefined: true };
      }
      const studentNames = attendees.filter(studentName => !Object.values(data.remarks)
        .some(r => r.activityId === actId && r.studentName === studentName));
      const remIds = studentNames.map(() => generateId("r"));
      studentNames.forEach((studentName, i) => {
        data.remarks[remIds[i]] = { activityId: actId, studentName, text: "", trials: [], order: actOrder };
      });
      renderGroupSessionView();
      (async () => {
        try {
          if (isNewAct) await addActivity(sid(), targetName, actName, actOrder, true, actId);
          if (studentNames.length) {
            await addGroupRemarksBatch(sid(), studentNames.map(studentName => ({ actId, studentName })), remIds);
          }
        } catch (err) {
          if (isNewAct) delete data.activities[actId];
          remIds.forEach(id => delete data.remarks[id]);
          renderGroupSessionView();
          alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
        }
      })();
    });
  });

  // "+ Add Remark & Trials" on a pending (missing) student within an existing
  // round — actId always already exists here (the round itself came from an
  // existing remark), so this is a single optimistic write.
  body.querySelectorAll(".btn-view-group-add-remark-pending").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const data        = state.viewGroupSessionData;
      const actId        = btn.dataset.actId;
      const studentName  = btn.dataset.student;
      const remId        = generateId("r");
      data.remarks = data.remarks || {};
      data.remarks[remId] = { activityId: actId, studentName, text: "", trials: [], order: Date.now() };
      renderGroupSessionView();
      addGroupRemark(sid(), actId, studentName, "", remId).catch(err => {
        delete data.remarks[remId];
        renderGroupSessionView();
        alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // "+ Add Remark" for a mapped-score activity, one attendee at a time — unlike
  // the plain pending button above, the activity may not exist yet at all
  // (mapped activities skip the bulk "add for everyone" button), so this
  // creates it on demand, same as ensureGroupActivityAndRemark's live-entry
  // counterpart — also optimistic now, for the same reason as the buttons above.
  body.querySelectorAll(".btn-view-group-add-remark-mapped-pending").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      const data       = state.viewGroupSessionData;
      const targetName = btn.dataset.targetName;
      const actName    = btn.dataset.actName;
      const studentName = btn.dataset.student;
      data.activities = data.activities || {};
      data.remarks    = data.remarks || {};
      let actId = btn.dataset.actId || Object.entries(data.activities)
        .find(([, a]) => a.targetName === targetName && a.activityName === actName)?.[0] || null;
      const isNewAct = !actId;
      const actOrder = Date.now();
      if (isNewAct) {
        actId = generateId("a");
        data.activities[actId] = { targetName, activityName: actName, order: actOrder, isPredefined: true };
      }
      const remId = generateId("r");
      data.remarks[remId] = { activityId: actId, studentName, text: "", trials: [], order: actOrder };
      renderGroupSessionView();
      (async () => {
        try {
          if (isNewAct) await addActivity(sid(), targetName, actName, actOrder, true, actId);
          await addGroupRemark(sid(), actId, studentName, "", remId);
        } catch (err) {
          if (isNewAct) delete data.activities[actId];
          delete data.remarks[remId];
          renderGroupSessionView();
          alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
        }
      })();
    });
  });

  // "+" under Trials with no remark yet — creates the activity/remark for
  // this student and a first trial in one go.
  body.querySelectorAll(".view-group-add-trial-new").forEach(btn => {
    btn.addEventListener("click", wrap(async () => {
      let actId = btn.dataset.actId;
      if (!actId) {
        actId = await addActivity(
          sid(), btn.dataset.targetName, btn.dataset.actName, Date.now(),
          btn.dataset.isPredefined === "true"
        );
      }
      const remId = await addGroupRemark(sid(), actId, btn.dataset.student);
      await setTrials(sid(), remId, [-1]);
      await waitForSessionData(() => !!state.viewGroupSessionData?.remarks?.[remId]?.trials?.length);
    }));
  });

  body.querySelectorAll(".view-act-edit").forEach(input => {
    input.addEventListener("blur", async () => {
      const newName = input.value.trim();
      if (!newName || newName === input.dataset.original) return;
      if (!input.dataset.actId) return;
      input.dataset.original = newName;
      await updateActivityName(sid(), input.dataset.actId, newName);
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
    });
  });

  body.querySelectorAll(".view-act-del").forEach(btn => {
    btn.addEventListener("click", wrap(async () => {
      if (!confirm("Delete this activity and all its remarks?")) return;
      const actId = btn.dataset.actId;
      if (!actId) return;
      const remIds = viewGetRemarks(state.viewGroupSessionData, actId).map(r => r.id);
      await deleteActivity(sid(), actId, remIds);
    }));
  });

  body.querySelectorAll(".view-rem-del").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("Delete this remark?")) return;
      const remId = btn.dataset.remId;
      const rem = state.viewGroupSessionData?.remarks?.[remId];
      if (!rem) return;
      delete state.viewGroupSessionData.remarks[remId];
      renderViewOrDefer("viewGroupRenderPending", isGroupViewBusy, renderGroupSessionView);
      deleteRemark(sid(), remId).catch(err => {
        state.viewGroupSessionData.remarks[remId] = rem;
        renderViewOrDefer("viewGroupRenderPending", isGroupViewBusy, renderGroupSessionView);
        alert("Couldn't delete remark — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  body.querySelectorAll(".view-comment-edit").forEach(ta => {
    ta.addEventListener("blur", async () => {
      const key    = ta.dataset.targetKey;
      const target = getViewGroupEffectiveTargets().find(t => sanitizeKey(t.name) === key);
      if (!target) return;
      const current = (state.viewGroupSessionData?.fedcComments || {})[key] || "";
      if (ta.value === current) return;
      await updateFedcComment(sid(), target.name, ta.value);
    });
  });
}

// ── Go To Another (group) Session ─────────────────────────────
async function showGoToAnotherGroupSession(group) {
  $("session-picker-title").textContent = group.name;
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading sessions…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentGroupSessions(group.id); } catch (_) {}

  const currentTargetNames = new Set((group.targets || []).map(t => t.name));
  const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
  const hasUsefulData = s => {
    if (Object.values(s.fedcComments || {}).some(c => stripEmpty(c).length > 0)) return true;
    return Object.values(s.remarks || {}).some(r => {
      const act = (s.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      const hasText   = stripEmpty(r.text).length > 0;
      const hasTrials = (r.trials      || []).some(t => t !== null && t !== -1);
      const hasNote   = stripEmpty(r.masteryNote).length > 0;
      return hasText || hasTrials || hasNote;
    });
  };
  // Don't auto-delete the session currently being viewed
  const empties = sessions.filter(s => s.id !== state.viewGroupSessionId && !hasUsefulData(s));
  empties.forEach(s => deleteSession(s.id).catch(() => {}));
  sessions = sessions.filter(s => !empties.some(e => e.id === s.id));

  const today = getTodayString();
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  if (byMonth.size === 0) {
    $("session-picker-list").innerHTML = `<div class="session-picker-loading">No sessions found.</div>`;
    return;
  }

  const currentMonth = state.viewGroupSessionData?.month;
  if (currentMonth && byMonth.has(currentMonth)) {
    renderGoToGroupSessionsForMonth(group, currentMonth, byMonth.get(currentMonth), byMonth, today);
  } else {
    renderGoToGroupMonthGrid(group, byMonth, today);
  }
}

function renderGoToGroupMonthGrid(group, byMonth, today) {
  $("session-picker-title").textContent = group.name;
  let html = `<div class="month-grid">`;
  for (const month of byMonth.keys()) {
    const [name, year] = month.split(" ");
    html += `<button class="month-grid-btn" data-month="${escHtml(month)}">
      <span class="mgb-month">${escHtml(name.slice(0, 3))}</span>
      <span class="mgb-year">${escHtml(year)}</span>
    </button>`;
  }
  html += `</div>`;
  $("session-picker-list").innerHTML = html;
  $("session-picker-list").querySelectorAll(".month-grid-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const month = btn.dataset.month;
      renderGoToGroupSessionsForMonth(group, month, byMonth.get(month), byMonth, today);
    });
  });
}

function renderGoToGroupSessionsForMonth(group, month, monthSessions, byMonth, today) {
  $("session-picker-title").textContent = month;
  const sorted  = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  const display = [...sorted].reverse();
  let html = `<button class="btn-picker-back">← Back</button>`;
  html += renderSessionListRows(sorted, display, today, { isCurrentId: state.viewGroupSessionId });
  const list = $("session-picker-list");
  list.innerHTML = html;
  list.querySelector(".btn-picker-back").addEventListener("click", () => {
    renderGoToGroupMonthGrid(group, byMonth, today);
  });
  list.querySelectorAll(".session-list-item").forEach(item => {
    item.addEventListener("click", () => {
      const sid = item.dataset.sessionId;
      closeSessionPicker();
      if (sid !== state.viewGroupSessionId) openGroupSessionView(group, sid);
    });
  });
}

// Header "Go To Another Session" button on the group live entry screen —
// same month-grid-then-list flow as the View screen's equivalent button,
// but jumps into live entry instead of View/Edit (openGroupSession instead
// of openGroupSessionView) when a session is picked. openGroupSession takes
// a date string rather than a session id, so the click handler looks up the
// picked session's date from the month's session list.
async function showGoToAnotherGroupSessionForEntry(group) {
  $("session-picker-title").textContent = group.name;
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading sessions…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentGroupSessions(group.id); } catch (_) {}

  const currentTargetNames = new Set((group.targets || []).map(t => t.name));
  const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();
  const hasUsefulData = s => {
    if (Object.values(s.fedcComments || {}).some(c => stripEmpty(c).length > 0)) return true;
    return Object.values(s.remarks || {}).some(r => {
      const act = (s.activities || {})[r.activityId];
      if (!act || !currentTargetNames.has(act.targetName)) return false;
      const hasText   = stripEmpty(r.text).length > 0;
      const hasTrials = (r.trials      || []).some(t => t !== null && t !== -1);
      const hasNote   = stripEmpty(r.masteryNote).length > 0;
      return hasText || hasTrials || hasNote;
    });
  };
  // Don't auto-delete the session currently being edited
  const empties = sessions.filter(s => s.id !== state.groupSessionId && !hasUsefulData(s));
  empties.forEach(s => deleteSession(s.id).catch(() => {}));
  sessions = sessions.filter(s => !empties.some(e => e.id === s.id));

  const today = getTodayString();
  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }

  if (byMonth.size === 0) {
    $("session-picker-list").innerHTML = `<div class="session-picker-loading">No sessions found.</div>`;
    return;
  }

  const currentMonth = state.groupSessionData?.month;
  if (currentMonth && byMonth.has(currentMonth)) {
    renderGoToGroupSessionsForMonthEntry(group, currentMonth, byMonth.get(currentMonth), byMonth, today);
  } else {
    renderGoToGroupMonthGridEntry(group, byMonth, today);
  }
}

function renderGoToGroupMonthGridEntry(group, byMonth, today) {
  $("session-picker-title").textContent = group.name;
  let html = `<div class="month-grid">`;
  for (const month of byMonth.keys()) {
    const [name, year] = month.split(" ");
    html += `<button class="month-grid-btn" data-month="${escHtml(month)}">
      <span class="mgb-month">${escHtml(name.slice(0, 3))}</span>
      <span class="mgb-year">${escHtml(year)}</span>
    </button>`;
  }
  html += `</div>`;
  $("session-picker-list").innerHTML = html;
  $("session-picker-list").querySelectorAll(".month-grid-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const month = btn.dataset.month;
      renderGoToGroupSessionsForMonthEntry(group, month, byMonth.get(month), byMonth, today);
    });
  });
}

function renderGoToGroupSessionsForMonthEntry(group, month, monthSessions, byMonth, today) {
  $("session-picker-title").textContent = month;
  const sorted  = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  const display = [...sorted].reverse();
  let html = `<button class="btn-picker-back">← Back</button>`;
  html += renderSessionListRows(sorted, display, today, { isCurrentId: state.groupSessionId });
  const list = $("session-picker-list");
  list.innerHTML = html;
  list.querySelector(".btn-picker-back").addEventListener("click", () => {
    renderGoToGroupMonthGridEntry(group, byMonth, today);
  });
  list.querySelectorAll(".session-list-item").forEach(item => {
    item.addEventListener("click", () => {
      const sid = item.dataset.sessionId;
      closeSessionPicker();
      if (sid === state.groupSessionId) return;
      const picked = sorted.find(s => s.id === sid);
      openGroupSession(group, picked.date, group.students);
    });
  });
}

// ── Edit Date (group view) ─────────────────────────────────────
async function showEditGroupDatePicker() {
  const group       = state.viewGroup;
  const currentDate = state.viewGroupSessionData.date;

  $("session-picker-title").textContent = "Edit Date";
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentGroupSessions(group.id); } catch (_) {}
  const takenDates = new Set(
    sessions.filter(s => s.id !== state.viewGroupSessionId).map(s => s.date)
  );
  renderGroupDatePickerCalendar(currentDate, takenDates, getTodayString(), currentDate);
}

function renderGroupDatePickerCalendar(displayDate, takenDates, today, currentDate) {
  const [y, m] = displayDate.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1)
    .toLocaleString("default", { month: "long", year: "numeric" });
  const [ty, tm] = today.split("-").map(Number);
  const canNext = y < ty || (y === ty && m < tm);

  const pad = n => String(n).padStart(2, "0");
  const prevM = m === 1  ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;

  const firstDow  = new Date(y, m - 1, 1).getDay();
  const daysInMon = new Date(y, m, 0).getDate();

  let html = `<div class="date-picker-wrap">
    <p class="date-picker-subtitle">Select a new date</p>
    <p class="date-picker-legend"><span class="date-taken-dot">✓︎</span> Session exists on this day</p>
    <div class="date-picker-cal">
      <div class="date-picker-nav">
        <button class="btn-date-prev">‹</button>
        <span class="date-picker-month-label">${escHtml(monthLabel)}</span>
        <button class="btn-date-next"${canNext ? "" : " disabled"}>›</button>
      </div>
      <div class="date-picker-day-headers">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
        <span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="date-picker-grid">`;

  for (let cell = 0; cell < 42; cell++) {
    const d = cell - firstDow + 1;
    if (d < 1 || d > daysInMon) { html += `<span></span>`; continue; }
    const ds      = `${y}-${pad(m)}-${pad(d)}`;
    const isCur   = ds === currentDate;
    const isFut   = ds > today;
    const isTaken = takenDates.has(ds);
    const dis     = isFut || isTaken;
    let cls = "date-picker-day";
    if (isCur)   cls += " date-picker-day-current";
    if (isFut)   cls += " date-picker-day-future";
    if (isTaken) cls += " date-picker-day-taken";
    const dotCls = isTaken ? "date-taken-dot" : "day-dot-spacer";
    html += `<button class="${cls}" data-date="${ds}"${dis ? " disabled" : ""}><span class="day-num">${d}</span><span class="${dotCls}">${isTaken ? "✓︎" : ""}</span></button>`;
  }
  html += `</div></div></div>`;

  $("session-picker-title").textContent = "Edit Date";
  $("session-picker-list").innerHTML = html;

  $("session-picker-list").querySelector(".btn-date-prev").addEventListener("click", () => {
    renderGroupDatePickerCalendar(prevM, takenDates, today, currentDate);
  });
  if (canNext) {
    $("session-picker-list").querySelector(".btn-date-next").addEventListener("click", () => {
      renderGroupDatePickerCalendar(nextM, takenDates, today, currentDate);
    });
  }
  $("session-picker-list").querySelectorAll(".date-picker-day:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      const newDate = btn.dataset.date;
      closeSessionPicker();
      if (newDate === currentDate) return;
      try {
        await updateGroupSessionDate(state.viewGroupSessionId, newDate, state.viewGroup.id);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

// ============================================================
// MANAGE MODAL (inline student / target / template config editing)
// ============================================================

function cfgId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Open / close ──────────────────────────────────────────────

function openManageModal(student, targetOrNull, templateOrNull = null, remarkPresetOrNull = null) {
  $("manage-modal").classList.remove("hidden");
  if (remarkPresetOrNull) {
    renderRemarkPresetManageContent(remarkPresetOrNull);
  } else if (templateOrNull) {
    renderTemplateManageContent(templateOrNull);
  } else if (targetOrNull) {
    renderTargetManageContent(student, targetOrNull);
  } else {
    renderStudentManageContent(student);
  }
}

// ── Group Add Target picker ───────────────────────────────────

// ── Reorder Targets (group) — same mechanism as the individual-student version ──
function showGroupTargetReorderList(group) {
  _pendingActsCleanup = null;
  $("manage-modal-title").textContent = "Rearrange Targets";
  $("manage-modal").classList.remove("hidden");
  renderGroupTargetReorderList(group);
}

function renderGroupTargetReorderList(group) {
  const sorted = sortTargetsByOrder(group.targets);
  $("manage-modal-body").innerHTML = `
    <p class="admin-hint" style="padding:0 .1rem .9rem;color:var(--text-muted);font-size:.85rem">
      Drag to reorder. This is the order targets appear in the dropdown and in exported session notes.
    </p>
    <div class="admin-list" id="mn-target-reorder-list">
      ${sorted.map((t, idx) => `
        <div class="admin-list-item" data-idx="${idx}">
          <span class="drag-handle">⠿</span>
          <span style="flex:1">${escHtml(t.name)}</span>
        </div>`).join("")}
    </div>
    <div style="margin-top:1.5rem;padding-bottom:1.5rem">
      <button class="btn-primary-sm" id="btn-mn-done-reorder" style="width:100%;padding:.75rem">Done</button>
    </div>`;

  initDragSort($("mn-target-reorder-list"), async newOrder => {
    const reordered = newOrder.map(oldIdx => sorted[oldIdx]);
    reordered.forEach((t, i) => t.order = i);
    group.targets = reordered;
    const gi = state.groups.findIndex(g => g.id === group.id);
    if (gi >= 0) state.groups[gi] = group;
    await saveGroup(group);
    renderGroupTargetReorderList(group);
  });

  $("btn-mn-done-reorder").addEventListener("click", closeManageModal);
}

function showGroupAddTargetPicker(group) {
  _pendingActsCleanup = null;
  $("manage-modal-title").textContent = "Add Target";
  $("manage-modal").classList.remove("hidden");

  const hasDup       = group.targets.length > 0;
  const otherGroups  = state.groups.filter(g => g.id !== group.id && g.targets?.length > 0);
  const hasOther     = otherGroups.length > 0;
  const hasTemplates = state.templates.length > 0;

  $("manage-modal-body").innerHTML = `
    <div style="display:flex;flex-direction:column;gap:.6rem">
      <button class="btn-target-type" id="btn-gadd-create">
        <span class="btn-target-label">Create Target</span>
        <span class="btn-target-desc">Activities will be the same every session, just fill in remarks</span>
      </button>
      ${hasDup ? `<button class="btn-target-type" id="btn-gadd-dup-current">
        <span class="btn-target-label">Duplicate Target from Current Group</span>
        <span class="btn-target-desc">Duplicate an existing target from this group</span>
      </button>` : ""}
      ${hasOther ? `<button class="btn-target-type" id="btn-gadd-dup-other">
        <span class="btn-target-label">Duplicate Target from Another Group</span>
        <span class="btn-target-desc">Duplicate a target from a different group</span>
      </button>` : ""}
      ${hasTemplates ? `<button class="btn-target-type" id="btn-gadd-dup-tmpl">
        <span class="btn-target-label">Duplicate from Template</span>
        <span class="btn-target-desc">Duplicate a template as an individual target</span>
      </button>` : ""}
    </div>`;
  $("manage-modal-body").scrollTop = 0;

  $("btn-gadd-create").addEventListener("click", async () => {
    $("manage-modal").classList.add("hidden");
    const name = prompt("Target name:");
    if (!name?.trim()) return;
    const t = { id: cfgId("gt"), name: name.trim(), maxPoints: 3, hasComment: false, fullName: "",
      order: group.targets.length, predefinedActivities: [], notes: [], isStructured: true };
    group.targets.push(t);
    const gi = state.groups.findIndex(g => g.id === group.id);
    if (gi >= 0) state.groups[gi] = group;
    await state.entryGroupRemarkSaver?.flush();
    await saveGroup(group);
    state.selectedGroupTargetName = t.name;
    populateGroupTargetDropdown(group.targets);
    renderGroupTargetContent();
    openGroupManageModal(group, t);
  });

  $("btn-gadd-dup-current")?.addEventListener("click", () => showGroupDupFromCurrent(group));
  $("btn-gadd-dup-other")?.addEventListener("click", () => showGroupDupFromOther(group, otherGroups));
  $("btn-gadd-dup-tmpl")?.addEventListener("click", () => showGroupDupFromTemplate(group));
}

function showGroupDupFromCurrent(group) {
  const sorted = sortTargetsByOrder(group.targets);
  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Choose a target to duplicate</div>
    <div class="admin-list">
      ${sorted.map(t => `
        <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
          <input type="radio" name="gdup-target" class="gdup-target-radio" data-target-id="${escHtml(t.id)}"
            style="width:18px;height:18px;flex-shrink:0;cursor:pointer" />
          <span class="admin-item-name">${escHtml(t.name)}</span>
        </label>`).join("")}
    </div>
    <button class="btn-primary-sm" id="btn-gdup-confirm" style="width:100%;margin-top:.75rem;padding:.75rem">Duplicate Selected</button>
    <button class="btn-adm-secondary" id="btn-gdup-back" style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  $("btn-gdup-back").addEventListener("click", () => showGroupAddTargetPicker(group));
  $("btn-gdup-confirm").addEventListener("click", async () => {
    const radio = $("manage-modal-body").querySelector(".gdup-target-radio:checked");
    if (!radio) { alert("Select a target to duplicate."); return; }
    const source = group.targets.find(t => t.id === radio.dataset.targetId);
    if (!source) return;
    $("manage-modal").classList.add("hidden");
    const name = prompt("Name for the duplicate:", source.name + " (duplicate)");
    if (!name?.trim()) { $("manage-modal").classList.remove("hidden"); showGroupAddTargetPicker(group); return; }
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = cfgId("gt"); copy.name = name.trim(); copy.order = group.targets.length;
    group.targets.push(copy);
    const gi = state.groups.findIndex(g => g.id === group.id);
    if (gi >= 0) state.groups[gi] = group;
    await state.entryGroupRemarkSaver?.flush();
    await saveGroup(group);
    state.selectedGroupTargetName = copy.name;
    populateGroupTargetDropdown(group.targets);
    renderGroupTargetContent();
    openGroupManageModal(group, copy);
  });
}

function showGroupDupFromOther(group, otherGroups) {
  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Choose a group</div>
    <div class="admin-list">
      ${otherGroups.sort((a, b) => a.name.localeCompare(b.name)).map(g => `
        <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
          <input type="radio" name="gother-group" class="gother-group-radio" data-group-id="${escHtml(g.id)}"
            style="width:18px;height:18px;flex-shrink:0;cursor:pointer" />
          <span class="admin-item-name">${escHtml(g.name)}</span>
        </label>`).join("")}
    </div>
    <button class="btn-primary-sm" id="btn-gother-next" style="width:100%;margin-top:.75rem;padding:.75rem">Next →</button>
    <button class="btn-adm-secondary" id="btn-gdup-back" style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  $("btn-gdup-back").addEventListener("click", () => showGroupAddTargetPicker(group));
  $("btn-gother-next").addEventListener("click", () => {
    const radio = $("manage-modal-body").querySelector(".gother-group-radio:checked");
    if (!radio) { alert("Select a group."); return; }
    const src = otherGroups.find(g => g.id === radio.dataset.groupId);
    if (!src) return;
    showGroupDupFromOtherPickTarget(group, src);
  });
}

function showGroupDupFromOtherPickTarget(group, sourceGroup) {
  const sorted = sortTargetsByOrder(sourceGroup.targets || []);
  if (!sorted.length) { alert(`${sourceGroup.name} has no targets.`); showGroupAddTargetPicker(group); return; }
  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Choose a target from ${escHtml(sourceGroup.name)}</div>
    <div class="admin-list">
      ${sorted.map(t => `
        <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
          <input type="radio" name="gother-target" class="gother-target-radio" data-target-id="${escHtml(t.id)}"
            style="width:18px;height:18px;flex-shrink:0;cursor:pointer" />
          <span class="admin-item-name">${escHtml(t.name)}</span>
        </label>`).join("")}
    </div>
    <button class="btn-primary-sm" id="btn-gother-dup" style="width:100%;margin-top:.75rem;padding:.75rem">Duplicate Selected</button>
    <button class="btn-adm-secondary" id="btn-gdup-back" style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  $("btn-gdup-back").addEventListener("click", () => showGroupDupFromOther(group, state.groups.filter(g => g.id !== group.id && g.targets?.length > 0)));
  $("btn-gother-dup").addEventListener("click", async () => {
    const radio = $("manage-modal-body").querySelector(".gother-target-radio:checked");
    if (!radio) { alert("Select a target."); return; }
    const source = sorted.find(t => t.id === radio.dataset.targetId);
    if (!source) return;
    $("manage-modal").classList.add("hidden");
    const name = prompt("Name for the duplicate:", source.name + " (duplicate)");
    if (!name?.trim()) { $("manage-modal").classList.remove("hidden"); showGroupAddTargetPicker(group); return; }
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = cfgId("gt"); copy.name = name.trim(); copy.order = group.targets.length; copy.isStructured = true;
    group.targets.push(copy);
    const gi = state.groups.findIndex(g => g.id === group.id);
    if (gi >= 0) state.groups[gi] = group;
    await state.entryGroupRemarkSaver?.flush();
    await saveGroup(group);
    state.selectedGroupTargetName = copy.name;
    populateGroupTargetDropdown(group.targets);
    renderGroupTargetContent();
    openGroupManageModal(group, copy);
  });
}

function showGroupDupFromTemplate(group) {
  const sortedTmpls = [...state.templates].sort((a, b) => a.name.localeCompare(b.name));
  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Choose templates to duplicate</div>
    <div class="admin-list">
      ${sortedTmpls.map(t => `
        <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
          <input type="checkbox" class="gtmpl-cb" data-tmpl-id="${escHtml(t.id)}"
            style="width:20px;height:20px;flex-shrink:0;cursor:pointer" />
          <span class="admin-item-name">${escHtml(t.name)}</span>
        </label>`).join("")}
    </div>
    <button class="btn-primary-sm" id="btn-gtmpl-dup" style="width:100%;margin-top:.75rem;padding:.75rem">Duplicate Selected</button>
    <button class="btn-adm-secondary" id="btn-gdup-back" style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  $("btn-gdup-back").addEventListener("click", () => showGroupAddTargetPicker(group));
  $("btn-gtmpl-dup").addEventListener("click", async () => {
    const checked = [...$("manage-modal-body").querySelectorAll(".gtmpl-cb:checked")];
    if (!checked.length) { alert("Select at least one template."); return; }
    $("manage-modal").classList.add("hidden");
    let lastAdded = null;
    for (const cb of checked) {
      const tmpl = state.templates.find(t => t.id === cb.dataset.tmplId);
      if (!tmpl) continue;
      const copy = {
        id: cfgId("gt"), name: tmpl.name, maxPoints: tmpl.maxPoints || 3,
        hasComment: false, fullName: "", order: group.targets.length,
        predefinedActivities: JSON.parse(JSON.stringify(tmpl.predefinedActivities || [])),
        notes: JSON.parse(JSON.stringify(tmpl.notes || [])), isStructured: true
      };
      group.targets.push(copy); lastAdded = copy;
    }
    const gi = state.groups.findIndex(g => g.id === group.id);
    if (gi >= 0) state.groups[gi] = group;
    await state.entryGroupRemarkSaver?.flush();
    await saveGroup(group);
    if (lastAdded) state.selectedGroupTargetName = lastAdded.name;
    populateGroupTargetDropdown(group.targets);
    renderGroupTargetContent();
    if (lastAdded && checked.length === 1) openGroupManageModal(group, lastAdded);
  });
}

async function closeManageModal() {
  $("manage-modal").classList.add("hidden");
  _groupForTargetEdit = null;

  // This function force-renders the live session screen further down (to
  // reflect any target-config changes just made), bypassing the normal
  // busy-check entirely. Without flushing first, an edit that was typed but
  // hadn't hit its save debounce yet would get silently overwritten by that
  // forced render reading the last (now-stale) Firestore snapshot — exactly
  // the "my edit reverted to the original" bug.
  await state.entryRemarkSaver?.flush();
  await state.entryGroupRemarkSaver?.flush();

  if (_pendingActsCleanup) {
    const { acts, save } = _pendingActsCleanup;
    _pendingActsCleanup = null;
    const before = acts.length;
    for (let i = acts.length - 1; i >= 0; i--) {
      if (isEmptyActItem(acts[i])) acts.splice(i, 1);
    }
    if (acts.length !== before) {
      acts.forEach((a, i) => a.order = i);
      // Awaited (not fire-and-forget) so this finishes before the screen
      // refreshes below, and a failed save is surfaced instead of silently
      // leaving the empty item sitting in Firestore.
      try {
        await save();
      } catch (err) {
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      }
    }
  }
  // If a brand-new group was being created but has no students, remove it.
  // filter(Boolean) (not .length) because an untouched/cleared roster slot
  // can leave an empty-string or sparse-array hole at some index — that's
  // still an empty group, just not one with .length === 0.
  if (_newGroupId) {
    const g = state.groups.find(x => x.id === _newGroupId);
    if (g && (!g.students || g.students.filter(Boolean).length === 0)) {
      const gi = state.groups.findIndex(x => x.id === _newGroupId);
      if (gi >= 0) state.groups.splice(gi, 1);
      deleteGroup(_newGroupId).catch(() => {});
      renderGroupButtons();
    }
    _newGroupId = null;
  }
  // Refresh session dropdown / content if a session is active
  if (state.currentStudent) {
    populateTargetDropdown(state.currentStudent.targets);
    if (state.currentSessionId) {
      // Run both auto-fills so newly-added Select One / Tickbox / mapped-score
      // activities get their remarks immediately — no Firestore snapshot will
      // arrive on its own since saving the target config doesn't write to the
      // session doc.
      (async () => {
        try {
          if (await autoFillStructuredRemarks(state.currentStudent, state.currentSessionId) > 0) return;
          if (await autoFillMappedRemarks(state.currentStudent, state.currentSessionId) > 0) return;
          renderTargetContent();
        } catch { renderTargetContent(); }
      })();
    }
  }
  // Refresh group session dropdown / content if a group session is active
  if (state.currentGroup) {
    populateGroupTargetDropdown(state.currentGroup.targets);
    if (state.groupSessionId && state.groupSessionData && state.selectedGroupTargetName) {
      autoFillGroupSession(
        state.currentGroup, state.groupSessionId, state.groupSessionData,
        state.selectedGroupTargetName, state.groupAttendees
      ).then(filled => {
        if (filled > 0) return;
        return autoFillGroupMappedRemarks(
          state.currentGroup, state.groupSessionId, state.groupSessionData,
          state.selectedGroupTargetName, state.groupAttendees
        ).then(mappedFilled => {
          if (mappedFilled > 0) return;
          return autoFillGroupStructuredRemarks(
            state.currentGroup, state.groupSessionId, state.groupSessionData,
            state.selectedGroupTargetName, state.groupAttendees
          ).then(structuredFilled => { if (structuredFilled === 0) renderGroupTargetContent(); });
        });
      }).catch(() => renderGroupTargetContent());
    } else if (state.groupSessionId) {
      renderGroupTargetContent();
    }
  }
  // Always refresh all home screen sections
  renderExistingStudentButtons();
  renderAssessmentStudentButtons();
  renderTemplateButtons();
  renderExportButtons();
  renderGroupButtons();
  // Manage Student can be opened from on top of the Student Database page
  // (clicking a row there) — refresh its table too, otherwise a rename or
  // session-number change made in the modal doesn't show up underneath it.
  if ($("screen-student-registry")?.classList.contains("active")) {
    renderStudentRegistryBody();
  }
}

$("manage-modal-close").addEventListener("click",    closeManageModal);
$("manage-modal-backdrop").addEventListener("click", closeManageModal);


// ── Session-screen ⚙ button ───────────────────────────────────

$("btn-manage-targets").addEventListener("click", () => {
  const student = state.currentStudent;
  if (!student) return;
  const target = student.targets.find(t => t.name === state.selectedTargetName) || null;
  openManageModal(student, target);
});

// ── Add Target picker (replaces confirm/prompt flow) ──────────

// ── Reorder Targets (drag-to-reorder, same mechanism as activity reordering) ──
// Persisted order drives the dropdown, the View/Edit Past Sessions table, and
// the Word/Excel exports — see sortTargetsByOrder.
function showTargetReorderList(student) {
  _pendingActsCleanup = null;
  $("manage-modal-title").textContent = "Rearrange Targets";
  $("manage-modal").classList.remove("hidden");
  renderTargetReorderList(student);
}

function renderTargetReorderList(student) {
  const sorted = sortTargetsByOrder(student.targets);
  $("manage-modal-body").innerHTML = `
    <p class="admin-hint" style="padding:0 .1rem .9rem;color:var(--text-muted);font-size:.85rem">
      Drag to reorder. This is the order targets appear in the dropdown and in exported session notes.
    </p>
    <div class="admin-list" id="mn-target-reorder-list">
      ${sorted.map((t, idx) => `
        <div class="admin-list-item" data-idx="${idx}">
          <span class="drag-handle">⠿</span>
          <span style="flex:1">${escHtml(t.name)}</span>
        </div>`).join("")}
    </div>
    <div style="margin-top:1.5rem;padding-bottom:1.5rem">
      <button class="btn-primary-sm" id="btn-mn-done-reorder" style="width:100%;padding:.75rem">Done</button>
    </div>`;

  initDragSort($("mn-target-reorder-list"), async newOrder => {
    const reordered = newOrder.map(oldIdx => sorted[oldIdx]);
    reordered.forEach((t, i) => t.order = i);
    student.targets = reordered;
    const si = state.students.findIndex(s => s.id === student.id);
    if (si >= 0) state.students[si] = student;
    await saveStudent(student);
    renderTargetReorderList(student);
  });

  $("btn-mn-done-reorder").addEventListener("click", closeManageModal);
}

function showAddTargetPicker(student) {
  _pendingActsCleanup = null;
  $("manage-modal-title").textContent = "Add Target";
  $("manage-modal").classList.remove("hidden");

  const hasDuplicatable  = student.targets.length > 0;
  const otherStudents    = state.students.filter(s => s.id !== student.id);
  const hasOtherStudents = otherStudents.length > 0;
  const hasTemplates     = state.templates.length > 0;

  const html = `
    <div style="display:flex;flex-direction:column;gap:.6rem">
      <button class="btn-target-type" id="btn-add-structured-target">
        <span class="btn-target-label">Create Target</span>
        <span class="btn-target-desc">Activities will be the same every session, just fill in remarks</span>
      </button>
      ${hasDuplicatable ? `<button class="btn-target-type" id="btn-duplicate-target">
        <span class="btn-target-label">Duplicate Target from Current Student</span>
        <span class="btn-target-desc">Duplicate an existing target from this student</span>
      </button>` : ""}
      ${hasOtherStudents ? `<button class="btn-target-type" id="btn-duplicate-from-other">
        <span class="btn-target-label">Duplicate Target from Another Student</span>
        <span class="btn-target-desc">Duplicate a target from a different student</span>
      </button>` : ""}
      ${hasTemplates ? `<button class="btn-target-type" id="btn-duplicate-from-template">
        <span class="btn-target-label">Duplicate from Template</span>
        <span class="btn-target-desc">Duplicate a template as an individual target</span>
      </button>` : ""}
    </div>`;

  const modalBody = $("manage-modal-body");
  modalBody.innerHTML = html;
  modalBody.scrollTop = 0;

  $("btn-add-structured-target").addEventListener("click", async () => {
    $("manage-modal").classList.add("hidden");
    const name = prompt("Target name:");
    if (!name?.trim()) return;
    const t = {
      id: cfgId("t"), name: name.trim(),
      maxPoints: 3, hasComment: false, fullName: "",
      order: student.targets.length,
      predefinedActivities: [], notes: [],
      templateId: null, isStructured: true
    };
    student.targets.push(t);
    const si = state.students.findIndex(s => s.id === student.id);
    if (si >= 0) state.students[si] = student;
    // Flush before the forced renderTargetContent() below — otherwise a
    // not-yet-saved edit on whatever target was open gets silently
    // overwritten when this re-renders from the last Firestore snapshot.
    await state.entryRemarkSaver?.flush();
    await saveStudent(student);
    state.selectedTargetName = t.name;
    populateTargetDropdown(student.targets);
    renderTargetContent();
    openManageModal(student, t);
  });

  $("btn-duplicate-target")?.addEventListener("click", () => {
    showDupFromCurrentStudent(student);
  });

  $("btn-duplicate-from-other")?.addEventListener("click", () => {
    showDupFromOtherStudent_pickStudent(student, otherStudents);
  });

  $("btn-duplicate-from-template")?.addEventListener("click", () => {
    showDupFromTemplate(student);
  });
}

function showDupFromCurrentStudent(student) {
  const sorted = sortTargetsByOrder(student.targets);
  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Choose a target to duplicate</div>
    <div class="admin-list">
      ${sorted.map(t => `
        <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
          <input type="radio" name="dup-target" class="dup-target-radio" data-target-id="${escHtml(t.id)}"
            style="width:18px;height:18px;flex-shrink:0;cursor:pointer" />
          <span class="admin-item-name">${escHtml(t.name)}</span>
        </label>`).join("")}
    </div>
    <button class="btn-primary-sm" id="btn-confirm-duplicate"
      style="width:100%;margin-top:.75rem;padding:.75rem">Duplicate Selected</button>
    <button class="btn-adm-secondary" id="btn-dup-back"
      style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  $("btn-dup-back").addEventListener("click", () => showAddTargetPicker(student));

  $("btn-confirm-duplicate").addEventListener("click", async () => {
    const radio = $("manage-modal-body").querySelector(".dup-target-radio:checked");
    if (!radio) { alert("Select a target to duplicate."); return; }
    const source = student.targets.find(t => t.id === radio.dataset.targetId);
    if (!source) return;
    $("manage-modal").classList.add("hidden");
    const name = prompt("Name for the duplicate:", source.name + " (duplicate)");
    if (!name?.trim()) { $("manage-modal").classList.remove("hidden"); showAddTargetPicker(student); return; }
    const copy = JSON.parse(JSON.stringify(source));
    copy.id    = cfgId("t");
    copy.name  = name.trim();
    copy.order = student.targets.length;
    copy.templateId = null;
    student.targets.push(copy);
    const si = state.students.findIndex(s => s.id === student.id);
    if (si >= 0) state.students[si] = student;
    await state.entryRemarkSaver?.flush();
    await saveStudent(student);
    state.selectedTargetName = copy.name;
    populateTargetDropdown(student.targets);
    renderTargetContent();
    openManageModal(student, copy);
  });
}

function showDupFromOtherStudent_pickStudent(student, otherStudents) {
  const existing   = otherStudents.filter(s => s.type !== "assessment").sort((a, b) => a.name.localeCompare(b.name));
  const assessment = otherStudents.filter(s => s.type === "assessment").sort((a, b) => a.name.localeCompare(b.name));

  function buildList(list) {
    if (list.length === 0) return `<div style="color:var(--text-muted);font-size:.85rem;padding:.25rem .5rem">None</div>`;
    return list.map(s => `
      <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
        <input type="radio" name="other-student" class="other-student-radio" data-student-id="${escHtml(s.id)}"
          style="width:18px;height:18px;flex-shrink:0;cursor:pointer" />
        <span class="admin-item-name">${escHtml(s.name)}</span>
      </label>`).join("");
  }

  function render(filter) {
    const q = filter.toLowerCase();
    const filteredExisting   = existing.filter(s => s.name.toLowerCase().includes(q));
    const filteredAssessment = assessment.filter(s => s.name.toLowerCase().includes(q));
    $("dup-student-list").innerHTML = `
      <div class="admin-section-title" style="margin:.5rem 0 .25rem">Existing Students</div>
      <div class="admin-list" style="margin-bottom:1rem">${buildList(filteredExisting)}</div>
      <div class="admin-section-title" style="margin:.5rem 0 .25rem">Assessment Students</div>
      <div class="admin-list">${buildList(filteredAssessment)}</div>`;
  }

  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Search Student</div>
    <input type="search" id="dup-student-search" class="admin-input"
      placeholder="Search students…" autocomplete="off"
      style="width:100%;margin-bottom:.5rem" />
    <div id="dup-student-list"></div>
    <button class="btn-primary-sm" id="btn-pick-other-student"
      style="width:100%;margin-top:.75rem;padding:.75rem">Next →</button>
    <button class="btn-adm-secondary" id="btn-dup-back"
      style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  render("");
  $("dup-student-search").addEventListener("input", e => render(e.target.value));
  $("btn-dup-back").addEventListener("click", () => showAddTargetPicker(student));

  $("btn-pick-other-student").addEventListener("click", () => {
    const radio = $("manage-modal-body").querySelector(".other-student-radio:checked");
    if (!radio) { alert("Select a student."); return; }
    const source = otherStudents.find(s => s.id === radio.dataset.studentId);
    if (!source) return;
    showDupFromOtherStudent_pickTarget(student, source);
  });
}

function showDupFromOtherStudent_pickTarget(student, sourceStudent) {
  const sorted = sortTargetsByOrder(sourceStudent.targets);
  if (sorted.length === 0) {
    alert(`${sourceStudent.name} has no targets to duplicate.`);
    showAddTargetPicker(student);
    return;
  }
  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Choose a target from ${escHtml(sourceStudent.name)}</div>
    <div class="admin-list">
      ${sorted.map(t => `
        <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
          <input type="radio" name="other-target" class="other-target-radio" data-target-id="${escHtml(t.id)}"
            style="width:18px;height:18px;flex-shrink:0;cursor:pointer" />
          <span class="admin-item-name">${escHtml(t.name)}</span>
        </label>`).join("")}
    </div>
    <button class="btn-primary-sm" id="btn-confirm-other-dup"
      style="width:100%;margin-top:.75rem;padding:.75rem">Duplicate Selected</button>
    <button class="btn-adm-secondary" id="btn-dup-back"
      style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  $("btn-dup-back").addEventListener("click", () => {
    showDupFromOtherStudent_pickStudent(student, state.students.filter(s => s.id !== student.id));
  });

  $("btn-confirm-other-dup").addEventListener("click", async () => {
    const radio = $("manage-modal-body").querySelector(".other-target-radio:checked");
    if (!radio) { alert("Select a target to duplicate."); return; }
    const source = sourceStudent.targets.find(t => t.id === radio.dataset.targetId);
    if (!source) return;
    $("manage-modal").classList.add("hidden");
    const name = prompt("Name for the duplicate:", source.name + " (duplicate)");
    if (!name?.trim()) { $("manage-modal").classList.remove("hidden"); showAddTargetPicker(student); return; }
    const copy = JSON.parse(JSON.stringify(source));
    copy.id         = cfgId("t");
    copy.name       = name.trim();
    copy.order      = student.targets.length;
    copy.templateId = null;
    copy.isStructured = true;
    student.targets.push(copy);
    const si = state.students.findIndex(s => s.id === student.id);
    if (si >= 0) state.students[si] = student;
    await state.entryRemarkSaver?.flush();
    await saveStudent(student);
    state.selectedTargetName = copy.name;
    populateTargetDropdown(student.targets);
    renderTargetContent();
    openManageModal(student, copy);
  });
}

function showDupFromTemplate(student) {
  const sortedTmpls = [...state.templates].sort((a, b) => a.name.localeCompare(b.name));
  $("manage-modal-body").innerHTML = `
    <div class="admin-section-title" style="margin-bottom:.5rem">Choose templates to duplicate</div>
    <div class="admin-list">
      ${sortedTmpls.map(t => `
        <label class="admin-list-item" style="cursor:pointer;gap:.75rem">
          <input type="checkbox" class="tmpl-source-cb" data-tmpl-id="${escHtml(t.id)}"
            style="width:20px;height:20px;flex-shrink:0;cursor:pointer" />
          <span class="admin-item-name">${escHtml(t.name)}</span>
        </label>`).join("")}
    </div>
    <button class="btn-primary-sm" id="btn-confirm-tmpl-dup"
      style="width:100%;margin-top:.75rem;padding:.75rem">Duplicate Selected</button>
    <button class="btn-adm-secondary" id="btn-dup-back"
      style="width:100%;margin-top:.5rem;padding:.65rem">← Back</button>`;

  $("btn-dup-back").addEventListener("click", () => showAddTargetPicker(student));

  $("btn-confirm-tmpl-dup").addEventListener("click", async () => {
    const checked = [...$("manage-modal-body").querySelectorAll(".tmpl-source-cb:checked")];
    if (checked.length === 0) { alert("Select at least one template to duplicate."); return; }

    $("manage-modal").classList.add("hidden");
    let lastAdded = null;
    for (const cb of checked) {
      const tmpl = state.templates.find(t => t.id === cb.dataset.tmplId);
      if (!tmpl) continue;
      const copy = {
        id: cfgId("t"), name: tmpl.name,
        maxPoints: tmpl.maxPoints || 3,
        hasComment: false, fullName: "",
        order: student.targets.length,
        predefinedActivities: JSON.parse(JSON.stringify(tmpl.predefinedActivities || [])),
        notes: JSON.parse(JSON.stringify(tmpl.notes || [])),
        templateId: null, isStructured: true
      };
      student.targets.push(copy);
      lastAdded = copy;
    }
    const si = state.students.findIndex(s => s.id === student.id);
    if (si >= 0) state.students[si] = student;
    await state.entryRemarkSaver?.flush();
    await saveStudent(student);
    if (lastAdded) state.selectedTargetName = lastAdded.name;
    populateTargetDropdown(student.targets);
    renderTargetContent();
    if (lastAdded && checked.length === 1) openManageModal(student, lastAdded);
  });
}

// ── Remark preset management content ─────────────────────────

// ── Student management content ────────────────────────────────

function renderStudentNameDisplay(student) {
  return `<div style="display:flex;gap:.6rem;align-items:center">
    <div class="admin-input" style="flex:1;color:var(--text-muted);cursor:default">${escHtml(student.name)}</div>
    <button class="btn-primary-sm" id="btn-mn-rename">Change Student's Name</button>
  </div>`;
}

// "Change Student's Name" swaps the read-only name display for the old
// First Name/Last Name editor in place (same popup, no navigation) — with
// persistent labels instead of placeholder text (which disappears once you
// type) and no Save button, since each field autosaves on blur instead.
function wireStudentNameSection(student) {
  $("btn-mn-rename")?.addEventListener("click", () => {
    const firstName = student.firstName || student.name?.split(/\s+/)[0] || "";
    const lastName  = student.lastName  || student.name?.split(/\s+/).slice(1).join(" ") || "";
    $("mn-s-name-section").innerHTML = `
      <div style="display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap">
        <div style="flex:1;min-width:8rem">
          <div style="font-size:.75rem;font-weight:600;color:var(--text-muted);margin-bottom:.25rem">First Name</div>
          <input class="admin-input" id="mn-s-firstname" value="${escHtml(firstName)}" style="width:100%" />
        </div>
        <div style="flex:1;min-width:8rem">
          <div style="font-size:.75rem;font-weight:600;color:var(--text-muted);margin-bottom:.25rem">Last Name</div>
          <input class="admin-input" id="mn-s-lastname" value="${escHtml(lastName)}" style="width:100%" />
        </div>
      </div>`;

    const save = async () => {
      const fn = $("mn-s-firstname").value.trim();
      const ln = $("mn-s-lastname").value.trim();
      if (!fn || !ln) return;
      const newName = `${fn} ${ln}`;
      if (fn === student.firstName && ln === student.lastName && newName === student.name) return;
      const oldName = student.name;
      student.firstName = fn;
      student.lastName  = ln;
      student.name      = newName;
      await saveStudent(student);
      propagateStudentRenameToGroups(student, oldName, newName);
      $("manage-modal-title").textContent = newName;
    };
    [$("mn-s-firstname"), $("mn-s-lastname")].forEach(input => {
      input.addEventListener("blur", save);
      input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
    });
    $("mn-s-firstname").focus();
  });
}

function renderStudentManageContent(student) {
  _pendingActsCleanup = null;
  $("manage-modal-title").textContent = student.name;
  const isAssessment = student.type === "assessment";

  const html = `
    <div class="admin-section" style="margin-bottom:1.5rem">
      <label class="admin-label">Student Name</label>
      <div id="mn-s-name-section">${renderStudentNameDisplay(student)}</div>
    </div>
    <div class="admin-section">
      <div id="mn-s-session-number-area">Loading…</div>
    </div>
    ${isAssessment ? `
    <div class="admin-section">
      <button class="btn-adm-edit" id="btn-mn-move-to-existing"
        style="width:100%;padding:.75rem;justify-content:center;display:flex">
        Move to Existing Students
      </button>
    </div>` : ""}
    <div style="margin-top:1.5rem;padding-bottom:.5rem">
      <button class="btn-adm-danger" id="btn-mn-del-student">Delete Student</button>
    </div>`;

  $("manage-modal-body").innerHTML = html;
  wireStudentNameSection(student);

  renderSessionNumberSection(student);

  $("btn-mn-move-to-existing")?.addEventListener("click", async () => {
    if (!confirm(`Move "${student.name}" to Existing Students?`)) return;
    student.type = "existing";
    await saveStudent(student);
    closeManageModal();
  });

  $("btn-mn-del-student").addEventListener("click", async () => {
    const typed = prompt(`Type DELETE to permanently delete "${student.name}". Session data is kept in Firebase, but the student will be removed from all lists.`);
    if (typed !== "DELETE") return;
    await deleteStudentConfig(student.id);
    state.students = state.students.filter(s => s.id !== student.id);
    closeManageModal();
  });
}

// Lets the boss correct a veteran student's lifetime session count (e.g. they
// were tracked on paper for years before this app) — pick one of their
// existing sessions and type its true number; every one of their sessions
// of that SAME kind shifts by the same amount to keep order/spacing.
// Individual and group session counts are separate lifetime sequences (a
// group session never affects an individual number or vice versa), so each
// gets its own picker rather than one shared one.
async function renderSessionNumberSection(student) {
  const area = $("mn-s-session-number-area");
  if (!area) return;
  const [indivSessions, groupSessions] = await Promise.all([
    getIndividualSessionsForStudent(student.id),
    getGroupSessionsForStudent(student.id)
  ]);
  if (!area.isConnected) return; // modal closed while the fetch was in flight

  // Silently fill any gaps in individual session numbers (e.g. 1,2,3,5,6 →
  // 1,2,3,4,5). Only triggers on true gaps — consecutive sessions that differ
  // by more than 1 — so a user-set offset like 8,9,10,11 is never touched.
  const indivSorted = indivSessions.slice().sort((a, b) => a.date.localeCompare(b.date));
  const hasGap = indivSorted.some((s, i) => i > 0 && s.number !== indivSorted[i - 1].number + 1);
  if (hasGap) {
    const base = indivSorted[0]?.number ?? 1;
    indivSorted.forEach((s, i) => { s.number = base + i; }); // fix locally for display
    resequenceIndividualSessions(student.id).catch(() => {});  // fix in Firestore
  }

  area.innerHTML = `
    <div id="mn-s-sessnum-individual"></div>
    <div id="mn-s-sessnum-group" style="margin-top:1.1rem"></div>`;

  renderSessionNumberKindSubsection(student, "individual", "Individual Sessions",
    indivSorted, $("mn-s-sessnum-individual"));
  renderSessionNumberKindSubsection(student, "group", "Group Sessions",
    groupSessions.sort((a, b) => a.date.localeCompare(b.date)), $("mn-s-sessnum-group"));
}

function renderSessionNumberKindSubsection(student, kind, label, sessions, container) {
  if (!container) return;
  if (sessions.length === 0) {
    container.innerHTML = `
      <p class="admin-label" style="margin-bottom:.3rem">${label}</p>
      <p class="empty-hint" style="padding:.4rem 0">No ${kind} sessions recorded yet.</p>`;
    return;
  }

  const id = suffix => `mn-s-sessnum-${kind}-${suffix}`;
  const dropdownOrder = [...sessions].reverse(); // newest-first for picker

  container.innerHTML = `
    <p class="admin-label" style="margin-bottom:.4rem">${label}</p>
    <label style="font-size:.78rem;color:var(--text-muted);display:block;margin-bottom:.3rem">Select session to renumber</label>
    <select class="admin-input" id="${id("date")}" style="margin-bottom:.5rem">
      ${dropdownOrder.map(s => `<option value="${s.id}">${formatDate(s.date)} → Session ${s.number}</option>`).join("")}
    </select>
    <div style="display:flex;align-items:center;gap:.4rem">
      <span style="font-size:.82rem;color:var(--text-muted);white-space:nowrap">Renumber to</span>
      <button type="button" class="btn-adm-edit" id="${id("minus")}" style="padding:.4rem .7rem;line-height:1">−</button>
      <input class="admin-input" id="${id("value")}" type="number" min="1" style="width:4.5rem;text-align:center;flex:0 0 auto" />
      <button type="button" class="btn-adm-edit" id="${id("plus")}" style="padding:.4rem .7rem;line-height:1">+</button>
      <button class="btn-primary-sm" id="${id("save")}">Save</button>
    </div>`;

  // Keeps the stepper's starting value in sync with whichever session the
  // dropdown above currently has selected (it already shows the date).
  const syncToSelectedDate = () => {
    const anchor = sessions.find(s => s.id === $(id("date")).value);
    $(id("value")).value = anchor.number;
  };
  syncToSelectedDate();
  $(id("date")).addEventListener("change", syncToSelectedDate);

  $(id("minus")).addEventListener("click", () => {
    const input = $(id("value"));
    input.value = Math.max(1, (Number(input.value) || 1) - 1);
  });
  $(id("plus")).addEventListener("click", () => {
    const input = $(id("value"));
    input.value = (Number(input.value) || 0) + 1;
  });

  $(id("save")).addEventListener("click", async () => {
    const sessionId = $(id("date")).value;
    const newNumber = Number($(id("value")).value);
    if (!newNumber || newNumber < 1) { alert("Enter a valid session number."); return; }
    const anchor = sessions.find(s => s.id === sessionId);
    const delta = newNumber - anchor.number;
    if (delta === 0) return;
    // sessions is sorted oldest-first, so sessions[0] is the earliest —
    // every session of this kind shifts by the same delta, so that's the
    // one that would go below Session 1 first if the typed number is too low.
    const earliest = sessions[0];
    const earliestNewNumber = earliest.number + delta;
    if (earliestNewNumber < 1) {
      alert(
        `If you set this to Session ${newNumber}, ${formatDate(earliest.date)} ` +
        `(this student's earliest recorded ${kind} session) would become Session ${earliestNewNumber}. ` +
        `Choose a different number.`
      );
      return;
    }
    try {
      await withSaveFeedback($(id("save")), changeSessionNumber(student.id, sessionId, newNumber, kind));
      // Mirror the same uniform shift locally instead of re-fetching from
      // Firestore — a fresh fetch right after the write was leaving a
      // confusing gap where the button said "Save" again but the dropdown
      // still showed the old number until the (slow) re-fetch finished.
      sessions.forEach(s => { s.number += delta; });
      renderSessionNumberKindSubsection(student, kind, label, sessions, container);
    } catch (err) {
      alert(err.message);
    }
  });
}

// ── Drag-to-reorder for the activity list ─────────────────────
// Uses Pointer Events so it works on mouse, iPad, and iPhone.
function initDragSort(listEl, onReorder) {
  let dragEl      = null;
  let placeholder = null;
  let offsetY     = 0;
  let lastY       = 0;
  let scrollRaf   = null;

  // The scrollable container is the manage modal body
  const scrollEl = listEl.closest('.manage-modal-body') || listEl.parentElement;
  const ZONE  = 80;  // px from edge to start auto-scrolling
  const SPEED = 12;  // max px per frame

  function autoScroll() {
    if (!dragEl || !scrollEl) { scrollRaf = null; return; }
    const { top, bottom } = scrollEl.getBoundingClientRect();
    if (lastY < top + ZONE) {
      scrollEl.scrollTop -= Math.ceil(SPEED * (1 - (lastY - top) / ZONE));
    } else if (lastY > bottom - ZONE) {
      scrollEl.scrollTop += Math.ceil(SPEED * (1 - (bottom - lastY) / ZONE));
    }
    scrollRaf = requestAnimationFrame(autoScroll);
  }

  listEl.addEventListener('pointerdown', e => {
    if (!e.target.closest('.drag-handle')) return;
    const item = e.target.closest('.admin-list-item');
    if (!item) return;
    e.preventDefault();

    const rect = item.getBoundingClientRect();
    offsetY = e.clientY - rect.top;
    lastY   = e.clientY;

    placeholder = document.createElement('div');
    placeholder.className = 'drag-placeholder';
    placeholder.style.height = rect.height + 'px';
    item.after(placeholder);

    dragEl = item;
    dragEl.style.cssText =
      `position:fixed;left:${rect.left}px;width:${rect.width}px;` +
      `top:${rect.top}px;z-index:9999;opacity:.85;` +
      `box-shadow:0 4px 16px rgba(0,0,0,.2);pointer-events:none;`;

    listEl.setPointerCapture(e.pointerId);
    scrollRaf = requestAnimationFrame(autoScroll);
  });

  listEl.addEventListener('pointermove', e => {
    if (!dragEl) return;
    lastY = e.clientY;
    dragEl.style.top = (e.clientY - offsetY) + 'px';

    const items = [...listEl.children].filter(el => el.classList.contains('admin-list-item') && el !== dragEl);
    let inserted = false;
    for (const item of items) {
      const { top, height } = item.getBoundingClientRect();
      if (e.clientY < top + height / 2) {
        listEl.insertBefore(placeholder, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) listEl.appendChild(placeholder);
  });

  const endDrag = () => {
    if (!dragEl) return;
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
    dragEl.style.cssText = '';
    if (placeholder?.parentNode) placeholder.parentNode.insertBefore(dragEl, placeholder);
    placeholder?.remove();
    const newOrder = [...listEl.children]
      .filter(el => el.classList.contains('admin-list-item'))
      .map(el => Number(el.dataset.idx));
    dragEl = null;
    placeholder = null;
    onReorder(newOrder);
  };

  listEl.addEventListener('pointerup',     endDrag);
  listEl.addEventListener('pointercancel', endDrag);
}

// Converts old group-field format to heading-row format in place.
// Called once when the manage modal opens; saved on next boss action.
function normalizeActivitiesFormat(acts) {
  const hasOldFormat = acts.some(a => !a.isHeading && a.group);
  if (!hasOldFormat) return acts;

  const result = [];
  let lastGroup = null;
  for (const a of acts) {
    if (a.isHeading) { result.push(a); continue; }
    const g = a.group || "";
    if (g && g !== lastGroup) {
      result.push({ id: cfgId("h"), isHeading: true, name: g, order: 0 });
      lastGroup = g;
    } else if (!g) {
      lastGroup = null;
    }
    const { group, ...rest } = a;
    result.push(rest);
  }
  result.forEach((item, i) => item.order = i);
  return result;
}

// ── Target management content ─────────────────────────────────

function autoResizeTextarea(el) {
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

// Converts stored note text to safe display HTML.
// Accepts both legacy *bold* markdown and new HTML from contenteditable.
function noteToHtml(text) {
  if (!text) return "";
  if (/<[a-z]/i.test(text)) return text;            // already HTML — use directly
  return escHtml(text).replace(/\*([\s\S]+?)\*/g, "<strong>$1</strong>");
}

// Convert stored note text (possibly HTML) to plain text for textarea editing
function stripNoteHtml(text) {
  if (!text) return "";
  if (!/<[a-z]/i.test(text)) {
    return text.replace(/\*([\s\S]+?)\*/g, "$1");
  }
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n").replace(/<div>/gi, "")
    .replace(/<\/p>/gi, "\n").replace(/<p>/gi, "")
    .replace(/<\/?(strong|b|u|em|i)[^>]*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Shared by the normal-activity and mapped-score-activity rows in
// renderTargetManageContent — both let the boss configure how the Remark
// field is captured (free text / preset options / sentence starter),
// independently of where the Score comes from.
function buildRemarkTypeControls(a, idx) {
  const type = a.remarkHasNote ? "starter_fixed_note"
    : (a.sentenceStarter && a.inlineOptions && a.optionsMulti) ? "starter_fixed_multi"
    : (a.sentenceStarter && a.inlineOptions) ? "starter_fixed"
    : a.sentenceStarter ? "starter"
    : (a.inlineOptions && a.optionsMulti) ? "fixed_multi"
    : (a.inlineOptions || a.remarkPresetId) ? "fixed" : "";
  return `<select class="act-preset-select mn-act-preset" data-idx="${idx}">
      <option value="">Free text</option>
      <option value="fixed"${type === "fixed" ? " selected" : ""}>Select one</option>
      <option value="fixed_multi"${type === "fixed_multi" ? " selected" : ""}>Tick boxes</option>
      <option value="starter"${type === "starter" ? " selected" : ""}>Sentence Starter + Free Text</option>
      <option value="starter_fixed"${type === "starter_fixed" ? " selected" : ""}>Sentence Starter + Select one</option>
      <option value="starter_fixed_multi"${type === "starter_fixed_multi" ? " selected" : ""}>Sentence Starter + Tick boxes</option>
      <option value="starter_fixed_note"${type === "starter_fixed_note" ? " selected" : ""}>Sentence Starter + Select One + Free Text</option>
    </select>
    <input class="admin-input mn-act-starter-text" data-idx="${idx}"
      placeholder="Starter phrase…"
      value="${escHtml(a.sentenceStarter || "")}"
      style="${type === "starter" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note" ? "flex:1;min-width:0;width:auto" : "display:none"}">
    <div class="mn-opts-container" data-idx="${idx}" style="${type === "fixed" || type === "fixed_multi" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note" ? "flex:1;min-width:0" : "display:none"}">
      <div class="mn-opts-list">${(() => {
        const optsStr = a.inlineOptions || (a.remarkPresetId ? (state.remarkPresets.find(p=>p.id===a.remarkPresetId)?.options||[]).join("/") : "");
        const displayOpts = parseOpts(optsStr).length > 0 ? parseOpts(optsStr) : [""];
        return displayOpts.map((opt, oi) =>
          `<div class="mn-opt-row admin-list-item" data-idx="${oi}" style="display:flex;align-items:center;gap:.3rem;margin-bottom:.25rem">` +
          `<span class="drag-handle" style="cursor:grab;color:#c4c9d4;font-size:1rem;flex-shrink:0;padding:0 .1rem;user-select:none">⠿</span>` +
          `<span class="mn-opt-num" style="font-size:.74rem;color:#9ca3af;min-width:1.2rem;text-align:right;flex-shrink:0">${oi + 1}.</span>` +
          `<input class="admin-input mn-opt-item" data-idx="${idx}" data-oi="${oi}" value="${escHtml(opt)}" placeholder="Enter option…" style="flex:1;padding:.3rem .45rem;font-size:.84rem;min-width:0">` +
          `<button class="mn-opt-del" data-idx="${idx}" data-oi="${oi}" title="Remove option" style="flex-shrink:0;padding:.2rem .4rem;font-size:.8rem;color:#9ca3af;background:none;border:1px solid #e5e7eb;border-radius:.3rem;cursor:pointer;line-height:1">×</button>` +
          `</div>`
        ).join("");
      })()}</div>
      <div style="display:flex;align-items:center;gap:.5rem;margin-top:.2rem">
        <button class="mn-opt-add" data-idx="${idx}" style="font-size:.78rem;padding:.25rem .6rem;background:none;border:1px solid #d1d5db;border-radius:.35rem;cursor:pointer;color:#6b7280">+ Add Option</button>
        <span title="Renaming an option updates it across all past sessions too. If you rename &quot;A&quot; to &quot;B&quot;, every past session that chose &quot;A&quot; will now show &quot;B&quot;." style="cursor:default;color:#9ca3af;font-size:.8rem">ⓘ</span>
      </div>
    </div>`;
}

function renderTargetManageContent(student, target) {
  $("manage-modal-title").textContent = target.name;
  target.predefinedActivities = normalizeActivitiesFormat(target.predefinedActivities || []);

  // Migrate legacy notes array into the unified predefinedActivities list
  if (target.notes?.length > 0) {
    for (const n of target.notes) {
      target.predefinedActivities.push({ id: n.id || cfgId("n"), isNote: true, text: n.text || "", order: target.predefinedActivities.length });
    }
    target.notes = [];
  }

  const acts = target.predefinedActivities;
  const masteredActs = acts.filter(a => !a.isHeading && !a.isNote && !a.isMaintain && !a.isMaintainHeading && a.isCompleted);
  const stoppedActs  = acts.filter(a => !a.isHeading && !a.isNote && !a.isMaintain && !a.isMaintainHeading && (a.isArchived || a.isStopped));
  // Other targets this target's mapped-score activities can point at — never
  // itself (self-mapping would make a target's average depend on itself).
  const siblingTargets = (_groupForTargetEdit ? _groupForTargetEdit.targets : student.targets)
    .filter(t => t.id !== target.id);

  let html = `
    <div class="admin-section">
      <label class="admin-label">Target Name</label>
      <input class="admin-input" id="mn-t-name" value="${escHtml(target.name)}" />
    </div>
    <div class="admin-section admin-row">
      <label class="admin-label">Max Points</label>
      <div class="admin-pts-group">
        <button class="admin-pts-btn ${target.maxPoints !== 4 ? "active" : ""}" data-pts="3">3</button>
        <button class="admin-pts-btn ${target.maxPoints === 4 ? "active" : ""}" data-pts="4">4</button>
      </div>
    </div>
    ${_groupForTargetEdit ? `
    <div class="admin-section">
      <div class="admin-label-row">
        <label class="admin-label">Layout</label>
        <span class="layout-info-icon" tabindex="0">ⓘ What is this?
          <div class="layout-info-tooltip">
            <strong>Group students together</strong>
            <div class="layout-info-desc">Each activity becomes a heading. Every student's entry for that activity is listed underneath it.</div>
            <div class="layout-info-example">Antecedent<br>&nbsp;&nbsp;• Peter<br>&nbsp;&nbsp;• Mary<br><br>Behaviours<br>&nbsp;&nbsp;• Peter<br>&nbsp;&nbsp;• Mary<br><br>Consequence<br>&nbsp;&nbsp;• Peter<br>&nbsp;&nbsp;• Mary</div>
            <strong>Group activities together</strong>
            <div class="layout-info-desc">Each student becomes a heading. All of their activities are listed underneath, one after another.</div>
            <div class="layout-info-example">Peter<br>&nbsp;&nbsp;• Antecedent<br>&nbsp;&nbsp;• Behaviours<br>&nbsp;&nbsp;• Consequence<br><br>Mary<br>&nbsp;&nbsp;• Antecedent<br>&nbsp;&nbsp;• Behaviours<br>&nbsp;&nbsp;• Consequence</div>
          </div>
        </span>
      </div>
      <div class="admin-toggle-group">
        <button class="admin-toggle-btn mn-grouplayout-btn ${(target.groupLayout || "byActivity") === "byActivity" ? "active" : ""}" data-layout="byActivity">Group students together</button>
        <button class="admin-toggle-btn mn-grouplayout-btn ${target.groupLayout === "byStudent" ? "active" : ""}" data-layout="byStudent">Group activities together</button>
      </div>
    </div>` : ``}

    <div class="admin-section-title">Activities & Notes</div>
    <div class="admin-list" id="mn-act-list">`;

  acts.forEach((a, idx) => {
    if (a.isCompleted || a.isArchived || a.isStopped) return;
    if (a.isHeading) {
      html += `<div class="admin-list-item mn-heading-item" data-idx="${idx}">
        <span class="drag-handle">⠿</span>
        <textarea class="admin-input mn-heading-input" id="mn-act-name-${idx}" data-idx="${idx}"
          rows="1" placeholder="Enter Section Heading" style="flex:1">${escHtml(a.name || "")}</textarea>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else if (a.isNote) {
      html += `<div class="admin-list-item admin-note-item" data-idx="${idx}">
        <span class="drag-handle">⠿</span>
        ${formatButtonsHtml(`mn-act-name-${idx}`)}
        <textarea class="admin-input mn-act-name-input" id="mn-act-name-${idx}" data-idx="${idx}"
          rows="1" placeholder="Enter Note"
          style="flex:1;overflow-y:hidden;resize:none">${escHtml(stripNoteHtml(a.text || ""))}</textarea>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else if (a.isMaintainHeading) {
      html += `<div class="admin-list-item mn-heading-item" data-idx="${idx}" style="background:#d1d5db">
        <span class="drag-handle">⠿</span>
        <textarea class="admin-input mn-heading-input" id="mn-act-name-${idx}" data-idx="${idx}"
          rows="1" placeholder="Enter Maintain Section Heading" style="flex:1;background:#d1d5db">${escHtml(a.name || "")}</textarea>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else if (a.isMaintain) {
      html += `<div class="admin-list-item" data-idx="${idx}" style="background:#f3f4f6;border:1px solid #d1d5db">
        <span class="drag-handle">⠿</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:.3rem">
          <div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-name-${idx}`)}
            <textarea class="admin-input mn-act-name-input" id="mn-act-name-${idx}" data-idx="${idx}"
              rows="1" placeholder="Activity name" style="flex:1">${escHtml(a.name || "")}</textarea>
          </div>
          <div style="display:flex;align-items:center;gap:.5rem">
            <span style="font-size:.75rem;color:#6b7280;white-space:nowrap;font-weight:600">Fixed Remark:</span>
            <textarea class="admin-input mn-maintain-remark-input" id="mn-act-mremark-${idx}" data-idx="${idx}"
              rows="1" placeholder="Read-Only Remark"
              style="flex:1;overflow-y:hidden;resize:none">${escHtml(a.maintainRemark || "")}</textarea>
          </div>
        </div>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else if (a.isMapped) {
      const mappedOptions = siblingTargets.map(t =>
        `<option value="${escHtml(t.id)}"${a.mappedTargetId === t.id ? " selected" : ""}>${escHtml(t.name)}</option>`
      ).join("");
      const mappedNoteRow = a.actNote !== undefined
        ? `<div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-note-${idx}`)}
            <textarea class="admin-input mn-act-note-input" id="mn-act-note-${idx}" data-idx="${idx}"
              rows="1" placeholder="Enter Note"
              style="flex:1;overflow-y:hidden;resize:none">${escHtml(a.actNote || "")}</textarea>
          </div>`
        : "";
      html += `<div class="admin-list-item" data-idx="${idx}">
        <span class="drag-handle">⠿</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:.3rem">
          <div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-name-${idx}`)}
            <textarea class="admin-input mn-act-name-input" id="mn-act-name-${idx}" data-idx="${idx}"
              rows="1" placeholder="Enter Activity" style="flex:1">${escHtml(a.name || "")}</textarea>
          </div>
          ${mappedNoteRow}
          <div style="display:flex;align-items:center;gap:.5rem">
            <span style="font-size:.75rem;color:#6b7280;white-space:nowrap;font-weight:600">Remark Type:</span>
            ${buildRemarkTypeControls(a, idx)}
          </div>
          <div style="display:flex;align-items:center;gap:.5rem">
            <span style="font-size:.75rem;color:#6b7280;white-space:nowrap;font-weight:600">Mapped To Which Target's Average:</span>
            <select class="admin-input mn-mapped-target-select" data-idx="${idx}" style="flex:1">
              <option value="">— select target —</option>
              ${mappedOptions}
            </select>
          </div>
        </div>
        <div style="position:relative">
          <button class="btn-adm-del mn-kebab-btn" data-idx="${idx}" title="Activity options" style="font-size:1.35rem;font-weight:900;min-width:36px;min-height:36px">⋮</button>
          <div class="mn-kebab-menu" id="mn-km-${idx}" style="display:none;position:absolute;right:0;top:100%;z-index:100;background:white;border:1px solid #e5e7eb;border-radius:.5rem;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:215px;overflow:hidden">
            <div style="display:flex;align-items:stretch;border-bottom:1px solid #f3f4f6">
              <button class="mn-km-opt" data-idx="${idx}" data-action="master" style="flex:1;padding:.55rem .9rem;text-align:left;background:none;border:none;cursor:pointer;font-size:.84rem">⭐ Mark as Mastered <span style="font-size:.72rem;color:#9ca3af">(Don't use this feature yet)</span></button>
              <span title="Student has achieved this activity. Historical data is kept in the database." style="padding:.55rem .5rem;cursor:default;color:#9ca3af;font-size:.8rem;display:flex;align-items:center">ⓘ</span>
            </div>
            <div style="display:flex;align-items:stretch;border-bottom:1px solid #f3f4f6">
              <button class="mn-km-opt" data-idx="${idx}" data-action="stop" style="flex:1;padding:.55rem .9rem;text-align:left;background:none;border:none;cursor:pointer;font-size:.84rem">🛑 Stop from now onwards</button>
              <span title="Activity will no longer appear in new sessions. All past session data is preserved." style="padding:.55rem .5rem;cursor:default;color:#9ca3af;font-size:.8rem;display:flex;align-items:center">ⓘ</span>
            </div>
            <div style="display:flex;align-items:stretch">
              <button class="mn-km-opt" data-idx="${idx}" data-action="delete" style="flex:1;padding:.55rem .9rem;text-align:left;background:none;border:none;cursor:pointer;font-size:.84rem;color:#dc2626">🗑️ Delete Activity</button>
              <span title="Permanently removes this activity and all of its session data. This cannot be undone." style="padding:.55rem .5rem;cursor:default;color:#9ca3af;font-size:.8rem;display:flex;align-items:center">ⓘ</span>
            </div>
          </div>
        </div>
      </div>`;
    } else {
      const remarkTypeSelect = buildRemarkTypeControls(a, idx);
      const noteRow = a.actNote !== undefined
        ? `<div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-note-${idx}`)}
            <textarea class="admin-input mn-act-note-input" id="mn-act-note-${idx}" data-idx="${idx}"
              rows="1" placeholder="Enter Note"
              style="flex:1;overflow-y:hidden;resize:none">${escHtml(a.actNote || "")}</textarea>
          </div>`
        : "";
      html += `<div class="admin-list-item" data-idx="${idx}"${a.isMaintainLive ? ' style="background:#f3f4f6;border:1px solid #d1d5db"' : ''}>
        <span class="drag-handle">⠿</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:.3rem">
          <div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-name-${idx}`)}
            <textarea class="admin-input mn-act-name-input" id="mn-act-name-${idx}" data-idx="${idx}"
              rows="1" placeholder="Enter Activity" style="flex:1">${escHtml(a.name || "")}</textarea>
          </div>
          ${noteRow}
          <div style="display:flex;align-items:center;gap:.5rem">
            <span style="font-size:.75rem;color:#6b7280;white-space:nowrap;font-weight:600">Remark Type:</span>
            ${remarkTypeSelect}
          </div>
        </div>
        <div style="position:relative">
          <button class="btn-adm-del mn-kebab-btn" data-idx="${idx}" title="Activity options" style="font-size:1.35rem;font-weight:900;min-width:36px;min-height:36px">⋮</button>
          <div class="mn-kebab-menu" id="mn-km-${idx}" style="display:none;position:absolute;right:0;top:100%;z-index:100;background:white;border:1px solid #e5e7eb;border-radius:.5rem;box-shadow:0 4px 12px rgba(0,0,0,.15);min-width:215px;overflow:hidden">
            <div style="display:flex;align-items:stretch;border-bottom:1px solid #f3f4f6">
              <button class="mn-km-opt" data-idx="${idx}" data-action="master" style="flex:1;padding:.55rem .9rem;text-align:left;background:none;border:none;cursor:pointer;font-size:.84rem">⭐ Mark as Mastered <span style="font-size:.72rem;color:#9ca3af">(Don't use this feature yet)</span></button>
              <span title="Student has achieved this activity. Historical data is kept in the database." style="padding:.55rem .5rem;cursor:default;color:#9ca3af;font-size:.8rem;display:flex;align-items:center">ⓘ</span>
            </div>
            <div style="display:flex;align-items:stretch;border-bottom:1px solid #f3f4f6">
              <button class="mn-km-opt" data-idx="${idx}" data-action="stop" style="flex:1;padding:.55rem .9rem;text-align:left;background:none;border:none;cursor:pointer;font-size:.84rem">🛑 Stop from now onwards</button>
              <span title="Activity will no longer appear in new sessions. All past session data is preserved." style="padding:.55rem .5rem;cursor:default;color:#9ca3af;font-size:.8rem;display:flex;align-items:center">ⓘ</span>
            </div>
            <div style="display:flex;align-items:stretch">
              <button class="mn-km-opt" data-idx="${idx}" data-action="delete" style="flex:1;padding:.55rem .9rem;text-align:left;background:none;border:none;cursor:pointer;font-size:.84rem;color:#dc2626">🗑️ Delete Activity</button>
              <span title="Permanently removes this activity and all of its session data. This cannot be undone." style="padding:.55rem .5rem;cursor:default;color:#9ca3af;font-size:.8rem;display:flex;align-items:center">ⓘ</span>
            </div>
          </div>
        </div>
      </div>`;
    }
  });

  html += `</div>`;
  if (masteredActs.length > 0) {
    html += `<div style="margin-top:1.25rem">
      <div style="font-size:.75rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;padding:.25rem 0 .5rem">Mastered</div>`;
    masteredActs.forEach((a, ci) => {
      html += `<div style="display:flex;align-items:center;gap:.5rem;padding:.45rem .5rem;background:#f0fdf4;border-radius:.4rem;margin-bottom:.35rem">
        <span style="flex:1;font-size:.875rem;color:#374151">${escHtml(a.name || "")}</span>
        <button class="btn-mn-reactivate" data-completed-idx="${ci}" data-src="mastered" style="font-size:.75rem;padding:.25rem .55rem;background:#dbeafe;border:1px solid #bfdbfe;border-radius:.35rem;cursor:pointer;color:#1d4ed8;white-space:nowrap">↩ Reactivate</button>
        <button class="btn-adm-del btn-mn-del-completed" data-completed-idx="${ci}" data-src="mastered" title="Delete permanently">🗑</button>
      </div>`;
    });
    html += `</div>`;
  }
  if (stoppedActs.length > 0) {
    html += `<div style="margin-top:1.25rem">
      <div style="font-size:.75rem;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;padding:.25rem 0 .5rem">Stopped</div>`;
    stoppedActs.forEach((a, ci) => {
      html += `<div style="display:flex;align-items:center;gap:.5rem;padding:.45rem .5rem;background:#fafafa;border:1px solid #e5e7eb;border-radius:.4rem;margin-bottom:.35rem">
        <span style="flex:1;font-size:.875rem;color:#374151">${escHtml(a.name || "")}</span>
        <button class="btn-mn-reactivate" data-completed-idx="${ci}" data-src="stopped" style="font-size:.75rem;padding:.25rem .55rem;background:#dbeafe;border:1px solid #bfdbfe;border-radius:.35rem;cursor:pointer;color:#1d4ed8;white-space:nowrap">↩ Reactivate</button>
        <button class="btn-adm-del btn-mn-del-completed" data-completed-idx="${ci}" data-src="stopped" title="Delete permanently">🗑</button>
      </div>`;
    });
    html += `</div>`;
  }
  html += `
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.25rem">
      <button class="btn-admin-add" id="btn-mn-add-act" style="flex:0 0 auto;width:auto">+ Add Activity</button>
      <button class="btn-admin-add" id="btn-mn-add-act-note" style="flex:0 0 auto;width:auto">+ Add Activity &amp; Note</button>
      <button class="btn-admin-add" id="btn-mn-add-heading" style="flex:0 0 auto;width:auto">+ Add Section Heading</button>
      <button class="btn-admin-add" id="btn-mn-add-note" style="flex:0 0 auto;width:auto">+ Add Note</button>
      <button class="btn-admin-add" id="btn-mn-add-mapped" style="flex:0 0 auto;width:auto">+ Add Activity &amp; Mapped Score</button>
      <button class="btn-admin-add" id="btn-mn-add-act-note-mapped" style="flex:0 0 auto;width:auto">+ Add Activity &amp; Note &amp; Mapped Score</button>
      <button class="btn-admin-add" id="btn-mn-add-maintain" style="flex:0 0 auto;width:auto">+ Add Maintain Activity (Fixed Remark)</button>
      <button class="btn-admin-add" id="btn-mn-add-maintain-live" style="flex:0 0 auto;width:auto">+ Add Maintain Activity</button>
      <button class="btn-admin-add" id="btn-mn-add-maintain-heading" style="flex:0 0 auto;width:auto">+ Add Maintain Section Heading</button>
    </div>
    <div style="margin-top:2rem;padding-bottom:1.5rem">
      <button class="btn-primary-sm" id="btn-mn-done-target"
        style="width:100%;padding:.75rem;margin-bottom:.75rem">Done</button>
      <button class="btn-adm-danger" id="btn-mn-del-target">Delete This Target</button>
    </div>`;

  $("manage-modal-body").innerHTML = html;
  $("manage-modal-body").querySelectorAll(".admin-list-item textarea").forEach(autoResizeTextarea);

  const saveTarget = async () => {
    const i = student.targets.findIndex(t => t.id === target.id);
    if (i >= 0) student.targets[i] = target;
    if (_groupForTargetEdit) {
      const gi = state.groups.findIndex(g => g.id === _groupForTargetEdit.id);
      if (gi >= 0) state.groups[gi] = _groupForTargetEdit;
      await saveGroup(_groupForTargetEdit);
    } else {
      const si = state.students.findIndex(s => s.id === student.id);
      if (si >= 0) state.students[si] = student;
      await saveStudent(student);
    }
  };

  _pendingActsCleanup = { acts, save: saveTarget };

  initDragSort($("mn-act-list"), async newOrder => {
    const reordered = newOrder.map(oldIdx => acts[oldIdx]);
    reordered.forEach((a, i) => a.order = i);
    target.predefinedActivities = reordered;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("mn-t-name").addEventListener("blur", async () => {
    const v = $("mn-t-name").value.trim();
    if (!v || v === target.name) return;
    const oldName = target.name;
    if (state.selectedTargetName === target.name) state.selectedTargetName = v;
    target.name = v;
    $("manage-modal-title").textContent = v;
    await saveTarget();
    propagateTargetRename(student, oldName, v);
    flashSaved($("mn-t-name"));
  });
  $("mn-t-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); $("mn-t-name").blur(); }
  });

  $("manage-modal-body").querySelectorAll(".admin-pts-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const newPts = Number(btn.dataset.pts);
      if (newPts === target.maxPoints) return;
      if (!confirm(`Change max points to ${newPts}? This will affect how scores are calculated for this target.`)) return;
      target.maxPoints = newPts;
      $("manage-modal-body").querySelectorAll(".admin-pts-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.pts === btn.dataset.pts));
      await saveTarget();
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-grouplayout-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if ((target.groupLayout || "byActivity") === btn.dataset.layout) return;
      target.groupLayout = btn.dataset.layout;
      $("manage-modal-body").querySelectorAll(".mn-grouplayout-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.layout === btn.dataset.layout));
      await saveTarget();
    });
  });

  acts.forEach((a, idx) => {
    const input = $(`mn-act-name-${idx}`);
    if (a.isNote && input) {
      const resize = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
      resize();
      let noteTimer;
      input.addEventListener("input", () => {
        resize();
        a.text = input.value;           // keep in-memory state in sync immediately
        clearTimeout(noteTimer);
        noteTimer = setTimeout(async () => { await saveTarget(); }, 800);
      });
    }
    input?.addEventListener("blur", async () => {
      let oldName = null;
      if (a.isNote) {
        const v = input.value;
        if (v === (a.text || "")) return;
        a.text = v;
      } else if (a.isHeading) {
        // A heading's text is pure display — it's never matched against any
        // session data, unlike an activity's name. Without this branch, the
        // code below ran for headings too and called propagateActivityRename
        // with the heading's old/new text, which silently RENAMED any real
        // activity in this target that happened to share the heading's old
        // text (e.g. a "Comment" heading grouping a "Comment" activity) —
        // hijacking that activity's actual session data over to the new
        // heading text instead of leaving it alone.
        const v = input.value.trim();
        if (!v || v === a.name) return;
        a.name = v;
      } else if (a.isMaintain || a.isMaintainHeading) {
        const v = input.value.trim();
        if (!v || v === a.name) return;
        a.name = v;
      } else {
        const v = input.value.trim();
        if (!v || v === a.name) return;
        oldName = a.name;
        a.name = v;
      }
      await saveTarget();
      flashSaved(input);
      if (oldName) propagateActivityRename(student, target.name, oldName, a.name);
    });
    if (!a.isNote) input?.addEventListener("input", () => autoResizeTextarea(input));

    const noteInput = $(`mn-act-note-${idx}`);
    if (noteInput) {
      const resize = () => { noteInput.style.height = "auto"; noteInput.style.height = noteInput.scrollHeight + "px"; };
      resize();
      let actNoteTimer;
      noteInput.addEventListener("input", () => {
        resize();
        a.actNote = noteInput.value;
        clearTimeout(actNoteTimer);
        actNoteTimer = setTimeout(async () => { await saveTarget(); }, 800);
      });
      noteInput.addEventListener("blur", async () => {
        if (noteInput.value === (a.actNote || "")) return;
        a.actNote = noteInput.value;
        await saveTarget();
        flashSaved(noteInput);
      });
    }

    const maintainRemarkInput = $(`mn-act-mremark-${idx}`);
    if (maintainRemarkInput) {
      const resize = () => { maintainRemarkInput.style.height = "auto"; maintainRemarkInput.style.height = maintainRemarkInput.scrollHeight + "px"; };
      resize();
      let mrTimer;
      maintainRemarkInput.addEventListener("input", () => {
        resize();
        a.maintainRemark = maintainRemarkInput.value;
        clearTimeout(mrTimer);
        mrTimer = setTimeout(async () => { await saveTarget(); }, 800);
      });
      maintainRemarkInput.addEventListener("blur", async () => {
        if (maintainRemarkInput.value === (a.maintainRemark || "")) return;
        a.maintainRemark = maintainRemarkInput.value;
        await saveTarget();
        flashSaved(maintainRemarkInput);
      });
    }
  });

  $("manage-modal-body").querySelectorAll(".btn-fmt").forEach(btn => {
    // Prevent the textarea from losing focus/selection on click — by the
    // time "click" fires the selection would otherwise already be gone.
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      const field = $(btn.dataset.inputId);
      if (!field) return;
      if (btn.classList.contains("btn-fmt-bullet")) {
        toggleBulletSelection(field);
      } else {
        wrapTextareaSelection(field, btn.classList.contains("btn-fmt-bold") ? "*" : "_");
      }
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-del-act").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.idx);
      const item = acts[idx];
      const label = item?.isHeading ? "section heading" : item?.isMaintainHeading ? "maintain section heading" : item?.isNote ? "reference note" : item?.isMapped ? "mapped-score activity" : item?.isMaintain ? "maintain activity (fixed)" : item?.isMaintainLive ? "maintain activity" : "activity";
      if (!confirm(`Delete this ${label}?`)) return;
      acts.splice(idx, 1);
      acts.forEach((a, i) => a.order = i);
      target.predefinedActivities = acts;
      await saveTarget();
      const sp = $("manage-modal-body")?.scrollTop ?? 0;
      renderTargetManageContent(student, target);
      requestAnimationFrame(() => { const b = $("manage-modal-body"); if (b) b.scrollTop = sp; });
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-kebab-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = btn.dataset.idx;
      const menu = $(`mn-km-${idx}`);
      const wasHidden = menu.style.display !== "block";
      $("manage-modal-body").querySelectorAll(".mn-kebab-menu").forEach(m => m.style.display = "none");
      if (wasHidden) {
        menu.style.display = "block";
        const closeMenu = ev => {
          if (!menu.contains(ev.target)) { menu.style.display = "none"; document.removeEventListener("click", closeMenu); }
        };
        setTimeout(() => document.addEventListener("click", closeMenu), 0);
      }
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-km-opt").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.idx);
      const action = btn.dataset.action;
      const pa = acts[idx];
      if (!pa) return;
      $("manage-modal-body").querySelectorAll(".mn-kebab-menu").forEach(m => m.style.display = "none");
      if (action === "master") {
        pa.isCompleted = true;
        delete pa.isArchived;
        await saveTarget();
        renderTargetManageContent(student, target);
      } else if (action === "stop") {
        pa.isStopped = true;
        delete pa.isArchived;
        delete pa.isCompleted;
        await saveTarget();
        renderTargetManageContent(student, target);
      } else if (action === "delete") {
        if (!confirm(`Permanently delete "${pa.name}" and all its past session data? This cannot be undone.`)) return;
        const actIdx = acts.indexOf(pa);
        if (actIdx >= 0) { acts.splice(actIdx, 1); acts.forEach((a, i) => a.order = i); }
        target.predefinedActivities = acts;
        await saveTarget();
        try {
          if (_groupForTargetEdit) {
            await deleteGroupOrphanAcrossSessions(_groupForTargetEdit.id, target.name, pa.name);
          } else {
            await deleteOrphanAcrossSessions(student.id, target.name, pa.name);
          }
        } catch (err) {
          console.error("Failed to purge activity from sessions:", err);
          alert("Activity removed from config, but failed to delete from past sessions:\n" + err.message);
        }
        renderTargetManageContent(student, target);
      }
    });
  });

  $("manage-modal-body").querySelectorAll(".btn-mn-reactivate").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ci = Number(btn.dataset.completedIdx);
      const src = btn.dataset.src;
      const pa = src === "stopped" ? stoppedActs[ci] : masteredActs[ci];
      if (!pa) return;
      if (src === "stopped") { delete pa.isArchived; delete pa.isStopped; } else delete pa.isCompleted;
      await saveTarget();
      renderTargetManageContent(student, target);
    });
  });

  $("manage-modal-body").querySelectorAll(".btn-mn-del-completed").forEach(btn => {
    btn.addEventListener("click", async () => {
      const ci = Number(btn.dataset.completedIdx);
      const src = btn.dataset.src;
      const pa = src === "stopped" ? stoppedActs[ci] : masteredActs[ci];
      if (!pa) return;
      if (!confirm(`Permanently delete "${pa.name}" and all its past session data? This cannot be undone.`)) return;
      const actIdx = acts.indexOf(pa);
      if (actIdx >= 0) { acts.splice(actIdx, 1); acts.forEach((a, i) => a.order = i); }
      target.predefinedActivities = acts;
      await saveTarget();
      try {
        if (_groupForTargetEdit) {
          await deleteGroupOrphanAcrossSessions(_groupForTargetEdit.id, target.name, pa.name);
        } else {
          await deleteOrphanAcrossSessions(student.id, target.name, pa.name);
        }
      } catch (err) {
        console.error("Failed to purge from sessions:", err);
        alert("Activity removed from config, but failed to delete from past sessions:\n" + err.message);
      }
      renderTargetManageContent(student, target);
    });
  });

  $("btn-mn-add-act").addEventListener("click", async () => {
    acts.push({ id: cfgId("a"), name: "", order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-act-note").addEventListener("click", async () => {
    acts.push({ id: cfgId("a"), name: "", actNote: "", order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-heading").addEventListener("click", async () => {
    acts.push({ id: cfgId("h"), isHeading: true, name: "", order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-note").addEventListener("click", async () => {
    acts.push({ id: cfgId("n"), isNote: true, text: "", order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-mapped").addEventListener("click", async () => {
    acts.push({ id: cfgId("m"), isMapped: true, name: "", mappedTargetId: null, order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-act-note-mapped").addEventListener("click", async () => {
    acts.push({ id: cfgId("m"), isMapped: true, name: "", actNote: "", mappedTargetId: null, order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-maintain").addEventListener("click", async () => {
    acts.push({ id: cfgId("mt"), isMaintain: true, name: "", maintainRemark: "", order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-maintain-live").addEventListener("click", async () => {
    acts.push({ id: cfgId("ml"), isMaintainLive: true, name: "", order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("btn-mn-add-maintain-heading").addEventListener("click", async () => {
    acts.push({ id: cfgId("mh"), isMaintainHeading: true, name: "", order: acts.length });
    target.predefinedActivities = acts;
    await saveTarget();
    renderTargetManageContent(student, target);
  });

  $("manage-modal-body").querySelectorAll(".mn-mapped-target-select").forEach(sel => {
    sel.addEventListener("change", async () => {
      const idx = Number(sel.dataset.idx);
      acts[idx].mappedTargetId = sel.value || null;
      target.predefinedActivities = acts;
      await saveTarget();
      flashSaved(sel);
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-act-preset").forEach(sel => {
    sel.addEventListener("change", async () => {
      const idx = Number(sel.dataset.idx);
      const body = $("manage-modal-body");
      const starterInput  = body.querySelector(`.mn-act-starter-text[data-idx="${idx}"]`);
      const optsContainer = body.querySelector(`.mn-opts-container[data-idx="${idx}"]`);
      const type = sel.value;
      acts[idx].sentenceStarter = null;
      acts[idx].remarkPresetId  = null;
      acts[idx].inlineOptions   = null;
      acts[idx].optionsMulti    = (type === "fixed_multi" || type === "starter_fixed_multi");
      acts[idx].remarkHasNote   = (type === "starter_fixed_note");
      const starterVis = (type === "starter" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note");
      const optsVis    = (type === "fixed" || type === "fixed_multi" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note");
      starterInput.style.display  = starterVis ? "" : "none";
      starterInput.style.flex     = starterVis ? "1" : "";
      starterInput.style.minWidth = starterVis ? "0" : "";
      starterInput.style.width    = starterVis ? "auto" : "";
      optsContainer.style.display  = optsVis ? "" : "none";
      optsContainer.style.flex     = optsVis ? "1" : "";
      optsContainer.style.minWidth = optsVis ? "0" : "";
      if (type === "starter" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note") { starterInput.focus(); }
      else if (type === "fixed" || type === "fixed_multi") { optsContainer.querySelector(".mn-opt-item")?.focus(); }
      else { target.predefinedActivities = acts; await saveTarget(); }
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-act-starter-text").forEach(input => {
    input.addEventListener("blur", async () => {
      const idx = Number(input.dataset.idx);
      acts[idx].sentenceStarter = input.value.trim() || null;
      target.predefinedActivities = acts;
      await saveTarget();
    });
  });

  const getOptsFromDom = idx =>
    [...$("manage-modal-body").querySelectorAll(`.mn-opt-item[data-idx="${idx}"]`)]
      .map(i => i.value.trim()).filter(Boolean);

  const renumberOpts = list => {
    list.querySelectorAll(".mn-opt-row").forEach((r, i) => {
      r.dataset.idx = i; // keep row data-idx in sync for drag-sort
      const n = r.querySelector(".mn-opt-num"); if (n) n.textContent = `${i + 1}.`;
      const inp = r.querySelector(".mn-opt-item"); if (inp) inp.dataset.oi = i;
      const del = r.querySelector(".mn-opt-del");  if (del) del.dataset.oi = i;
    });
  };

  const wireOptDel = (btn, idx) => {
    btn.addEventListener("click", async () => {
      const list = btn.closest(".mn-opts-list");
      list.removeChild(btn.closest(".mn-opt-row"));
      renumberOpts(list);
      const newOptsStr = getOptsFromDom(idx).join("/") || null;
      acts[idx].inlineOptions = newOptsStr;
      acts[idx].remarkPresetId = null;
      target.predefinedActivities = acts;
      await saveTarget();
    });
  };

  const wireOptBlur = (input, idx) => {
    input.addEventListener("blur", async () => {
      const oldOptsStr = acts[idx].inlineOptions;
      const newOptsStr = getOptsFromDom(idx).join("/") || null;
      if (newOptsStr === oldOptsStr) return;
      acts[idx].inlineOptions = newOptsStr;
      acts[idx].remarkPresetId = null;
      target.predefinedActivities = acts;
      await saveTarget();
      propagateRemarkOptionRename(student, target, acts[idx], oldOptsStr, newOptsStr);
    });
  };

  $("manage-modal-body").querySelectorAll(".mn-opt-item").forEach(inp => wireOptBlur(inp, Number(inp.dataset.idx)));
  $("manage-modal-body").querySelectorAll(".mn-opt-del").forEach(btn => wireOptDel(btn, Number(btn.dataset.idx)));

  $("manage-modal-body").querySelectorAll(".mn-opts-list").forEach(list => {
    initDragSort(list, async () => {
      const idx = Number(list.closest(".mn-opts-container").dataset.idx);
      renumberOpts(list);
      const newOptsStr = getOptsFromDom(idx).join("/") || null;
      acts[idx].inlineOptions = newOptsStr;
      acts[idx].remarkPresetId = null;
      target.predefinedActivities = acts;
      await saveTarget();
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-opt-add").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const list = btn.closest(".mn-opts-container").querySelector(".mn-opts-list");
      const oi = list.querySelectorAll(".mn-opt-row").length;
      const row = document.createElement("div");
      row.className = "mn-opt-row admin-list-item";
      row.dataset.idx = String(oi);
      row.style.cssText = "display:flex;align-items:center;gap:.3rem;margin-bottom:.25rem";
      row.innerHTML =
        `<span class="drag-handle" style="cursor:grab;color:#c4c9d4;font-size:1rem;flex-shrink:0;padding:0 .1rem;user-select:none">⠿</span>` +
        `<span class="mn-opt-num" style="font-size:.74rem;color:#9ca3af;min-width:1.2rem;text-align:right;flex-shrink:0">${oi + 1}.</span>` +
        `<input class="admin-input mn-opt-item" data-idx="${idx}" data-oi="${oi}" placeholder="Enter option…" style="flex:1;padding:.3rem .45rem;font-size:.84rem;min-width:0">` +
        `<button class="mn-opt-del" data-idx="${idx}" data-oi="${oi}" title="Remove option" style="flex-shrink:0;padding:.2rem .4rem;font-size:.8rem;color:#9ca3af;background:none;border:1px solid #e5e7eb;border-radius:.3rem;cursor:pointer;line-height:1">×</button>`;
      list.appendChild(row);
      wireOptBlur(row.querySelector(".mn-opt-item"), idx);
      wireOptDel(row.querySelector(".mn-opt-del"), idx);
      row.querySelector(".mn-opt-item").focus();
    });
  });

  $("btn-mn-done-target").addEventListener("click", closeManageModal);

  $("btn-mn-del-target").addEventListener("click", async () => {
    const typed1 = prompt(`This will permanently delete "${target.name}" and ALL its session data across every date.\n\nType DELETE to confirm:`);
    if (typed1 !== "DELETE") return;
    const typed2 = prompt(`Are you absolutely sure? This cannot be undone.\n\nType DELETE again to permanently delete "${target.name}":`);
    if (typed2 !== "DELETE") return;
    student.targets = student.targets.filter(t => t.id !== target.id);
    student.targets.forEach((t, i) => t.order = i);
    if (_groupForTargetEdit) {
      await saveGroup(_groupForTargetEdit);
      await deleteGroupTargetDataFromSessions(_groupForTargetEdit.id, target.name);
    } else {
      await saveStudent(student);
      await deleteTargetDataFromSessions(student.id, target.name);
    }
    const si = state.students.findIndex(s => s.id === student.id);
    if (si >= 0) state.students[si] = student;
    if (state.selectedTargetName === target.name) {
      state.selectedTargetName = student.targets[0]?.name || null;
    }
    closeManageModal();
  });
}

// ── Template management content ───────────────────────────────

function renderTemplateManageContent(template) {
  $("manage-modal-title").textContent = template.name;
  template.predefinedActivities = normalizeActivitiesFormat(template.predefinedActivities || []);

  // Migrate legacy notes array into the unified predefinedActivities list
  if (template.notes?.length > 0) {
    for (const n of template.notes) {
      template.predefinedActivities.push({ id: n.id || cfgId("n"), isNote: true, text: n.text || "", order: template.predefinedActivities.length });
    }
    template.notes = [];
  }

  const acts = template.predefinedActivities;

  let html = `
    <div class="admin-section">
      <label class="admin-label">Template Name</label>
      <input class="admin-input" id="mn-t-name" value="${escHtml(template.name)}" />
    </div>
    <div class="admin-section admin-row">
      <label class="admin-label">Max Points</label>
      <div class="admin-pts-group">
        <button class="admin-pts-btn ${(template.maxPoints || 3) !== 4 ? "active" : ""}" data-pts="3">3</button>
        <button class="admin-pts-btn ${(template.maxPoints || 3) === 4 ? "active" : ""}" data-pts="4">4</button>
      </div>
    </div>

    <div class="admin-section-title">Activities & Notes</div>
    <div class="admin-list" id="mn-act-list">`;

  acts.forEach((a, idx) => {
    if (a.isHeading) {
      html += `<div class="admin-list-item mn-heading-item" data-idx="${idx}">
        <span class="drag-handle">⠿</span>
        <textarea class="admin-input mn-heading-input" id="mn-act-name-${idx}" data-idx="${idx}"
          rows="1" placeholder="Enter Section Heading" style="flex:1">${escHtml(a.name || "")}</textarea>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else if (a.isNote) {
      html += `<div class="admin-list-item admin-note-item" data-idx="${idx}">
        <span class="drag-handle">⠿</span>
        ${formatButtonsHtml(`mn-act-name-${idx}`)}
        <textarea class="admin-input mn-act-name-input" id="mn-act-name-${idx}" data-idx="${idx}"
          rows="1" placeholder="Enter Note"
          style="flex:1;overflow-y:hidden;resize:none">${escHtml(stripNoteHtml(a.text || ""))}</textarea>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else if (a.isMaintainHeading) {
      html += `<div class="admin-list-item mn-heading-item" data-idx="${idx}" style="background:#d1d5db">
        <span class="drag-handle">⠿</span>
        <textarea class="admin-input mn-heading-input" id="mn-act-name-${idx}" data-idx="${idx}"
          rows="1" placeholder="Enter Maintain Section Heading" style="flex:1;background:#d1d5db">${escHtml(a.name || "")}</textarea>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else if (a.isMaintain) {
      html += `<div class="admin-list-item" data-idx="${idx}" style="background:#f3f4f6;border:1px solid #d1d5db">
        <span class="drag-handle">⠿</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:.3rem">
          <div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-name-${idx}`)}
            <textarea class="admin-input mn-act-name-input" id="mn-act-name-${idx}" data-idx="${idx}"
              rows="1" placeholder="Activity name" style="flex:1">${escHtml(a.name || "")}</textarea>
          </div>
          <div style="display:flex;align-items:center;gap:.5rem">
            <span style="font-size:.75rem;color:#6b7280;white-space:nowrap;font-weight:600">Fixed Remark:</span>
            <textarea class="admin-input mn-maintain-remark-input" id="mn-act-mremark-${idx}" data-idx="${idx}"
              rows="1" placeholder="Read-Only Remark"
              style="flex:1;overflow-y:hidden;resize:none">${escHtml(a.maintainRemark || "")}</textarea>
          </div>
        </div>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    } else {
      const remarkTypeSelect = buildRemarkTypeControls(a, idx);
      const noteRow = a.actNote !== undefined
        ? `<div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-note-${idx}`)}
            <textarea class="admin-input mn-act-note-input" id="mn-act-note-${idx}" data-idx="${idx}"
              rows="1" placeholder="Enter Note"
              style="flex:1;overflow-y:hidden;resize:none">${escHtml(a.actNote || "")}</textarea>
          </div>`
        : "";
      html += `<div class="admin-list-item" data-idx="${idx}"${a.isMaintainLive ? ' style="background:#f3f4f6;border:1px solid #d1d5db"' : ''}>
        <span class="drag-handle">⠿</span>
        <div style="flex:1;display:flex;flex-direction:column;gap:.3rem">
          <div style="display:flex;align-items:flex-start;gap:.3rem">
            ${formatButtonsHtml(`mn-act-name-${idx}`)}
            <textarea class="admin-input mn-act-name-input" id="mn-act-name-${idx}" data-idx="${idx}"
              rows="1" placeholder="Enter Activity" style="flex:1">${escHtml(a.name || "")}</textarea>
          </div>
          ${noteRow}
          <div style="display:flex;align-items:center;gap:.5rem">
            <span style="font-size:.75rem;color:#6b7280;white-space:nowrap;font-weight:600">Remark Type:</span>
            ${remarkTypeSelect}
          </div>
        </div>
        <button class="btn-adm-del mn-del-act" data-idx="${idx}">🗑</button>
      </div>`;
    }
  });

  html += `</div>
    <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.25rem">
      <button class="btn-admin-add" id="btn-mn-add-act" style="flex:0 0 auto;width:auto">+ Add Activity</button>
      <button class="btn-admin-add" id="btn-mn-add-act-note" style="flex:0 0 auto;width:auto">+ Add Activity &amp; Note</button>
      <button class="btn-admin-add" id="btn-mn-add-heading" style="flex:0 0 auto;width:auto">+ Add Section Heading</button>
      <button class="btn-admin-add" id="btn-mn-add-note" style="flex:0 0 auto;width:auto">+ Add Note</button>
      <button class="btn-admin-add" id="btn-mn-add-maintain" style="flex:0 0 auto;width:auto">+ Add Maintain Activity (Fixed Remark)</button>
      <button class="btn-admin-add" id="btn-mn-add-maintain-live" style="flex:0 0 auto;width:auto">+ Add Maintain Activity</button>
      <button class="btn-admin-add" id="btn-mn-add-maintain-heading" style="flex:0 0 auto;width:auto">+ Add Maintain Section Heading</button>
    </div>
    <div style="margin-top:2rem;padding-bottom:1.5rem">
      <button class="btn-primary-sm" id="btn-mn-done-template"
        style="width:100%;padding:.75rem;margin-bottom:.75rem">Done</button>
      <button class="btn-adm-danger" id="btn-mn-del-template">Delete Template</button>
    </div>`;

  $("manage-modal-body").innerHTML = html;
  $("manage-modal-body").querySelectorAll(".admin-list-item textarea").forEach(autoResizeTextarea);

  const saveTemplateFn = async () => {
    const idx = state.templates.findIndex(t => t.id === template.id);
    if (idx >= 0) state.templates[idx] = template;
    await saveTemplate(template);
    await syncTemplateToStudents(template);
    showAutosaved();
  };

  _pendingActsCleanup = { acts, save: saveTemplateFn };

  initDragSort($("mn-act-list"), async newOrder => {
    const reordered = newOrder.map(oldIdx => acts[oldIdx]);
    reordered.forEach((a, i) => a.order = i);
    template.predefinedActivities = reordered;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("mn-t-name").addEventListener("blur", async () => {
    const v = $("mn-t-name").value.trim();
    if (!v || v === template.name) return;
    template.name = v;
    $("manage-modal-title").textContent = v;
    await saveTemplateFn();
    flashSaved($("mn-t-name"));
  });
  $("mn-t-name").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); $("mn-t-name").blur(); }
  });

  $("manage-modal-body").querySelectorAll(".admin-pts-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const newPts = Number(btn.dataset.pts);
      if (newPts === (template.maxPoints || 3)) return;
      template.maxPoints = newPts;
      $("manage-modal-body").querySelectorAll(".admin-pts-btn").forEach(b =>
        b.classList.toggle("active", b.dataset.pts === btn.dataset.pts));
      await saveTemplateFn();
    });
  });

  acts.forEach((a, idx) => {
    const input = $(`mn-act-name-${idx}`);
    if (a.isNote && input) {
      const resize = () => { input.style.height = "auto"; input.style.height = input.scrollHeight + "px"; };
      resize();
      let noteTimer;
      input.addEventListener("input", () => {
        resize();
        a.text = input.value;           // keep in-memory state in sync immediately
        clearTimeout(noteTimer);
        noteTimer = setTimeout(async () => { await saveTemplateFn(); }, 800);
      });
    }
    input?.addEventListener("blur", async () => {
      if (a.isNote) {
        const v = input.value;
        if (v === (a.text || "")) return;
        a.text = v;
      } else {
        const v = input.value.trim();
        if (!v || v === a.name) return;
        a.name = v;
      }
      await saveTemplateFn();
      flashSaved(input);
    });
    if (!a.isNote) input?.addEventListener("input", () => autoResizeTextarea(input));

    const noteInput = $(`mn-act-note-${idx}`);
    if (noteInput) {
      const resize = () => { noteInput.style.height = "auto"; noteInput.style.height = noteInput.scrollHeight + "px"; };
      resize();
      let actNoteTimer;
      noteInput.addEventListener("input", () => {
        resize();
        a.actNote = noteInput.value;
        clearTimeout(actNoteTimer);
        actNoteTimer = setTimeout(async () => { await saveTemplateFn(); }, 800);
      });
      noteInput.addEventListener("blur", async () => {
        if (noteInput.value === (a.actNote || "")) return;
        a.actNote = noteInput.value;
        await saveTemplateFn();
        flashSaved(noteInput);
      });
    }

    const maintainRemarkInput = $(`mn-act-mremark-${idx}`);
    if (maintainRemarkInput) {
      const resize = () => { maintainRemarkInput.style.height = "auto"; maintainRemarkInput.style.height = maintainRemarkInput.scrollHeight + "px"; };
      resize();
      let mrTimer;
      maintainRemarkInput.addEventListener("input", () => {
        resize();
        a.maintainRemark = maintainRemarkInput.value;
        clearTimeout(mrTimer);
        mrTimer = setTimeout(async () => { await saveTemplateFn(); }, 800);
      });
      maintainRemarkInput.addEventListener("blur", async () => {
        if (maintainRemarkInput.value === (a.maintainRemark || "")) return;
        a.maintainRemark = maintainRemarkInput.value;
        await saveTemplateFn();
        flashSaved(maintainRemarkInput);
      });
    }
  });

  $("manage-modal-body").querySelectorAll(".btn-fmt").forEach(btn => {
    // Prevent the textarea from losing focus/selection on click — by the
    // time "click" fires the selection would otherwise already be gone.
    btn.addEventListener("mousedown", e => e.preventDefault());
    btn.addEventListener("click", () => {
      const field = $(btn.dataset.inputId);
      if (!field) return;
      if (btn.classList.contains("btn-fmt-bullet")) {
        toggleBulletSelection(field);
      } else {
        wrapTextareaSelection(field, btn.classList.contains("btn-fmt-bold") ? "*" : "_");
      }
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-del-act").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.idx);
      const item = acts[idx];
      const label = item?.isHeading ? "section heading" : item?.isNote ? "reference note" : "activity";
      if (!confirm(`Delete this ${label}?`)) return;
      acts.splice(idx, 1);
      acts.forEach((a, i) => a.order = i);
      template.predefinedActivities = acts;
      await saveTemplateFn();
      const sp = $("manage-modal-body")?.scrollTop ?? 0;
      renderTemplateManageContent(template);
      requestAnimationFrame(() => { const b = $("manage-modal-body"); if (b) b.scrollTop = sp; });
    });
  });

  $("btn-mn-add-act").addEventListener("click", async () => {
    acts.push({ id: cfgId("a"), name: "", order: acts.length });
    template.predefinedActivities = acts;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("btn-mn-add-act-note").addEventListener("click", async () => {
    acts.push({ id: cfgId("a"), name: "", actNote: "", order: acts.length });
    template.predefinedActivities = acts;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("btn-mn-add-heading").addEventListener("click", async () => {
    acts.push({ id: cfgId("h"), isHeading: true, name: "", order: acts.length });
    template.predefinedActivities = acts;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("btn-mn-add-note").addEventListener("click", async () => {
    acts.push({ id: cfgId("n"), isNote: true, text: "", order: acts.length });
    template.predefinedActivities = acts;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("btn-mn-add-maintain").addEventListener("click", async () => {
    acts.push({ id: cfgId("mt"), isMaintain: true, name: "", maintainRemark: "", order: acts.length });
    template.predefinedActivities = acts;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("btn-mn-add-maintain-live").addEventListener("click", async () => {
    acts.push({ id: cfgId("ml"), isMaintainLive: true, name: "", order: acts.length });
    template.predefinedActivities = acts;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("btn-mn-add-maintain-heading").addEventListener("click", async () => {
    acts.push({ id: cfgId("mh"), isMaintainHeading: true, name: "", order: acts.length });
    template.predefinedActivities = acts;
    await saveTemplateFn();
    renderTemplateManageContent(template);
  });

  $("manage-modal-body").querySelectorAll(".mn-act-preset").forEach(sel => {
    sel.addEventListener("change", async () => {
      const idx = Number(sel.dataset.idx);
      const body = $("manage-modal-body");
      const starterInput  = body.querySelector(`.mn-act-starter-text[data-idx="${idx}"]`);
      const optsContainer = body.querySelector(`.mn-opts-container[data-idx="${idx}"]`);
      const type = sel.value;
      acts[idx].sentenceStarter = null;
      acts[idx].remarkPresetId  = null;
      acts[idx].inlineOptions   = null;
      acts[idx].optionsMulti    = (type === "fixed_multi" || type === "starter_fixed_multi");
      acts[idx].remarkHasNote   = (type === "starter_fixed_note");
      const starterVis = (type === "starter" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note");
      const optsVis    = (type === "fixed" || type === "fixed_multi" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note");
      starterInput.style.display  = starterVis ? "" : "none";
      starterInput.style.flex     = starterVis ? "1" : "";
      starterInput.style.minWidth = starterVis ? "0" : "";
      starterInput.style.width    = starterVis ? "auto" : "";
      optsContainer.style.display  = optsVis ? "" : "none";
      optsContainer.style.flex     = optsVis ? "1" : "";
      optsContainer.style.minWidth = optsVis ? "0" : "";
      if (type === "starter" || type === "starter_fixed" || type === "starter_fixed_multi" || type === "starter_fixed_note") { starterInput.focus(); }
      else if (type === "fixed" || type === "fixed_multi") { optsContainer.querySelector(".mn-opt-item")?.focus(); }
      else { template.predefinedActivities = acts; await saveTemplateFn(); }
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-act-starter-text").forEach(input => {
    input.addEventListener("blur", async () => {
      const idx = Number(input.dataset.idx);
      acts[idx].sentenceStarter = input.value.trim() || null;
      template.predefinedActivities = acts;
      await saveTemplateFn();
    });
  });

  const getTmplOptsFromDom = idx =>
    [...$("manage-modal-body").querySelectorAll(`.mn-opt-item[data-idx="${idx}"]`)]
      .map(i => i.value.trim()).filter(Boolean);

  const renumberTmplOpts = list => {
    list.querySelectorAll(".mn-opt-row").forEach((r, i) => {
      r.dataset.idx = i; // keep row data-idx in sync for drag-sort
      const n = r.querySelector(".mn-opt-num"); if (n) n.textContent = `${i + 1}.`;
      const inp = r.querySelector(".mn-opt-item"); if (inp) inp.dataset.oi = i;
      const del = r.querySelector(".mn-opt-del");  if (del) del.dataset.oi = i;
    });
  };

  const wireTmplOptDel = (btn, idx) => {
    btn.addEventListener("click", async () => {
      const list = btn.closest(".mn-opts-list");
      list.removeChild(btn.closest(".mn-opt-row"));
      renumberTmplOpts(list);
      acts[idx].inlineOptions = getTmplOptsFromDom(idx).join("/") || null;
      acts[idx].remarkPresetId = null;
      template.predefinedActivities = acts;
      await saveTemplateFn();
    });
  };

  const wireTmplOptBlur = (input, idx) => {
    input.addEventListener("blur", async () => {
      const newOptsStr = getTmplOptsFromDom(idx).join("/") || null;
      if (newOptsStr === acts[idx].inlineOptions) return;
      acts[idx].inlineOptions = newOptsStr;
      acts[idx].remarkPresetId = null;
      template.predefinedActivities = acts;
      await saveTemplateFn();
    });
  };

  $("manage-modal-body").querySelectorAll(".mn-opt-item").forEach(inp => wireTmplOptBlur(inp, Number(inp.dataset.idx)));
  $("manage-modal-body").querySelectorAll(".mn-opt-del").forEach(btn => wireTmplOptDel(btn, Number(btn.dataset.idx)));

  $("manage-modal-body").querySelectorAll(".mn-opts-list").forEach(list => {
    initDragSort(list, async () => {
      const idx = Number(list.closest(".mn-opts-container").dataset.idx);
      renumberTmplOpts(list);
      const newOptsStr = getTmplOptsFromDom(idx).join("/") || null;
      acts[idx].inlineOptions = newOptsStr;
      acts[idx].remarkPresetId = null;
      template.predefinedActivities = acts;
      await saveTemplateFn();
    });
  });

  $("manage-modal-body").querySelectorAll(".mn-opt-add").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const list = btn.closest(".mn-opts-container").querySelector(".mn-opts-list");
      const oi = list.querySelectorAll(".mn-opt-row").length;
      const row = document.createElement("div");
      row.className = "mn-opt-row admin-list-item";
      row.dataset.idx = String(oi);
      row.style.cssText = "display:flex;align-items:center;gap:.3rem;margin-bottom:.25rem";
      row.innerHTML =
        `<span class="drag-handle" style="cursor:grab;color:#c4c9d4;font-size:1rem;flex-shrink:0;padding:0 .1rem;user-select:none">⠿</span>` +
        `<span class="mn-opt-num" style="font-size:.74rem;color:#9ca3af;min-width:1.2rem;text-align:right;flex-shrink:0">${oi + 1}.</span>` +
        `<input class="admin-input mn-opt-item" data-idx="${idx}" data-oi="${oi}" placeholder="Enter option…" style="flex:1;padding:.3rem .45rem;font-size:.84rem;min-width:0">` +
        `<button class="mn-opt-del" data-idx="${idx}" data-oi="${oi}" title="Remove option" style="flex-shrink:0;padding:.2rem .4rem;font-size:.8rem;color:#9ca3af;background:none;border:1px solid #e5e7eb;border-radius:.3rem;cursor:pointer;line-height:1">×</button>`;
      list.appendChild(row);
      wireTmplOptBlur(row.querySelector(".mn-opt-item"), idx);
      wireTmplOptDel(row.querySelector(".mn-opt-del"), idx);
      row.querySelector(".mn-opt-item").focus();
    });
  });

  $("btn-mn-done-template").addEventListener("click", closeManageModal);

  $("btn-mn-del-template").addEventListener("click", async () => {
    if (!confirm(`Delete template "${template.name}"? Students using this template will keep their activities.`)) return;
    await deleteTemplate(template.id);
    state.templates = state.templates.filter(t => t.id !== template.id);
    closeManageModal();
  });
}

// ── Sync template changes to all students using it ────────────

async function syncTemplateToStudents(template) {
  const toSave = [];
  for (const student of state.students) {
    let changed = false;
    for (const target of student.targets) {
      if (target.templateId !== template.id) continue;
      target.name                 = template.name;
      target.predefinedActivities = JSON.parse(JSON.stringify(template.predefinedActivities || []));
      target.notes                = JSON.parse(JSON.stringify(template.notes || []));
      target.maxPoints            = template.maxPoints || 3;
      changed = true;
    }
    if (changed) toSave.push(student);
  }
  for (const student of toSave) await saveStudent(student);
}

// ============================================================
// GROUP SESSIONS
// ============================================================

// ── Choice modal ─────────────────────────────────────────────
function showGroupChoice(group) {
  $("session-picker-title").textContent = group.name;
  $("session-picker-list").innerHTML = `
    <div class="choice-list">
      <button class="choice-btn choice-today">
        <span class="choice-icon">▶️</span>
        <div class="choice-text"><div class="choice-label">Start Session</div></div>
      </button>
      <button class="choice-btn choice-other">
        <span class="choice-icon">🗂️</span>
        <div class="choice-text"><div class="choice-label">View/Edit Past Sessions</div></div>
      </button>
      <button class="choice-btn choice-manage">
        <span class="choice-icon">✏️</span>
        <div class="choice-text"><div class="choice-label">Manage Group</div></div>
      </button>
      <button class="choice-btn choice-export-excel">
        <span class="choice-icon">📊</span>
        <div class="choice-text"><div class="choice-label">Export to Excel (Yearly Summary)</div></div>
      </button>
      <button class="choice-btn choice-export-word">
        <span class="choice-icon">📝</span>
        <div class="choice-text"><div class="choice-label">Export to Word (Daily Session Note)</div></div>
      </button>
    </div>`;
  $("session-picker-modal").classList.remove("hidden");

  $("session-picker-list").querySelector(".choice-export-excel").addEventListener("click", () => {
    showGroupExportStudentPicker(group, "excel");
  });
  $("session-picker-list").querySelector(".choice-export-word").addEventListener("click", () => {
    showGroupExportStudentPicker(group, "word");
  });

  const today = getTodayString();
  $("session-picker-list").querySelector(".choice-today").addEventListener("click", () => {
    const yesterday = (() => {
      const d = new Date(today + "T00:00:00"); d.setDate(d.getDate() - 1);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    })();
    const fmtShort = d => {
      const [, m, day] = d.split("-");
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      return `${+day} ${months[+m - 1]}`;
    };
    $("session-picker-list").innerHTML = `
      <div class="session-date-step">
        <p class="session-date-prompt">What date is this session for?</p>
        <div class="date-quick-btns">
          <button class="btn-date-quick" data-date="${yesterday}">Yesterday (${fmtShort(yesterday)})</button>
          <button class="btn-date-quick" data-date="${today}">Today (${fmtShort(today)})</button>
          <button class="btn-date-other">Pick A Date</button>
        </div>
      </div>`;
    $("session-picker-list").querySelectorAll(".btn-date-quick").forEach(btn => {
      btn.addEventListener("click", () => {
        closeSessionPicker();
        openGroupSession(group, btn.dataset.date, group.students);
      });
    });
    $("session-picker-list").querySelector(".btn-date-other").addEventListener("click", () => {
      const [ty, tm] = today.split("-").map(Number);
      const displayDate = `${ty}-${String(tm).padStart(2,"0")}-01`;
      // Render immediately so iPad doesn't see a frozen UI while waiting for network
      renderGroupStartSessionCalendar(group, today, displayDate, new Set());
      // Then load taken dates and re-render with blue dots
      getRecentGroupSessions(group.id)
        .then(sessions => {
          const takenDates = new Set(sessions.map(s => s.date));
          renderGroupStartSessionCalendar(group, today, displayDate, takenDates);
        })
        .catch(() => {});
    });
  });
  $("session-picker-list").querySelector(".choice-other").addEventListener("click", () => {
    closeSessionPicker();
    showGroupSessionPicker(group);
  });
  $("session-picker-list").querySelector(".choice-manage").addEventListener("click", () => {
    closeSessionPicker();
    openGroupManageModal(group);
  });
}

// ── Open group session ───────────────────────────────────────
async function openGroupSession(group, dateStr, attendees) {
  attendees = (attendees || []).filter(Boolean);
  // Same reasoning as openSession's preservedTargetName above — jumping to
  // another date for the SAME group should keep the currently-viewed
  // target, not reset to the first one in sort order.
  const preservedGroupTargetName = state.currentGroup?.id === group.id ? state.selectedGroupTargetName : null;
  if (state.fbGroupUnsubscribe) { state.fbGroupUnsubscribe(); state.fbGroupUnsubscribe = null; }
  state.entryGroupRemarkSaver?.cleanup();
  state.entryGroupRemarkSaver = setupEntryRemarkSaving($("group-target-content"), () => state.groupSessionId, () => {
    if (!state.groupRenderPending || state.entryGroupActionsInFlight > 0) return;
    state.groupRenderPending = false;
    renderGroupTargetContent();
  });
  state.currentGroup            = group;
  state.groupAttendees          = attendees;
  state.groupSessionId          = null;
  state.groupSessionData        = null;
  state.selectedGroupTargetName = null;
  state.groupRenderPending      = false;

  showScreen("screen-group-session");
  $("group-session-name").textContent = group.name;
  $("group-target-content").innerHTML = `<div class="loading">Loading…</div>`;

  const gotoEntryBtn = $("btn-group-entry-goto-session");
  if (gotoEntryBtn) {
    gotoEntryBtn.classList.remove("hidden");
    gotoEntryBtn.onclick = () => showGoToAnotherGroupSessionForEntry(group);
  }

  try {
    const sid = await getOrCreateGroupSessionForDate(group.id, dateStr, group.targets, attendees, group.studentLinks || {});
    state.groupSessionId = sid;
    let firstLoad = true;
    state.fbGroupUnsubscribe = listenToSession(sid, async data => {
      state.groupSessionData = data;
      renderGroupSessionHeader(data);
      if (firstLoad) {
        firstLoad = false;
        const stillValid = preservedGroupTargetName && group.targets.some(t => t.name === preservedGroupTargetName);
        state.selectedGroupTargetName = stillValid ? preservedGroupTargetName : (sortTargetsByOrder(group.targets)[0]?.name || null);
        populateGroupTargetDropdown(group.targets);
        if (state.selectedGroupTargetName) {
          try {
            const filled = await autoFillGroupSession(group, sid, data, state.selectedGroupTargetName, attendees);
            if (filled > 0) return;
            const mappedFilled = await autoFillGroupMappedRemarks(group, sid, data, state.selectedGroupTargetName, attendees);
            if (mappedFilled > 0) return;
            const structuredFilled = await autoFillGroupStructuredRemarks(group, sid, data, state.selectedGroupTargetName, attendees);
            if (structuredFilled > 0) return;
          } catch (err) { console.error("Group session auto-fill failed:", err); }
        }
      }
      if (state.scorePicker?.open && state.scorePicker?.isGroup) renderScoreModalTrials(state.scorePicker.remId);
      // Busy = dropdown open, or a button's own multi-step write still in
      // flight — see the matching comment in openSession's listener for why
      // a focused box never needs to defer a render here.
      const isGroupEntryBusy = () => document.activeElement === $("group-target-select")
        || state.entryGroupActionsInFlight > 0;
      if (isGroupEntryBusy()) {
        state.groupRenderPending = true;
        return;
      }
      state.groupRenderPending = false;
      // Re-check at fire time — see the matching comment in openSession's listener.
      setTimeout(() => {
        if (isGroupEntryBusy()) { state.groupRenderPending = true; }
        else { renderGroupTargetContent(); }
      }, 0);
    });
  } catch (err) {
    alert("Error opening session: " + err.message);
    showHome();
  }
}

function renderGroupSessionHeader(data) {
  if (!data) return;
  $("group-session-meta").textContent =
    `Session ${data.sessionNumber} of ${(data.month || "").split(" ")[0]} · ${formatDate(data.date)}`;
}

function populateGroupTargetDropdown(targets) {
  const sel = $("group-target-select");
  if (!sel) return;
  const sorted = sortTargetsByOrder(targets);
  const placeholder = sorted.length === 0
    ? `<option value="" disabled selected>— no targets yet —</option>` : "";
  sel.innerHTML = placeholder +
    sorted.map(t =>
      `<option value="${escHtml(t.name)}"${t.name === state.selectedGroupTargetName ? " selected" : ""}>${escHtml(t.name)}</option>`
    ).join("") +
    `<option value="__add_target__">+ Add Target…</option>`;

  const manageBtn = $("btn-group-manage-targets");
  if (manageBtn) {
    manageBtn.classList.toggle("hidden", !state.selectedGroupTargetName);
    manageBtn.onclick = () => {
      const tgt = state.currentGroup?.targets.find(t => t.name === state.selectedGroupTargetName);
      if (tgt) openGroupManageModal(state.currentGroup, tgt);
    };
  }

  const reorderBtn = $("btn-group-reorder-targets");
  if (reorderBtn) {
    reorderBtn.classList.toggle("hidden", targets.length < 2);
    reorderBtn.onclick = () => showGroupTargetReorderList(state.currentGroup);
  }

  // Wire change handler — same pattern as individual session's populateTargetDropdown
  sel.onchange = async () => {
    if (sel.value === "__add_target__") {
      sel.value = state.selectedGroupTargetName || "";
      const group = state.currentGroup;
      if (group) showGroupAddTargetPicker(group);
      return;
    }
    const prevTarget = state.selectedGroupTargetName;
    // Flush any not-yet-saved typing on the target we're leaving before the
    // cleanup below decides what's "empty" — see openSession's target dropdown
    // for the same fix on the individual side.
    await state.entryGroupRemarkSaver?.flush();
    state.selectedGroupTargetName = sel.value || null;
    if (prevTarget && prevTarget !== sel.value) {
      const prevTargetObj = (state.currentGroup?.targets || []).find(t => t.name === prevTarget);
      cleanupEmptyEntries(state.groupSessionId, state.groupSessionData, prevTarget, prevTargetObj).catch(() => {});
    }
    // See individual session's populateTargetDropdown for why this matters:
    // a <select> keeps focus after its own change event, and nothing else
    // would naturally blur it now that button clicks inside the content
    // host don't — so the busy-check would treat it as permanently "still
    // choosing" and block every future render.
    sel.blur();
    if (!state.selectedGroupTargetName) { renderGroupTargetContent(); return; }
    const data = state.groupSessionData;
    if (data) {
      try {
        const filled = await autoFillGroupSession(
          state.currentGroup, state.groupSessionId, data,
          state.selectedGroupTargetName, state.groupAttendees
        );
        if (filled > 0) return;
        const mappedFilled = await autoFillGroupMappedRemarks(
          state.currentGroup, state.groupSessionId, data,
          state.selectedGroupTargetName, state.groupAttendees
        );
        if (mappedFilled > 0) return;
        const structuredFilled = await autoFillGroupStructuredRemarks(
          state.currentGroup, state.groupSessionId, data,
          state.selectedGroupTargetName, state.groupAttendees
        );
        if (structuredFilled > 0) return;
      } catch (err) { console.error("Group target auto-fill failed:", err); }
    }
    renderGroupTargetContent();
  };
}

// ── Auto-fill activity + remark stubs for predefined activities ──
async function autoFillGroupSession(group, sessionId, data, targetName, attendees) {
  const target = group.targets.find(t => t.name === targetName);
  if (!target) return 0;
  let created = 0;
  const predefined = (target.predefinedActivities || []).filter(pa => !pa.isHeading && !pa.isNote);
  for (const pa of predefined) {
    const hasActivity = Object.values(data.activities || {})
      .some(a => a.targetName === targetName && a.activityName === pa.name);
    if (!hasActivity) {
      await addActivity(sessionId, targetName, pa.name, Date.now(), true);
      created++;
    }
  }
  return created;
}

// Group-entry counterpart of autoFillMappedRemarks — only checks the
// currently selected target (group activity stubs are filled in lazily per
// selected target too, via autoFillGroupSession above, not for every target
// up front), per attendee. Call only after confirming autoFillGroupSession
// didn't just create a brand-new stub for this target — that write triggers
// its own snapshot, which gets a fresh look at this on the next pass.
async function autoFillGroupMappedRemarks(group, sessionId, data, targetName, attendees) {
  const target = group.targets.find(t => t.name === targetName);
  if (!target) return 0;
  let count = 0;
  for (const pa of (target.predefinedActivities || [])) {
    if (pa.isCompleted || pa.isArchived) continue;
    if (!pa.isMapped) continue;
    const existingAct = Object.entries(data.activities || {})
      .find(([, a]) => a.targetName === targetName && a.activityName === pa.name);
    const actId = existingAct?.[0];
    if (!actId) continue;
    for (const studentName of attendees) {
      const hasRemark = Object.values(data.remarks || {})
        .some(r => r.activityId === actId && r.studentName === studentName);
      if (hasRemark) continue;
      const key = `${sessionId}:${targetName}:${pa.name}:${studentName}`;
      if (mappedRemarkAutoFillInFlight.has(key)) continue;
      mappedRemarkAutoFillInFlight.add(key);
      try {
        await addGroupRemark(sessionId, actId, studentName, "");
        count++;
      } finally {
        mappedRemarkAutoFillInFlight.delete(key);
      }
    }
  }
  return count;
}

const structuredRemarkAutoFillInFlight = new Set();

// Group-entry counterpart of autoFillStructuredRemarks — creates one empty
// remark per attendee for every "pick from options" activity on the
// selected target (group activity stubs are filled in lazily per selected
// target, not for every target up front — see autoFillGroupSession). The
// in-flight guard mirrors autoFillGroupMappedRemarks's: addGroupRemark is
// awaited per attendee, so a second snapshot landing mid-loop could
// otherwise re-enter and double-add before the first write commits.
async function autoFillGroupStructuredRemarks(group, sessionId, data, targetName, attendees) {
  const target = group.targets.find(t => t.name === targetName);
  if (!target) return 0;
  let count = 0;
  for (const pa of (target.predefinedActivities || [])) {
    if (pa.isCompleted || pa.isArchived) continue;
    if (!isAutoOpenRemarkType(pa)) continue;
    const existingAct = Object.entries(data.activities || {})
      .find(([, a]) => a.targetName === targetName && a.activityName === pa.name);
    const actId = existingAct?.[0];
    if (!actId) continue;
    for (const studentName of attendees) {
      const hasRemark = Object.values(data.remarks || {})
        .some(r => r.activityId === actId && r.studentName === studentName);
      if (hasRemark) continue;
      const key = `${sessionId}:${targetName}:${pa.name}:${studentName}`;
      if (structuredRemarkAutoFillInFlight.has(key)) continue;
      structuredRemarkAutoFillInFlight.add(key);
      try {
        await addGroupRemark(sessionId, actId, studentName, "");
        count++;
      } finally {
        structuredRemarkAutoFillInFlight.delete(key);
      }
    }
  }
  return count;
}

async function leaveGroupSession() {
  commitTextEditorSheet();
  $("text-editor-sheet").classList.add("hidden");
  // Flush any not-yet-saved typing while the Firestore listener is still
  // live, so state.groupSessionData reflects it before we decide what's "empty".
  await state.entryGroupRemarkSaver?.flush();
  state.entryGroupRemarkSaver?.cleanup();
  state.entryGroupRemarkSaver = null;
  if (state.fbGroupUnsubscribe) { state.fbGroupUnsubscribe(); state.fbGroupUnsubscribe = null; }
  const sessionId = state.groupSessionId;
  const data      = state.groupSessionData;
  const group     = state.currentGroup;
  state.currentGroup            = null;
  state.groupSessionId          = null;
  state.groupSessionData        = null;
  state.groupAttendees          = [];
  state.groupRenderPending      = false;
  state.selectedGroupTargetName = null;

  if (sessionId && data) {
    // Delete if no useful data
    const hasData = Object.values(data.remarks || {}).some(r => {
      const strip = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
      return strip(r.text).length > 0 || (r.trials || []).some(t => t !== -1);
    });
    if (!hasData) {
      deleteSession(sessionId).catch(() => {});
    } else {
      const allTargetNames = new Set(Object.values(data.activities || {}).map(a => a.targetName));
      allTargetNames.forEach(name => {
        const target = (group?.targets || []).find(t => t.name === name);
        cleanupEmptyEntries(sessionId, data, name, target).catch(() => {});
      });
    }
  }
  showHome();
}

$("btn-group-back").addEventListener("click", leaveGroupSession);

// ── Render group target content ──────────────────────────────
function renderGroupTargetContent() {
  const content = $("group-target-content");
  if (!content) return;
  const group   = state.currentGroup;
  const data    = state.groupSessionData;
  const target  = group?.targets.find(t => t.name === state.selectedGroupTargetName);
  if (!target || !data) {
    content.innerHTML = `<p class="empty-hint" contenteditable="false" style="padding:2rem;text-align:center">No targets added yet. Use the dropdown above to add one.</p>`;
    updateGroupAvgChips(null, null);
    return;
  }

  const attendees = state.groupAttendees;
  const groupLayout = target.groupLayout || "byActivity";
  const items = groupLayout === "byStudent"
    ? buildGroupItemsByStudent(target, data, attendees)
    : buildGroupItemsByActivity(target, data, attendees);

  items.push(`<button class="btn-add-activity btn-group-add-activity" contenteditable="false">+ Add Activity (This activity only appears in this session)</button>`);

  const scrollHost = content.closest(".session-body");
  const scrollTop  = scrollHost?.scrollTop;
  const captured = captureActiveEditState(content);
  content.innerHTML = items.join("");
  updateGroupAvgChips(target, data);
  attachGroupTargetListeners(target);
  restoreActiveEditState(content, captured);
  if (scrollHost) scrollHost.scrollTop = scrollTop;
}

// "Group students together": activity is the heading, students are listed underneath
function buildGroupItemsByActivity(target, data, attendees) {
  const items = [];

  // Predefined activities (with heading and note support)
  for (const pa of (target.predefinedActivities || [])) {
    if (pa.isNote) {
      if (pa.text) items.push(`<div class="activity-note-heading" contenteditable="false">${noteToHtml(pa.text)}</div>`);
      continue;
    }
    if (pa.isHeading) {
      items.push(`<div class="activity-group-heading" contenteditable="false">${escHtml(pa.name)}</div>`);
      continue;
    }
    if (pa.isCompleted || pa.isArchived || pa.isStopped || pa.isMaintain || pa.isMaintainHeading) continue;
    const actId = Object.entries(data.activities || {})
      .find(([, a]) => a.targetName === target.name && a.activityName === pa.name)?.[0] || null;
    items.push(renderGroupActivityCard(pa.name, actId, target, data, attendees, pa.actNote, pa.isMapped ? pa : null, pa, true));
  }

  // Manually added (non-predefined) activities
  Object.entries(data.activities || {})
    .filter(([, a]) => a.targetName === target.name && !a.isPredefined)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .forEach(([actId, act]) => {
      items.push(renderGroupActivityCard(act.activityName, actId, target, data, attendees));
    });

  if (items.length === 0) {
    items.push(`<p class="empty-hint" contenteditable="false" style="padding:1.5rem">No activities yet. Add them under Edit Target.</p>`);
  }
  return items;
}

// "Group activities together": student is the heading, activities are listed underneath
function buildGroupItemsByStudent(target, data, attendees) {
  if (attendees.length === 0) {
    return [`<p class="empty-hint" contenteditable="false" style="padding:1.5rem">No attendees selected for this session.</p>`];
  }
  const items = attendees.map(studentName => renderGroupStudentBlock(studentName, target, data));
  return items;
}

function renderGroupStudentBlock(studentName, target, data) {
  // Section headings/notes aren't tied to a specific student, so they're skipped here —
  // only actual scoreable activities make sense nested under a student.
  const activityEntries = [];
  for (const pa of (target.predefinedActivities || [])) {
    if (pa.isNote || pa.isHeading || pa.isCompleted || pa.isArchived || pa.isStopped || pa.isMaintain || pa.isMaintainHeading || !pa.name) continue;
    const actId = Object.entries(data.activities || {})
      .find(([, a]) => a.targetName === target.name && a.activityName === pa.name)?.[0] || null;
    activityEntries.push({ actId, actName: pa.name, actNote: pa.actNote, pa });
  }
  Object.entries(data.activities || {})
    .filter(([, a]) => a.targetName === target.name && !a.isPredefined)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .forEach(([actId, act]) => activityEntries.push({ actId, actName: act.activityName }));

  const cards = activityEntries.length
    ? activityEntries.map(({ actId, actName, actNote, pa }) =>
        renderGroupStudentActivityCard(studentName, actName, actId, target, data, actNote, pa?.isMapped ? pa : null)).join("")
    : `<p class="empty-hint" contenteditable="false" style="padding:1rem">No activities yet. Add them under Edit Target.</p>`;

  return `<div class="group-by-student-block" data-student="${escHtml(studentName)}">
    <div class="activity-group-heading" contenteditable="false">${liveGroupAttendeeLabel(studentName)}</div>
    ${cards}
  </div>`;
}

function renderGroupStudentActivityCard(studentName, actName, actId, target, data, actNote = null, mappedPa = null) {
  const remarksForThisStudent = actId
    ? Object.entries(data.remarks || {})
        .filter(([, r]) => r.activityId === actId && r.studentName === studentName)
        .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    : [];

  const noteRow = actNote && actNote.trim()
    ? `<div class="entry-field" contenteditable="false">
        <span class="field-label">Note</span>
        <span class="field-value-note">${formatActivityMarkup(actNote)}</span>
      </div>`
    : "";

  let html = `<div class="entry-block entry-block-predefined" data-act-name="${escHtml(actName)}" data-act-id="${escHtml(actId || "")}">
    <div class="entry-field" contenteditable="false">
      <span class="field-label">Activity</span>
      <span class="field-value-fixed">${formatActivityMarkup(actName)}</span>
    </div>
    ${noteRow}`;

  const mappedInfo = mappedPa ? resolveGroupMappedScoreDisplay(mappedPa, target, data, studentName) : null;

  for (const [remId, rem] of remarksForThisStudent) {
    html += renderGroupStudentRowCompact(remId, rem, target, mappedInfo);
  }

  html += remarksForThisStudent.length === 0
    ? `<button class="btn-add-remark btn-group-add-remark-pending" contenteditable="false"
        data-student="${escHtml(studentName)}"
        data-act-id="${escHtml(actId || "")}"
        data-act-name="${escHtml(actName)}"
        data-target="${escHtml(target.name)}">+ Add Remark${mappedPa ? "" : " &amp; Trials"}</button>`
    : `<button class="btn-add-remark btn-group-add-remark-student-more" contenteditable="false"
        data-act-id="${escHtml(actId || "")}"
        data-student="${escHtml(studentName)}">+ Add Remark${mappedPa ? "" : " &amp; Trials"}</button>`;

  html += `</div>`;
  return html;
}

// Live-entry-screen counterpart of groupAttendeeLabel (View/Edit Past
// Sessions) — same idea, reads the live screen's globals instead.
function liveGroupAttendeeLabel(studentName) {
  return escHtml(studentName);
}

function firstNameOf(name) {
  return (name || "").trim().split(/\s+/)[0] || name;
}

function renderGroupStudentRowCompact(remId, rem, target, mappedInfo = null) {
  const trials = rem.trials || [];
  const badges = trials.map((t, i) =>
    `<span class="trial-badge">${t === -1 ? "—" : t}<button class="btn-trial-delete btn-group-trial-del" data-rem-id="${remId}" data-idx="${i}">×</button></span>`
  ).join("");
  const trailingField = mappedInfo
    ? `<div class="entry-field" contenteditable="false">
        <span class="field-label">${escHtml(mappedInfo.label)}</span>
        <span class="field-value-fixed">${mappedInfo.pct !== null ? mappedInfo.pct + "%" : "—"}</span>
      </div>`
    : `<div class="entry-field" contenteditable="false">
        <span class="field-label">Trials</span>
        <div class="trials-row">
          <div class="trials-badges">${badges}</div>
          <button class="btn-primary-sm btn-add-trial btn-group-add-trial"
            data-rem-id="${remId}" data-target="${escHtml(target.name)}">+ Trial</button>
        </div>
      </div>`;
  return `
    <div class="entry-divider" contenteditable="false"></div>
    <div class="entry-field">
      <span class="field-label" contenteditable="false">Remark</span>
      <button class="btn-sketch btn-group-sketch" contenteditable="false" data-rem-id="${remId}" aria-label="Open sketch board">✏</button>
      <textarea class="field-input group-remark-input" rows="1"
        data-rem-id="${remId}" placeholder="Remark…"
        data-saved-html="${escHtml(rem.text || "")}">${escHtml(plainTextForEdit(rem.text))}</textarea>
      <button class="btn-icon btn-group-del-student-remark" contenteditable="false" data-rem-id="${remId}" title="Delete remark">🗑</button>
    </div>
    ${trailingField}`;
}

function renderGroupActivityCard(actName, actId, target, data, attendees, actNote = null, mappedPa = null, paEntry = null, isPredefined = false) {
  // Free-text activities (no preset options, no sentence starter) get a
  // ready-to-type empty box for a pending attendee instead of a "+ Add
  // Remark & Trials" button once the card is already expanded (see
  // renderGroupStudentEmptyRow) — preset-option/sentence-starter activities
  // have no typeable free text, so those still need the explicit button.
  const inlineOptions   = paEntry ? getActivityInlineOptions(paEntry) : null;
  const sentenceStarter = paEntry?.sentenceStarter || null;
  const multiSelect     = paEntry?.optionsMulti || false;
  const remarkHasNote   = paEntry?.remarkHasNote || false;
  const isFreeText      = parseOpts(inlineOptions).length === 0 && !sentenceStarter;

  const noteRow = actNote && actNote.trim()
    ? `<div class="entry-field" contenteditable="false">
        <span class="field-label">Note</span>
        <span class="field-value-note">${formatActivityMarkup(actNote)}</span>
      </div>`
    : "";

  // Mapped-score activities have no trials/combine-remarks concept at all —
  // bypass the rounds/combine machinery below entirely and just list every
  // attendee's own remark + their own per-attendee mapped score.
  if (mappedPa) {
    const rows = attendees.map(studentName => {
      const remarks = actId
        ? Object.entries(data.remarks || {})
            .filter(([, r]) => r.activityId === actId && r.studentName === studentName)
            .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
        : [];
      if (remarks.length === 0) return renderGroupStudentPendingRow(studentName, actId, actName, target, true);
      const mappedInfo = resolveGroupMappedScoreDisplay(mappedPa, target, data, studentName);
      return remarks.map(([remId, rem]) => renderGroupStudentRow(
        studentName, remId, rem, target, mappedInfo, inlineOptions, sentenceStarter, multiSelect, remarkHasNote
      )).join("");
    }).join("");
    return `<div class="entry-block entry-block-predefined" data-act-name="${escHtml(actName)}" data-act-id="${escHtml(actId || "")}">
      <div class="entry-field" contenteditable="false">
        <span class="field-label">Activity</span>
        <span class="field-value-fixed">${formatActivityMarkup(actName)}</span>
      </div>
      ${noteRow}
      <div class="entry-divider" contenteditable="false"></div>
      ${rows}
    </div>`;
  }

  const combineRemarks = !!(actId && data.activities?.[actId]?.combineRemarks);
  const combineToggle = actId
    ? `<button class="btn-combine-toggle ${combineRemarks ? "active" : ""}" data-act-id="${escHtml(actId)}"
        title="${combineRemarks ? "Split back into separate remark boxes" : "Share one remark box for everyone in this activity"}">
        ${combineRemarks ? "Combined Remarks" : "Separate Remarks"}
      </button>`
    : "";

  // Check if any attendee already has a remark for this activity
  const anyExpanded = actId && Object.values(data.remarks || {})
    .some(r => r.activityId === actId && attendees.includes(r.studentName));

  // Collapsed: no data yet → single "+ Add Remark & Trials" button (like individual session)
  if (!anyExpanded) {
    return `<div class="entry-block entry-block-predefined" data-act-name="${escHtml(actName)}" data-act-id="${escHtml(actId || "")}">
      <div class="entry-field" contenteditable="false">
        <span class="field-label">Activity</span>
        <span class="field-value-fixed">${formatActivityMarkup(actName)}</span>
        ${combineToggle}
      </div>
      ${noteRow}
      <button class="btn-add-remark btn-group-add-remark-all" contenteditable="false"
        data-act-id="${escHtml(actId || "")}"
        data-act-name="${escHtml(actName)}"
        data-target="${escHtml(target.name)}">+ Add Remark &amp; Trials</button>
    </div>`;
  }

  // Expanded: group remarks into rounds paired by creation order
  const byStudent = {};
  for (const studentName of attendees) {
    byStudent[studentName] = Object.entries(data.remarks || {})
      .filter(([, r]) => r.activityId === actId && r.studentName === studentName)
      .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0));
  }
  const maxRounds = Math.max(...Object.values(byStudent).map(arr => arr.length), 0);

  const roundHtmls = [];
  for (let i = 0; i < maxRounds; i++) {
    const presentEntries = [];
    const pendingNames = [];
    for (const studentName of attendees) {
      const entry = byStudent[studentName]?.[i] || null;
      if (entry) presentEntries.push([studentName, entry[0], entry[1]]);
      else pendingNames.push(studentName);
    }
    const roundRemIds = presentEntries.map(([, remId]) => remId);

    let bodyHtml;
    if (combineRemarks && presentEntries.length > 0) {
      const sharedText = presentEntries[0][2].text;
      bodyHtml = renderGroupCombinedRemarkRow(roundRemIds, sharedText)
        + presentEntries.map(([studentName, remId, rem]) =>
            renderGroupStudentTrialsOnlyRow(studentName, remId, rem, target)).join("")
        + pendingNames.map(studentName =>
            renderGroupStudentPendingRow(studentName, actId, actName, target)).join("");
    } else {
      bodyHtml = attendees.map(studentName => {
        const entry = byStudent[studentName]?.[i] || null;
        if (entry) return renderGroupStudentRow(
          studentName, entry[0], entry[1], target, null, inlineOptions, sentenceStarter, multiSelect, remarkHasNote
        );
        return isFreeText
          ? renderGroupStudentEmptyRow(studentName, actId, actName, target, isPredefined)
          : renderGroupStudentPendingRow(studentName, actId, actName, target);
      }).join("");
    }

    roundHtmls.push(`<div class="group-remark-round">
      ${bodyHtml}
      <div class="group-round-footer" contenteditable="false">
        <button class="btn-icon btn-group-del-round"
          data-rem-ids="${roundRemIds.join(",")}" title="Remove">🗑</button>
      </div>
    </div>`);
  }

  const roundsBody = roundHtmls.map((r, i) =>
    (i > 0 ? `<div class="entry-divider entry-divider-round" contenteditable="false"></div>` : ``) + r
  ).join("");

  return `<div class="entry-block entry-block-predefined" data-act-name="${escHtml(actName)}" data-act-id="${escHtml(actId || "")}">
    <div class="entry-field" contenteditable="false">
      <span class="field-label">Activity</span>
      <span class="field-value-fixed">${formatActivityMarkup(actName)}</span>
      ${combineToggle}
    </div>
    ${noteRow}
    <div class="entry-divider" contenteditable="false"></div>
    ${roundsBody}
    <div class="entry-divider" contenteditable="false"></div>
    <button class="btn-add-remark btn-group-add-remark-more" contenteditable="false"
      data-act-id="${escHtml(actId || "")}"
      data-act-name="${escHtml(actName)}"
      data-target="${escHtml(target.name)}">+ Add Remark &amp; Trials</button>
  </div>`;
}

// Shared remark box used by all students in a round when "Combine" is active
function renderGroupCombinedRemarkRow(remIds, text) {
  const idList = remIds.join(",");
  return `<div class="entry-field">
    <span class="field-label" contenteditable="false">Remark</span>
    <button class="btn-sketch btn-group-sketch-combined" contenteditable="false" data-rem-ids="${idList}" aria-label="Open sketch board">✏</button>
    <textarea class="field-input group-remark-input-combined" rows="1"
      data-rem-ids="${idList}" placeholder="Remark…"
      data-saved-html="${escHtml(text || "")}">${escHtml(plainTextForEdit(text))}</textarea>
  </div>`;
}

// Per-student name + trials only (remark is shared, rendered separately above)
function renderGroupStudentTrialsOnlyRow(studentName, remId, rem, target) {
  const trials = rem.trials || [];
  const badges = trials.map((t, i) =>
    `<span class="trial-badge">${t === -1 ? "—" : t}<button class="btn-trial-delete btn-group-trial-del" data-rem-id="${remId}" data-idx="${i}">×</button></span>`
  ).join("");
  return `<div class="group-student-section" data-rem-id="${remId}" data-student="${escHtml(studentName)}">
    <div class="group-student-name-row" contenteditable="false">
      <span class="group-student-name-label">${liveGroupAttendeeLabel(studentName)}</span>
    </div>
    <div class="entry-field" contenteditable="false">
      <span class="field-label">Trials</span>
      <div class="trials-row">
        <div class="trials-badges">${badges}</div>
        <button class="btn-primary-sm btn-add-trial btn-group-add-trial"
          data-rem-id="${remId}" data-target="${escHtml(target.name)}">+ Trial</button>
      </div>
    </div>
  </div>`;
}

// Group-entry counterpart of renderRemarkFields — same option-pill/sentence-
// starter/notes markup (reusing the same generic CSS classes/save-wiring),
// just with .group-remark-input instead of .remark-text-input for the
// free-text fallback box, since this row is one attendee's slice of a
// shared-activity card instead of a single student's own remark field.
function renderGroupStudentRow(studentName, remId, rem, target, mappedInfo = null, inlineOptions = null, sentenceStarter = null, multiSelect = false, remarkHasNote = false) {
  const trials = rem.trials || [];
  const badges = trials.map((t, i) =>
    `<span class="trial-badge">${t === -1 ? "—" : t}<button class="btn-trial-delete btn-group-trial-del" data-rem-id="${remId}" data-idx="${i}">×</button></span>`
  ).join("");
  const trailingField = mappedInfo
    ? `<div class="entry-field" contenteditable="false">
        <span class="field-label">${escHtml(mappedInfo.label)}</span>
        <span class="field-value-fixed">${mappedInfo.pct !== null ? mappedInfo.pct + "%" : "—"}</span>
      </div>`
    : `<div class="entry-field" contenteditable="false">
        <span class="field-label">Trials</span>
        <div class="trials-row">
          <div class="trials-badges">${badges}</div>
          <button class="btn-primary-sm btn-add-trial btn-group-add-trial"
            data-rem-id="${remId}" data-target="${escHtml(target.name)}">+ Trial</button>
        </div>
      </div>`;

  const opts = parseOpts(inlineOptions);
  function makeOptPills(remText) {
    if (opts.length === 0) return null;
    if (multiSelect) {
      const sel = (remText || "").split(", ").map(s => s.trim()).filter(Boolean);
      return `<div class="remark-preset-opts remark-preset-opts-multi" contenteditable="false">${opts.map(opt =>
        `<button class="btn-remark-opt${sel.includes(opt) ? " active" : ""}"
          data-rem-id="${remId}" data-opt="${escHtml(opt)}">${escHtml(opt)}</button>`
      ).join("")}</div>`;
    }
    return `<div class="remark-preset-opts" contenteditable="false">${opts.map(opt =>
      `<button class="btn-remark-opt${remText === opt ? " active" : ""}"
        data-rem-id="${remId}" data-opt="${escHtml(opt)}">${escHtml(opt)}</button>`
    ).join("")}</div>`;
  }

  const freeTextBox = `<textarea class="field-input group-remark-input" rows="1"
      data-rem-id="${remId}" placeholder="Remark…"
      data-saved-html="${escHtml(rem.text || "")}">${escHtml(plainTextForEdit(rem.text))}</textarea>`;

  const sketchBtn = opts.length === 0
    ? `<button class="btn-sketch btn-group-sketch" contenteditable="false" data-rem-id="${remId}" aria-label="Sketch">✏</button>`
    : "";

  let remarkContent;
  if (sentenceStarter) {
    const starterClass = opts.length > 0 ? "remark-starter-wrap remark-starter-wrap--opts" : "remark-starter-wrap";
    remarkContent = `<div class="${starterClass}">
      <span class="remark-starter-prefix" contenteditable="false">${escHtml(sentenceStarter)}</span>
      ${makeOptPills(rem.text) || freeTextBox}
    </div>`;
  } else {
    remarkContent = makeOptPills(rem.text) || freeTextBox;
  }

  const noteField = remarkHasNote
    ? `<div class="entry-field" contenteditable="false">
        <span class="field-label">Notes</span>
        <button class="btn-sketch btn-group-sketch" data-rem-id="${remId}" aria-label="Open sketch board">✏</button>
        <textarea class="field-input mastery-note-input" rows="1"
          data-rem-id="${remId}" placeholder="Notes…"
          data-saved-html="${escHtml(rem.masteryNote || "")}">${escHtml(plainTextForEdit(rem.masteryNote || ""))}</textarea>
      </div>`
    : "";

  return `<div class="group-student-section" data-rem-id="${remId}" data-student="${escHtml(studentName)}">
    <div class="group-student-name-row" contenteditable="false">
      <span class="group-student-name-label">${liveGroupAttendeeLabel(studentName)}</span>
    </div>
    <div class="entry-field">
      <span class="field-label" contenteditable="false">Remark</span>
      ${sketchBtn}
      ${remarkContent}
      <button class="btn-icon btn-group-del-student-remark" contenteditable="false" data-rem-id="${remId}" title="Delete remark">🗑</button>
    </div>
    ${noteField}
    ${trailingField}
  </div>`;
}

function renderGroupStudentPendingRow(studentName, actId, actName, target, mapped = false) {
  return `<div class="group-student-section group-student-pending" contenteditable="false"
    data-student="${escHtml(studentName)}"
    data-act-id="${escHtml(actId || "")}"
    data-act-name="${escHtml(actName)}"
    data-target="${escHtml(target.name)}">
    <div class="group-student-name-row">
      <span class="group-student-name-label">${liveGroupAttendeeLabel(studentName)}</span>
      <button class="btn-add-remark btn-group-add-remark-pending"
        data-student="${escHtml(studentName)}"
        data-act-id="${escHtml(actId || "")}"
        data-act-name="${escHtml(actName)}"
        data-target="${escHtml(target.name)}">+ Add Remark${mapped ? "" : " &amp; Trials"}</button>
    </div>
  </div>`;
}

// Free-text counterpart of renderGroupStudentPendingRow — once the card is
// already expanded (some other attendee has a remark for this activity),
// a ready-to-type empty box replaces the "+ Add Remark & Trials" button so
// typing doesn't need that extra click first. Nothing is written to Firebase
// until the box actually has text in it (see the ".group-remark-input-empty"
// creation handler in setupEntryRemarkSaving) — unlike auto-creating an empty
// remark for every attendee up front, this can't leave a ghost remark behind
// for an attendee who never actually got anything typed for them.
function renderGroupStudentEmptyRow(studentName, actId, actName, target, isPredefined) {
  return `<div class="group-student-section" data-student="${escHtml(studentName)}">
    <div class="group-student-name-row" contenteditable="false">
      <span class="group-student-name-label">${liveGroupAttendeeLabel(studentName)}</span>
    </div>
    <div class="entry-field">
      <span class="field-label" contenteditable="false">Remark</span>
      <textarea class="field-input group-remark-input group-remark-input-empty" rows="1"
        placeholder="Remark…"
        data-act-id="${escHtml(actId || "")}"
        data-act-name="${escHtml(actName)}"
        data-target="${escHtml(target.name)}"
        data-is-predefined="${isPredefined}"
        data-student="${escHtml(studentName)}"></textarea>
    </div>
  </div>`;
}

// One attendee's own day average for a group target — per-attendee throughout
// (group sessions score each attendee separately even on a shared target).
// visited (keyed "targetId::studentName") guards a circular mapping chain.
// Same equal-per-remark averaging as calcDaysAverage's individual-session
// counterpart — see the comment there.
function calcGroupStudentDaysAverage(target, data, studentName, visited = new Set()) {
  const key = target.id + "::" + studentName;
  if (visited.has(key)) return null;
  visited.add(key);

  const maxPts = target.maxPoints || 3;
  const avgs = [];
  const actsForTarget = Object.entries(data.activities || {})
    .filter(([, a]) => a.targetName === target.name);

  for (const [actId, act] of actsForTarget) {
    const remarksForStudent = Object.values(data.remarks || {})
      .filter(r => r.activityId === actId && r.studentName === studentName);
    const pa = (target.predefinedActivities || []).find(p => p.isMapped && p.name === act.activityName);
    if (pa) {
      if (remarksForStudent.length === 0) continue;
      const mappedPct = resolveGroupMappedScoreDisplay(pa, target, data, studentName, visited).pct;
      if (mappedPct !== null) avgs.push(mappedPct);
      continue;
    }
    for (const r of remarksForStudent) {
      const trials = (r.trials || []).filter(t => t !== -1);
      if (trials.length === 0) continue;
      avgs.push(trials.reduce((a, b) => a + b, 0) / (trials.length * maxPts) * 100);
    }
  }
  return avgs.length > 0 ? Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length) : null;
}

// Resolves a mapped-score activity's live display for one attendee — see
// calcDaysAverage's individual-session counterpart, resolveMappedScoreDisplay.
function resolveGroupMappedScoreDisplay(pa, target, data, studentName, visited) {
  const mappedTarget = pa.mappedTargetId
    ? (state.currentGroup?.targets || []).find(t => t.id === pa.mappedTargetId)
    : null;
  if (!mappedTarget) return { label: "Score (Not Mapped Yet)", pct: null };
  return {
    label: `Score (Mapped to ${mappedTarget.name}'s Average)`,
    pct: calcGroupStudentDaysAverage(mappedTarget, data, studentName, visited)
  };
}

function updateGroupAvgChips(target, data) {
  const container = $("group-avg-chips");
  if (!container) return;
  const attendees = state.groupAttendees || [];
  if (!target || !data || !attendees.length) {
    container.innerHTML = attendees.map(name =>
      `<div class="days-average-chip">
        <span class="days-average-label">${escHtml(firstNameOf(name))}'s Avg</span>
        <span class="days-average-value">—</span>
      </div>`
    ).join("");
    return;
  }
  container.innerHTML = attendees.map(name => {
    const avg = calcGroupStudentDaysAverage(target, data, name);
    return `<div class="days-average-chip">
      <span class="days-average-label">${escHtml(firstNameOf(name))}'s Avg</span>
      <span class="days-average-value">${avg !== null ? avg + "%" : "—"}</span>
    </div>`;
  }).join("");
}

// ── Attach event listeners to the rendered group target content ──
function attachGroupTargetListeners(target) {
  const c = $("group-target-content");
  if (!c) return;

  // Saving for .group-remark-input / .group-remark-input-combined is handled
  // by the shared merged-editing host (state.entryGroupRemarkSaver, set up in
  // openGroupSession) — see setupEntryRemarkSaving. These are real
  // <textarea> elements, so Enter/backspace/Ctrl+A all work natively.
  c.querySelectorAll("textarea.field-input").forEach(autoResizeTextarea);

  // Sketch board
  c.querySelectorAll(".btn-group-sketch").forEach(btn => {
    btn.addEventListener("click", () => {
      const field = c.querySelector(`.group-remark-input[data-rem-id="${btn.dataset.remId}"]`)
                 || c.querySelector(`.mastery-note-input[data-rem-id="${btn.dataset.remId}"]`);
      if (field) openTextEditorSheet(field);
    });
  });

  c.querySelectorAll(".btn-group-sketch-combined").forEach(btn => {
    btn.addEventListener("click", () => {
      const field = c.querySelector(`.group-remark-input-combined[data-rem-ids="${btn.dataset.remIds}"]`);
      if (field) openTextEditorSheet(field);
    });
  });

  // ── Remark option buttons (single-select) — group entry counterpart of
  // the individual screen's equivalent handler ──────────────
  c.querySelectorAll(".remark-preset-opts:not(.remark-preset-opts-multi) .btn-remark-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      const isActive = btn.classList.contains("active");
      btn.closest(".remark-preset-opts")?.querySelectorAll(".btn-remark-opt").forEach(b => b.classList.remove("active"));
      const newText = isActive ? "" : btn.dataset.opt;
      if (!isActive) btn.classList.add("active");
      const remId = btn.dataset.remId;
      const rem = state.groupSessionData?.remarks?.[remId];
      const prevText = rem?.text;
      if (rem) rem.text = newText;
      updateRemarkText(state.groupSessionId, remId, newText).catch(err => {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // ── Remark option buttons (multi-select) ──────────────────
  c.querySelectorAll(".remark-preset-opts-multi .btn-remark-opt").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.classList.toggle("active");
      const container = btn.closest(".remark-preset-opts-multi");
      const selected = [...container.querySelectorAll(".btn-remark-opt.active")].map(b => b.dataset.opt);
      const newText = selected.join(", ");
      const remId = btn.dataset.remId;
      const rem = state.groupSessionData?.remarks?.[remId];
      const prevText = rem?.text;
      if (rem) rem.text = newText;
      updateRemarkText(state.groupSessionId, remId, newText).catch(err => {
        if (rem) rem.text = prevText;
        alert("Couldn't save — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // Combine/Separate remarks toggle (per activity, this session only)
  c.querySelectorAll(".btn-combine-toggle").forEach(btn => {
    btn.addEventListener("click", async () => {
      const actId = btn.dataset.actId;
      const data = state.groupSessionData;
      const current = !!data?.activities?.[actId]?.combineRemarks;

      if (!current) {
        // Turning ON: any round where 2+ students already have their OWN separate text
        // will collapse to the first student's text — confirm before discarding the rest.
        const attendees = state.groupAttendees || [];
        const byStudent = {};
        for (const studentName of attendees) {
          byStudent[studentName] = Object.entries(data.remarks || {})
            .filter(([, r]) => r.activityId === actId && r.studentName === studentName)
            .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
            .map(([id, r]) => ({ id, ...r }));
        }
        const maxRounds = Math.max(...Object.values(byStudent).map(arr => arr.length), 0);
        const stripEmpty = s => (s || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/ /g, " ").trim();

        const remIdsToClear = [];
        let conflict = null;
        for (let i = 0; i < maxRounds; i++) {
          const present = attendees
            .map(name => ({ name, rem: byStudent[name][i] }))
            .filter(e => e.rem);
          if (present.length < 2) continue;
          const [kept, ...others] = present;
          const keptHasText = stripEmpty(kept.rem.text).length > 0;
          for (const other of others) {
            if (keptHasText && stripEmpty(other.rem.text).length > 0) {
              if (!conflict) conflict = { keptName: kept.name, clearedName: other.name };
              remIdsToClear.push(other.rem.id);
            }
          }
        }

        if (remIdsToClear.length > 0) {
          const ok = confirm(
            `${conflict.clearedName}'s remark will be deleted and ${conflict.keptName}'s remark will be kept after combining. Continue?`
          );
          if (!ok) return;
          btn.disabled = true;
          for (const remId of remIdsToClear) await updateRemarkText(state.groupSessionId, remId, "");
        }
      }

      btn.disabled = true;
      await updateActivityCombineRemarks(state.groupSessionId, actId, !current);
    });
  });

  // Guards every "+ Add Remark & Trials" variant (all share the base
  // .btn-add-remark class) against a render replacing the button between
  // mousedown and click — see the matching comment on the individual
  // screen's .btn-add-remark handler.
  c.querySelectorAll(".btn-add-remark").forEach(btn => {
    btn.addEventListener("mousedown", () => {
      state.entryGroupActionsInFlight++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        state.entryGroupActionsInFlight = Math.max(0, state.entryGroupActionsInFlight - 1);
        if (state.entryGroupActionsInFlight === 0 && state.groupRenderPending) {
          state.groupRenderPending = false;
          renderGroupTargetContent();
        }
      };
      // Released the instant "click" fires, proving the button survived the
      // gap — the main click handler renders synchronously once it's done,
      // no further write to guard against. The timeout is only a fallback
      // for a press that never becomes a click.
      btn.addEventListener("click", release, { once: true });
      setTimeout(release, 600);
    });
  });

  // + Add Remark & Trials (collapsed card — creates remarks for ALL attendees at once)
  c.querySelectorAll(".btn-group-add-remark-all").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const actName    = btn.dataset.actName;
        const targetName = btn.dataset.target;
        const data       = state.groupSessionData;
        let actId = btn.dataset.actId || Object.entries(data.activities || {})
          .find(([, a]) => a.targetName === targetName && a.activityName === actName)?.[0] || null;
        if (!actId) {
          actId = await addActivity(state.groupSessionId, targetName, actName, Date.now(), true);
        }
        const entries = state.groupAttendees
          .filter(studentName => !Object.values(data.remarks || {})
            .some(r => r.activityId === actId && r.studentName === studentName))
          .map(studentName => ({ actId, studentName }));
        if (entries.length) {
          addGroupRemarksOptimistic(entries);
          renderGroupTargetContent();
        }
      } catch (err) {
        btn.disabled = false;
        alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
      }
    });
  });

  // + Add Remark & Trials (individual pending row — one student in an already-expanded card)
  c.querySelectorAll(".btn-group-add-remark-pending").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await ensureGroupActivityAndRemark(btn);
        renderGroupTargetContent();
      } catch (err) {
        btn.disabled = false;
        alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
      }
    });
  });

  // + Trial
  c.querySelectorAll(".btn-group-add-trial").forEach(btn => {
    btn.addEventListener("click", () => {
      const remId = btn.dataset.remId;
      state.scorePicker = { open: true, remId, isGroup: true };
      openScorePicker(remId, target);
    });
  });

  // Delete round — remove all remarks in this set at once
  c.querySelectorAll(".btn-group-del-round").forEach(btn => {
    btn.addEventListener("click", () => {
      const remIds = btn.dataset.remIds.split(",").filter(Boolean);
      if (!remIds.length) return;
      const data = state.groupSessionData;
      const prevRemarks = {};
      remIds.forEach(id => { prevRemarks[id] = data.remarks?.[id]; delete data.remarks?.[id]; });
      renderGroupTargetContent();
      deleteRemarksBatch(state.groupSessionId, remIds).catch(err => {
        Object.assign(data.remarks, prevRemarks);
        renderGroupTargetContent();
        alert("Couldn't delete round — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // + Add Remark & Trials (bottom of expanded card — always adds new remarks for all students)
  c.querySelectorAll(".btn-group-add-remark-more").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.disabled = true;
      const actId = btn.dataset.actId;
      const entries = state.groupAttendees.map(studentName => ({ actId, studentName }));
      addGroupRemarksOptimistic(entries);
      renderGroupTargetContent();
    });
  });

  // + Add Remark & Trials (student-grouped layout — bottom of card, adds another round for just this student)
  c.querySelectorAll(".btn-group-add-remark-student-more").forEach(btn => {
    btn.addEventListener("click", () => {
      btn.disabled = true;
      addGroupRemarksOptimistic([{ actId: btn.dataset.actId, studentName: btn.dataset.student }]);
      renderGroupTargetContent();
    });
  });

  // Delete a single round (student-grouped layout)
  c.querySelectorAll(".btn-group-del-student-remark").forEach(btn => {
    btn.addEventListener("click", () => {
      const remId = btn.dataset.remId;
      const rem = state.groupSessionData?.remarks?.[remId];
      if (!rem) return;
      delete state.groupSessionData.remarks[remId];
      renderGroupTargetContent();
      deleteRemark(state.groupSessionId, remId).catch(err => {
        state.groupSessionData.remarks[remId] = rem;
        renderGroupTargetContent();
        alert("Couldn't delete remark — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // Delete trial badge
  c.querySelectorAll(".btn-group-trial-del").forEach(btn => {
    btn.addEventListener("click", () => {
      const remId = btn.dataset.remId;
      const rem   = state.groupSessionData?.remarks?.[remId];
      if (!rem) return;
      const idx = Number(btn.dataset.idx);
      const prevTrials = rem.trials || [];
      const updated = prevTrials.filter((_, i) => i !== idx);
      rem.trials = updated;
      renderGroupTargetContent();
      setTrials(state.groupSessionId, remId, updated).catch(err => {
        rem.trials = prevTrials;
        renderGroupTargetContent();
        alert("Couldn't delete trial — check your connection and try again.\n\n" + err.message);
      });
    });
  });

  // + Add Activity (this session only)
  c.querySelector(".btn-group-add-activity")?.addEventListener("click", async () => {
    const name = prompt("Activity name (this session only):");
    if (!name?.trim()) return;
    await addActivity(state.groupSessionId, target.name, name.trim(), Date.now(), false);
  });
}

// Writes one or more group remarks into local state immediately instead of
// waiting on the Firestore round trip (callers render right after calling
// this), then fires the real writes in the background — rolling back and
// alerting if any of them fail.
function addGroupRemarksOptimistic(entries) {
  const data = state.groupSessionData;
  data.remarks = data.remarks || {};
  const now     = Date.now();
  const remIds  = entries.map(() => generateId("r"));
  entries.forEach(({ actId, studentName }, i) => {
    data.remarks[remIds[i]] = { activityId: actId, studentName, text: "", trials: [], order: now };
  });
  addGroupRemarksBatch(state.groupSessionId, entries, remIds).catch(err => {
    remIds.forEach(id => delete data.remarks[id]);
    renderGroupTargetContent();
    alert("Couldn't add remark — check your connection and try again.\n\n" + err.message);
  });
  return remIds;
}

// Helper: ensure activity + remark exist for a pending row element. The
// remark write itself is optimistic (see addGroupRemarksOptimistic) — only
// activity creation (rare: first time this predefined activity is used in
// the session) still waits on the network, since the remark needs a real
// activity ID to point at.
async function ensureGroupActivityAndRemark(el) {
  const studentName = el.dataset.student;
  const actName     = el.dataset.actName;
  const targetName  = el.dataset.target;
  const data        = state.groupSessionData;

  let actId = el.dataset.actId || Object.entries(data.activities || {})
    .find(([, a]) => a.targetName === targetName && a.activityName === actName)?.[0] || null;
  if (!actId) {
    actId = await addActivity(state.groupSessionId, targetName, actName, Date.now(), true);
  }
  // Check again in case snapshot already has the remark
  const existing = Object.entries(data.remarks || {})
    .find(([, r]) => r.activityId === actId && r.studentName === studentName);
  if (existing) return { actId, remId: existing[0] };
  const [remId] = addGroupRemarksOptimistic([{ actId, studentName }]);
  return { actId, remId };
}

// ── Group session history ────────────────────────────────────
async function showGroupSessionPicker(group) {
  $("session-picker-title").textContent = group.name;
  $("session-picker-list").innerHTML = `<div class="session-picker-loading">Loading sessions…</div>`;
  $("session-picker-modal").classList.remove("hidden");

  let sessions = [];
  try { sessions = await getRecentGroupSessions(group.id); } catch (_) {}

  const byMonth = new Map();
  for (const s of sessions) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, []);
    byMonth.get(s.month).push(s);
  }
  if (byMonth.size === 0) {
    $("session-picker-list").innerHTML = `<div class="session-picker-loading">No sessions found.</div>`;
    return;
  }
  renderGroupMonthGrid(group, byMonth, sessions);
}

function renderGroupMonthGrid(group, byMonth, sessions) {
  $("session-picker-title").textContent = group.name;
  let html = `<div class="month-grid">
    <button class="month-grid-btn month-grid-btn-pickdate" data-action="pick-date">
      <span class="mgb-pickdate-label">Pick A Date</span>
    </button>`;
  for (const month of byMonth.keys()) {
    const [name, year] = month.split(" ");
    html += `<button class="month-grid-btn" data-month="${escHtml(month)}">
      <span class="mgb-month">${escHtml(name.slice(0,3))}</span>
      <span class="mgb-year">${escHtml(year)}</span>
    </button>`;
  }
  html += `</div>`;
  $("session-picker-list").innerHTML = html;
  $("session-picker-list").querySelector('[data-action="pick-date"]').addEventListener("click", () => {
    const mostRecent = sessions.reduce((max, s) => (s.date > max ? s.date : max), sessions[0].date);
    renderGroupPickDateCalendar(group, sessions, byMonth, `${mostRecent.slice(0, 7)}-01`);
  });
  $("session-picker-list").querySelectorAll(".month-grid-btn[data-month]").forEach(btn => {
    btn.addEventListener("click", () =>
      renderGroupSessionsForMonth(group, btn.dataset.month, byMonth.get(btn.dataset.month), byMonth, sessions)
    );
  });
}

// "Pick a Date" calendar for the group session picker: jump straight to any
// past/today date's View/Edit screen — if that date has no session yet, one
// is created blank (and will be auto-deleted on the way out, same as any
// other empty session, if nothing ends up typed into it).
function renderGroupPickDateCalendar(group, sessions, byMonth, displayDate) {
  const sessionIdByDate = new Map(sessions.map(s => [s.date, s.id]));
  const today = getTodayString();
  const [y, m] = displayDate.split("-").map(Number);
  const monthLabel = new Date(y, m - 1, 1).toLocaleString("default", { month: "long", year: "numeric" });
  const [ty, tm] = today.split("-").map(Number);
  const canNext = y < ty || (y === ty && m < tm);
  const pad = n => String(n).padStart(2, "0");
  const prevM = m === 1  ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
  const nextM = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  const firstDow  = new Date(y, m - 1, 1).getDay();
  const daysInMon = new Date(y, m, 0).getDate();

  let html = `<button class="btn-picker-back">← Back</button>
    <div class="date-picker-wrap">
    <p class="date-picker-legend"><span class="date-taken-dot">✓︎</span> Session recorded on this day</p>
    <div class="date-picker-cal">
      <div class="date-picker-nav">
        <button class="btn-date-prev">‹</button>
        <span class="date-picker-month-label">${escHtml(monthLabel)}</span>
        <button class="btn-date-next"${canNext ? "" : " disabled"}>›</button>
      </div>
      <div class="date-picker-day-headers">
        <span>Su</span><span>Mo</span><span>Tu</span><span>We</span>
        <span>Th</span><span>Fr</span><span>Sa</span>
      </div>
      <div class="date-picker-grid">`;

  for (let cell = 0; cell < 42; cell++) {
    const d = cell - firstDow + 1;
    if (d < 1 || d > daysInMon) { html += `<span></span>`; continue; }
    const ds      = `${y}-${pad(m)}-${pad(d)}`;
    const isFut   = ds > today;
    const isTaken = sessionIdByDate.has(ds);
    let cls = "date-picker-day";
    if (isFut)   cls += " date-picker-day-future";
    if (isTaken) cls += " date-picker-day-taken";
    const dotCls = isTaken ? "date-taken-dot" : "day-dot-spacer";
    html += `<button class="${cls}" data-date="${ds}"${isFut ? " disabled" : ""}><span class="day-num">${d}</span><span class="${dotCls}">${isTaken ? "✓︎" : ""}</span></button>`;
  }
  html += `</div></div></div>`;

  $("session-picker-title").textContent = "Pick a Date";
  $("session-picker-list").innerHTML = html;

  $("session-picker-list").querySelector(".btn-picker-back").addEventListener("click", () =>
    renderGroupMonthGrid(group, byMonth, sessions)
  );
  $("session-picker-list").querySelector(".btn-date-prev").addEventListener("click", () => {
    renderGroupPickDateCalendar(group, sessions, byMonth, prevM);
  });
  if (canNext) {
    $("session-picker-list").querySelector(".btn-date-next").addEventListener("click", () => {
      renderGroupPickDateCalendar(group, sessions, byMonth, nextM);
    });
  }
  $("session-picker-list").querySelectorAll(".date-picker-day:not([disabled])").forEach(btn => {
    btn.addEventListener("click", async () => {
      closeSessionPicker();
      const ds = btn.dataset.date;
      const sessionId = sessionIdByDate.get(ds)
        || await getOrCreateGroupSessionForDate(group.id, ds, group.targets, group.students, group.studentLinks || {});
      openGroupSessionView(group, sessionId);
    });
  });
}

function renderGroupSessionsForMonth(group, month, monthSessions, byMonth, sessions) {
  $("session-picker-title").textContent = month;
  const sorted  = [...monthSessions].sort((a, b) => a.date.localeCompare(b.date));
  const display = [...sorted].reverse();
  const today   = getTodayString();
  let html = `<button class="btn-picker-back">← Back</button>`;
  html += renderSessionListRows(sorted, display, today, {
    // Group sessions have no one shared session number — each attendee has
    // their own personal lifetime number (a newer/more experienced kid in
    // the same group can be on a very different number) — so the headline
    // is just the date, with one "Name — Session N" line per attendee below.
    renderLabel: (s, dateLabel) => {
      const attendeeLines = (s.attendees || []).map(name => {
        const studentId = group.studentLinks?.[name];
        const num = studentId ? s.attendeePersonalSessionNumbers?.[studentId] : null;
        return `<div class="session-list-date">${escHtml(name)}${num != null ? ` — Session ${num}` : ""}</div>`;
      }).join("");
      return `<strong>${escHtml(dateLabel)}</strong>${attendeeLines}`;
    }
  });
  $("session-picker-list").innerHTML = html;
  $("session-picker-list").querySelector(".btn-picker-back").addEventListener("click", () =>
    renderGroupMonthGrid(group, byMonth, sessions)
  );
  $("session-picker-list").querySelectorAll(".session-list-item").forEach(item => {
    item.addEventListener("click", () => {
      closeSessionPicker();
      // Open the table-based view/edit screen for the chosen past session
      openGroupSessionView(group, item.dataset.sessionId);
    });
  });
}

// ── Group manage modal ───────────────────────────────────────
function openGroupManageModal(group, target = null) {
  $("manage-modal").classList.remove("hidden");
  if (target) {
    _groupForTargetEdit = group;
    renderTargetManageContent(group, target);
  } else {
    _groupForTargetEdit = null;
    renderGroupManageContent(group);
  }
}

function renderGroupManageContent(group) {
  _pendingActsCleanup = null;
  $("manage-modal-title").textContent = group.name || "New Group";

  // 3 fixed student slots — always show exactly 3. Each is a single picker
  // into the central student registry (not a free-text name field), so a
  // roster slot is always linked to a real student.id and naturally counts
  // toward that person's lifetime group session number — see
  // getGroupSessionsForStudent / [[project_unified_session_numbering]].
  const registryOptions = [...state.students].sort((a, b) => a.name.localeCompare(b.name));
  const studentRowsHtml = [0, 1, 2].map(i => {
    const name = group.students?.[i] || "";
    const linkedId = group.studentLinks?.[name] || "";
    return `
    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.45rem;flex-wrap:wrap">
      <span style="min-width:5.5rem;font-size:.85rem;font-weight:600;color:var(--text-muted)">Student ${i + 1}</span>
      <select class="admin-input mn-g-student-pick" data-idx="${i}" style="flex:1;min-width:9rem">
        <option value="">— empty —</option>
        <option value="__new__">+ Register a new student…</option>
        ${registryOptions.map(s => `<option value="${s.id}"${s.id === linkedId ? " selected" : ""}>${escHtml(s.name)}</option>`).join("")}
      </select>
    </div>`;
  }).join("");

  $("manage-modal-body").innerHTML = `
    <div class="admin-section">
      <label class="admin-label">Group Name</label>
      <div class="admin-input" id="mn-g-name"
        style="min-height:2.8rem;display:flex;align-items:center;white-space:normal;
               color:${group.name ? "var(--text)" : "var(--text-muted)"};
               font-style:${group.name ? "normal" : "italic"};cursor:default;line-height:1.4">
        ${group.name
          ? escHtml(group.name)
          : "The group name is automatically set based on the students picked below. Just fill in the students and this field will be filled automatically."}
      </div>
    </div>
    <div class="admin-section">
      <label class="admin-label">Students</label>
      ${studentRowsHtml}
    </div>
    <div style="margin-top:1.5rem;padding-bottom:.5rem;display:flex;flex-direction:column;gap:.6rem">
      <button class="btn-primary-sm" id="btn-mn-g-done"
        style="width:100%;padding:.75rem;font-size:1rem">Done</button>
      <button class="btn-adm-danger" id="btn-mn-del-group">Delete Group</button>
    </div>`;

  $("manage-modal-body").querySelectorAll(".mn-g-student-pick").forEach(sel => {
    sel.addEventListener("change", async () => {
      const idx = Number(sel.dataset.idx);
      const prevName = group.students?.[idx] || "";
      const prevId   = group.studentLinks?.[prevName] || null;

      if (sel.value === "__new__") {
        sel.value = group.studentLinks?.[prevName] || "";
        // Just hide the modal rather than closeManageModal()'s full cleanup —
        // that cleanup deletes a brand-new, still-empty group (tracked via
        // _newGroupId), which would wipe out the group she's mid-creating.
        $("manage-modal").classList.add("hidden");
        openStudentRegistryScreen({ highlightAdd: true });
        return;
      }
      const pickedStudent = sel.value ? (state.students.find(s => s.id === sel.value) || null) : null;

      // Guard against picking the same registered student into two slots
      // of the same group — a real mistake, not a valid roster shape.
      if (pickedStudent && group.students?.some((n, j) => j !== idx && group.studentLinks?.[n] === pickedStudent.id)) {
        alert(`"${pickedStudent.name}" is already in another slot in this group.`);
        sel.value = group.studentLinks?.[prevName] || "";
        return;
      }

      // Pad to exactly 3 real entries (never sparse/holes) before assigning
      // by index — a sparse array's .length looks "non-empty" even when
      // every slot is blank (e.g. opening then clearing slot 2 without
      // touching slot 1 leaves a hole at index 0), which let a fully-empty
      // brand-new group survive closeManageModal()'s empty-group cleanup.
      group.students = [0, 1, 2].map(i => group.students?.[i] || "");
      group.studentLinks = group.studentLinks || {};
      if (prevName) delete group.studentLinks[prevName];
      if (pickedStudent) {
        group.students[idx] = pickedStudent.name;
        group.studentLinks[pickedStudent.name] = pickedStudent.id;
      } else {
        group.students[idx] = "";
      }
      const filledNames = group.students.filter(Boolean);
      // The Group Name field is fully automatic now (no manual-rename input
      // exists in this modal), so it should always reflect the currently
      // linked students rather than only updating when an old "was this
      // already auto?" heuristic happened to hold.
      group.name = groupAutoName(filledNames);
      if (filledNames.length > 0) _newGroupId = null; // group is no longer empty

      const gi = state.groups.findIndex(g => g.id === group.id);
      if (gi >= 0) state.groups[gi] = group;
      await saveGroup(group);

      // A slot being RE-LINKED (not just filled or cleared) leaves every
      // already-recorded session for this group still pointing at the old
      // student — without this, the registry keeps showing that history
      // under the old (now-unlinked) student instead of the new one.
      if (pickedStudent && prevId && prevId !== pickedStudent.id) {
        try {
          await reassignGroupStudentAcrossSessions(group.id, prevName, prevId, pickedStudent.name, pickedStudent.id);
        } catch (err) {
          alert("Saved the new link, but failed to update this group's past sessions: " + err.message);
        }
      }

      renderGroupButtons();
      renderGroupManageContent(group); // re-render so other slots see the updated registry/links
    });
  });

  // Done
  $("btn-mn-g-done").addEventListener("click", closeManageModal);

  // Delete group
  $("btn-mn-del-group").addEventListener("click", async () => {
    const typed = prompt(`Type DELETE to permanently delete the group "${group.name}":`);
    if (typed !== "DELETE") return;
    const gi = state.groups.findIndex(g => g.id === group.id);
    if (gi >= 0) state.groups.splice(gi, 1);
    await deleteGroup(group.id);
    closeManageModal();
  });
}

// ─── AUTOSAVED INDICATOR (template modal header) ─────────────

function showAutosaved() {
  const el = $("manage-autosave-indicator");
  if (!el) return;
  el.textContent = "Autosaved";
  el.classList.add("visible");
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.classList.remove("visible"), 2000);
}

// ─── SAVED FLASH ─────────────────────────────────────────────

function flashSaved() {}

// Wraps a "Save" button's click handler so it only shows "Saving…" if the
// save is actually slow enough to need it, and always confirms with a
// brief "Saved!" afterwards — answers "did that actually save?" without
// making a fast save feel sluggish by flashing a loading state nobody
// needed to see. Resolves once "Saved!" has actually been visible for a
// moment, so callers that re-render/destroy the button right after saving
// (e.g. Student Database's inline add-row) should await this first.
function withSaveFeedback(btn, promise, { savingDelay = 250, savedHold = 700 } = {}) {
  const original = btn.textContent;
  btn.disabled = true;
  const timer = setTimeout(() => { btn.textContent = "Saving…"; }, savingDelay);
  return promise.then(
    async result => {
      clearTimeout(timer);
      btn.textContent = "Saved!";
      await new Promise(r => setTimeout(r, savedHold));
      btn.textContent = original;
      btn.disabled = false;
      return result;
    },
    err => {
      clearTimeout(timer);
      btn.textContent = original;
      btn.disabled = false;
      throw err;
    }
  );
}

// ─── SCREEN MANAGEMENT ───────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => {
    s.classList.toggle("hidden", s.id !== id);
    s.classList.toggle("active", s.id === id);
  });
}

// ─── LOCAL DATA QUERIES ──────────────────────────────────────

function getActivitiesForTarget(targetName) {
  return Object.entries(state.sessionData?.activities || {})
    .filter(([, a]) => a.targetName === targetName)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .map(([id, a]) => ({ id, ...a }));
}

function getRemarksForActivity(actId) {
  return Object.entries(state.sessionData?.remarks || {})
    .filter(([, r]) => r.activityId === actId)
    .sort(([, a], [, b]) => (a.order || 0) - (b.order || 0))
    .map(([id, r]) => ({ id, ...r }));
}

function findActivityByName(targetName, activityName) {
  const found = Object.entries(state.sessionData?.activities || {}).find(
    ([, a]) => a.targetName === targetName && a.activityName === activityName
  );
  return found ? { id: found[0], ...found[1] } : null;
}

// ─── UTILITIES ───────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[m - 1]} ${y}`;
}
function formatDateWithDay(dateStr) {
  return `${dayAbbr(dateStr)}, ${formatDate(dateStr)}`;
}
function relativeDaySuffix(dateStr) {
  return dateStr === getTodayString() ? " (Today)" : "";
}
function getYesterdayString() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${d} ${months[m - 1]}`;
}
function dayAbbr(dateStr) {
  const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const [y, m, d] = dateStr.split("-").map(Number);
  return days[new Date(y, m - 1, d).getDay()];
}
function startOfWeek(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  date.setDate(date.getDate() - (dow === 0 ? 6 : dow - 1));
  return date;
}
// Buckets a session date into "This week" / "Last week" / "Earlier" relative
// to today, so the picker list can group sessions under short headers instead
// of spelling the day/week out in every row.
function sessionWeekSection(dateStr, todayStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const thisWeekStart = startOfWeek(todayStr);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  if (date >= thisWeekStart) return "This week";
  if (date >= lastWeekStart) return "Last week";
  return "Earlier";
}
function sessionItemLabel(dateStr, todayStr) {
  const base = `${dayAbbr(dateStr)}, ${formatDateShort(dateStr)}`;
  return dateStr === todayStr ? `${base} (Today)` : base;
}
// Shared renderer for the "Session N: ..." rows used by every session picker
// (individual/group, normal/export/go-to) — groups rows under week headers
// and lets callers add a per-row extra line (e.g. group attendees) or mark
// one row as the currently-viewed session. renderLabel lets a caller replace
// the default "Session N: {date}" headline entirely — group sessions have no
// single shared session number (each attendee has their own personal one),
// so the group picker swaps in a date headline + one line per attendee.
function renderSessionListRows(sorted, display, today, { isCurrentId, extraLine, renderLabel } = {}) {
  let html = "";
  let lastSection = null;
  for (const s of display) {
    const section = sessionWeekSection(s.date, today);
    if (section !== lastSection) {
      html += `<div class="session-month-label">${escHtml(section)}</div>`;
      lastSection = section;
    }
    const isCurrent = isCurrentId != null && s.id === isCurrentId;
    const cls       = `session-list-item${isCurrent ? " session-list-current" : ""}`;
    const label     = sessionItemLabel(s.date, today);
    const labelHtml = renderLabel ? renderLabel(s, label) : `<strong>Session ${s.sessionNumber}</strong>: ${label}`;
    const extra     = extraLine ? extraLine(s) : "";
    html += `<div class="${cls}" data-session-id="${s.id}">
      <div class="session-list-meta">
        <div class="session-list-label">${labelHtml}</div>
        ${extra}
      </div>
    </div>`;
  }
  return html;
}
