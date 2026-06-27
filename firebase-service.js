// ============================================================
// FIREBASE-SERVICE.JS
// All Firestore read/write operations live here.
// Fill in the FIREBASE_CONFIG placeholders below after
// creating your Firebase project at console.firebase.google.com
// ============================================================

import { initializeApp }    from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  initializeFirestore,
  persistentLocalCache,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  where,
  onSnapshot,
  deleteField,
  serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";

// ─── FIREBASE CONFIGURATION ────────────────────────────────
// Replace every "YOUR_..." placeholder with your project's values.
// Find these in: Firebase Console → Project Settings → Your apps → SDK setup
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDzIdlSu_ipdbPtg9TEdWorGaznkslqsGI",
  authDomain:        "session-tracker-staging.firebaseapp.com",
  projectId:         "session-tracker-staging",
  storageBucket:     "session-tracker-staging.firebasestorage.app",
  messagingSenderId: "43697728086",
  appId:             "1:43697728086:web:505e802505e14b0346a9f7"
};
// ────────────────────────────────────────────────────────────

const app = initializeApp(FIREBASE_CONFIG);

// Enable offline persistence (IndexedDB cache)
const db = initializeFirestore(app, {
  localCache: persistentLocalCache()
});

// ─── AUTH ────────────────────────────────────────────────────
// There's one shared account for the whole team — the PIN screen is the
// real login UI, this just turns "the PIN" into an actual server-checked
// password instead of a value compared inside the page's own JS (which
// anyone could read). Firebase requires passwords to be 6+ characters, so
// the PIN gets a fixed prefix glued on before being sent — staff never see
// or type that prefix, they still just enter the PIN on the keypad.
const auth = getAuth(app);
// Sign-in persists across reloads (browserLocalPersistence) — staff only
// need the PIN once per calendar day, not on every single app open. app.js
// tracks the last login date itself and forces a sign-out (signOutUser)
// once that date is no longer today.
setPersistence(auth, browserLocalPersistence);
const AUTH_EMAIL    = "staff@session-tracker.app";
const PIN_PASSWORD_PREFIX = "str-pin-";

export function signInWithPin(pin) {
  return signInWithEmailAndPassword(auth, AUTH_EMAIL, PIN_PASSWORD_PREFIX + pin);
}

export function signOutUser() {
  return signOut(auth);
}

// Calls back immediately with the current state, then on every change.
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

// ─── ID GENERATOR ───────────────────────────────────────────
// Produces short alphanumeric IDs safe for Firestore field paths.
export function generateId(prefix = "id") {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── DATE / MONTH HELPERS ────────────────────────────────────
export function getTodayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getMonthString(dateStr) {
  const [y, m] = dateStr.split("-");
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

// Sanitise a string for use as a Firestore map key (no dots or special chars).
export function sanitizeKey(name) {
  return name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────

/**
 * Returns the session document ID for today for this student.
 * Creates one if it does not exist yet, with correct session number.
 */
export async function getOrCreateTodaySession(studentId, targets = []) {
  const today = getTodayString();
  const month = getMonthString(today);

  // Look for an existing session today
  const existingSnap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId),
      where("date", "==", today))
  );
  if (!existingSnap.empty) {
    return existingSnap.docs[0].id;
  }

  // Count distinct days already recorded this month → session number
  const monthSnap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId),
      where("month", "==", month))
  );
  const existingDates = new Set(monthSnap.docs.map(d => d.data().date));
  existingDates.add(today);
  const sessionNumber = [...existingDates].sort().indexOf(today) + 1;

  const targetsSnapshot = targets.map(t => ({
    id:                  t.id,
    name:                t.name,
    maxPoints:           t.maxPoints,
    predefinedActivities: t.predefinedActivities || [],
    notes:               t.notes || [],
    hasComment:          t.hasComment || false,
    fullName:            t.fullName || ""
  }));

  const ref = await addDoc(collection(db, "sessions"), {
    studentId,
    date: today,
    month,
    sessionNumber,
    finished: false,
    activities: {},
    remarks: {},
    fedcComments: {},
    targetsSnapshot,
    createdAt: serverTimestamp()
  });
  return ref.id;
}

// ─── UNIFIED SESSION NUMBERING (individual + group, per student) ──────
// A student's session number counts every session they've ever been part
// of — their own individual sessions AND any group session they're a
// linked attendee of (see studentLinks on group docs) — as one lifetime
// sequence, not reset per month. Stored on each session document (on
// individual docs as sessionNumber; on group docs per-attendee inside
// attendeePersonalSessionNumbers, since one group session has multiple
// attendees each needing their own personal count) rather than computed
// live on every render, which would mean re-scanning a student's entire
// history just to open a session.

/** All of one student's individual sessions, unsorted. */
export async function getIndividualSessionsForStudent(studentId) {
  const snap = await getDocs(query(collection(db, "sessions"), where("studentId", "==", studentId)));
  return snap.docs.map(d => ({
    id: d.id, date: d.data().date, kind: "individual", number: d.data().sessionNumber
  }));
}

/** All group sessions this student is linked to as an attendee, unsorted. */
export async function getGroupSessionsForStudent(studentId) {
  const snap = await getDocs(query(collection(db, "sessions"), where("attendeeIds", "array-contains", studentId)));
  return snap.docs.map(d => ({
    id: d.id, date: d.data().date, kind: "group", number: (d.data().attendeePersonalSessionNumbers || {})[studentId]
  }));
}

/**
 * Computes the lifetime session number for a date being added/moved-to for
 * this student, and corrects any of their existing sessions whose position
 * shifted as a result (e.g. inserting a back-dated session pushes every
 * later one up by one). excludeSessionId skips a session's own pre-edit
 * entry when recomputing for a date change on that same session. kind
 * ("individual" | "group") scopes this to just that track — a student's
 * individual and group session counts are deliberately independent of each
 * other, each its own lifetime sequence.
 */
// prefetchedExisting: pass an already-fetched list (from getIndividualSessionsForStudent
// /getGroupSessionsForStudent) to skip the redundant re-fetch — used by the
// "start a session" hot path, which already has to fetch this same list to
// check whether today's session exists yet.
async function assignLifetimeSessionNumber(studentId, dateStr, excludeSessionId, kind, prefetchedExisting = null) {
  const fetchExisting = kind === "individual" ? getIndividualSessionsForStudent : getGroupSessionsForStudent;
  const field = kind === "individual" ? "sessionNumber" : `attendeePersonalSessionNumbers.${studentId}`;
  const existing = (prefetchedExisting || await fetchExisting(studentId))
    .filter(s => s.id !== excludeSessionId);
  const dateSet = new Set(existing.map(s => s.date));
  dateSet.add(dateStr);
  const sorted = [...dateSet].sort();
  const myNumber = sorted.indexOf(dateStr) + 1;

  for (const s of existing) {
    const newNum = sorted.indexOf(s.date) + 1;
    if (newNum !== s.number) {
      updateDoc(doc(db, "sessions", s.id), { [field]: newNum }).catch(() => {});
    }
  }
  return myNumber;
}

/**
 * Boss-driven correction for veteran students/clients whose recorded count
 * is off (e.g. they were tracked on paper for years before this app
 * existed, or a session got mis-numbered). Shifts EVERY one of the
 * student's sessions of that kind ("individual" | "group") by the same
 * delta so relative order/spacing is kept — can raise or lower, but rejects
 * a change that would push their earliest recorded session of that kind
 * below Session 1 (the UI checks this too, with a friendlier message
 * naming the actual date — this is just the backstop).
 */
export async function changeSessionNumber(studentId, anchorSessionId, newNumber, kind) {
  const fetchExisting = kind === "individual" ? getIndividualSessionsForStudent : getGroupSessionsForStudent;
  const field = kind === "individual" ? "sessionNumber" : `attendeePersonalSessionNumbers.${studentId}`;
  const sessions = await fetchExisting(studentId);
  const anchor = sessions.find(s => s.id === anchorSessionId);
  if (!anchor) throw new Error("That session could not be found.");
  const delta = newNumber - anchor.number;
  if (delta === 0) return;
  const earliest = sessions.reduce((min, s) => (!min || s.date < min.date) ? s : min, null);
  if (earliest.number + delta < 1) {
    throw new Error(
      `Session ${newNumber} would push this student's earliest recorded session ` +
      `(${earliest.date}) to Session ${earliest.number + delta}. Choose a different number.`
    );
  }
  const CHUNK = 450; // Firestore batch cap is 500 ops
  for (let i = 0; i < sessions.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const s of sessions.slice(i, i + CHUNK)) {
      batch.update(doc(db, "sessions", s.id), { [field]: s.number + delta });
    }
    await batch.commit();
  }
}

/** Like getOrCreateTodaySession but for any date (used when boss chooses session date upfront). */
export async function getOrCreateSessionForDate(studentId, dateStr, targets = []) {
  const month = getMonthString(dateStr);

  // One fetch covers both "does today's session already exist" and the data
  // assignLifetimeSessionNumber needs — used to be two sequential round
  // trips (an exists-check query, then a separate full-history fetch inside
  // assignLifetimeSessionNumber), which was real added latency on every
  // single "Start Session" click.
  const existing = await getIndividualSessionsForStudent(studentId);
  const already  = existing.find(s => s.date === dateStr);
  if (already) return already.id;

  const sessionNumber = await assignLifetimeSessionNumber(studentId, dateStr, null, "individual", existing);

  const targetsSnapshot = targets.map(t => ({
    id: t.id, name: t.name, maxPoints: t.maxPoints,
    predefinedActivities: t.predefinedActivities || [],
    notes: t.notes || [], hasComment: t.hasComment || false, fullName: t.fullName || ""
  }));

  const ref = await addDoc(collection(db, "sessions"), {
    studentId, date: dateStr, month, sessionNumber,
    finished: false, activities: {}, remarks: {}, fedcComments: {},
    targetsSnapshot, createdAt: serverTimestamp()
  });
  return ref.id;
}

/**
 * Real-time listener for a session document.
 * Returns unsubscribe function.
 */
export function listenToSession(sessionId, callback) {
  return onSnapshot(doc(db, "sessions", sessionId), snap => {
    if (snap.exists()) callback(snap.data());
  });
}

/** Mark session as finished. */
export async function finishSession(sessionId) {
  await updateDoc(doc(db, "sessions", sessionId), { finished: true });
}

/** Change the date (and recalculate month + session number) of an existing session. */
export async function updateSessionDate(sessionId, newDateStr, studentId) {
  const month = getMonthString(newDateStr);

  // Conflict check — another session for same student on that date
  const conflictSnap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId),
      where("date",      "==", newDateStr))
  );
  if (conflictSnap.docs.some(d => d.id !== sessionId)) {
    throw new Error("There is already a session on that date for this student.");
  }

  const sessionNumber = await assignLifetimeSessionNumber(studentId, newDateStr, sessionId, "individual");

  await updateDoc(doc(db, "sessions", sessionId), { date: newDateStr, month, sessionNumber });
}

/** Change the date (and recalculate month + session number) of an existing group session. */
export async function updateGroupSessionDate(sessionId, newDateStr, groupId) {
  const month = getMonthString(newDateStr);

  // Conflict check — another session for same group on that date
  const conflictSnap = await getDocs(
    query(collection(db, "sessions"),
      where("groupId", "==", groupId),
      where("date",    "==", newDateStr))
  );
  if (conflictSnap.docs.some(d => d.id !== sessionId)) {
    throw new Error("There is already a session on that date for this group.");
  }

  // Recalculate session number within the target month
  const monthSnap = await getDocs(
    query(collection(db, "sessions"),
      where("groupId", "==", groupId),
      where("month",   "==", month))
  );
  const dates = new Set(
    monthSnap.docs.filter(d => d.id !== sessionId).map(d => d.data().date)
  );
  dates.add(newDateStr);
  const sessionNumber = [...dates].sort().indexOf(newDateStr) + 1;

  // Each linked attendee's personal lifetime number also needs recomputing
  // for the new date, separately from the group's own collective number above.
  const sessSnap = await getDoc(doc(db, "sessions", sessionId));
  const attendeeIds = sessSnap.data()?.attendeeIds || [];
  const numbersPatch = {};
  for (const id of attendeeIds) {
    numbersPatch[`attendeePersonalSessionNumbers.${id}`] = await assignLifetimeSessionNumber(id, newDateStr, sessionId, "group");
  }

  await updateDoc(doc(db, "sessions", sessionId), { date: newDateStr, month, sessionNumber, ...numbersPatch });
}

// ─── ACTIVITY OPERATIONS ─────────────────────────────────────

export async function addActivity(sessionId, targetName, activityName, order, isPredefined = false) {
  const actId = generateId("a");
  await updateDoc(doc(db, "sessions", sessionId), {
    [`activities.${actId}`]: { targetName, activityName, order, isPredefined }
  });
  return actId;
}

export async function deleteActivity(sessionId, actId, remarkIds) {
  const updates = { [`activities.${actId}`]: deleteField() };
  for (const remId of remarkIds) {
    updates[`remarks.${remId}`] = deleteField();
  }
  await updateDoc(doc(db, "sessions", sessionId), updates);
}

// ─── REMARK OPERATIONS ───────────────────────────────────────

// remId can be supplied by the caller (e.g. to write a remark into local
// state immediately, before this write reaches the server, so the UI
// doesn't have to wait on the round trip) — otherwise one is generated here.
export async function addRemark(sessionId, actId, text, predefinedKey = null, remId = generateId("r")) {
  const data = { activityId: actId, text, trials: [], order: Date.now() };
  if (predefinedKey !== null) data.predefinedKey = predefinedKey;
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}`]: data
  });
  return remId;
}

export async function updateRemarkText(sessionId, remId, text) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.text`]: text
  });
}

export async function updateRemarkNote(sessionId, remId, note) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.masteryNote`]: note
  });
}

export async function updateActivityName(sessionId, actId, name) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`activities.${actId}.activityName`]: name
  });
}

export async function updateActivityCombineRemarks(sessionId, actId, combine) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`activities.${actId}.combineRemarks`]: combine
  });
}

export async function deleteRemark(sessionId, remId) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}`]: deleteField()
  });
}

// ─── TRIAL OPERATIONS ────────────────────────────────────────

export async function addTrial(sessionId, remId, score, currentTrials) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.trials`]: [...currentTrials, score]
  });
}

export async function deleteTrial(sessionId, remId, trialIndex, currentTrials) {
  const updated = currentTrials.filter((_, i) => i !== trialIndex);
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.trials`]: updated
  });
}

export async function setTrials(sessionId, remId, trials) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.trials`]: trials
  });
}

// ─── FEDC COMMENT ────────────────────────────────────────────

export async function updateFedcComment(sessionId, targetName, text) {
  const key = sanitizeKey(targetName);
  await updateDoc(doc(db, "sessions", sessionId), {
    [`fedcComments.${key}`]: text
  });
}

// ─── STUDENT CONFIG (admin-managed) ──────────────────────────

/** Load all students from Firestore config collection. */
export async function loadStudentsConfig() {
  const snap = await getDocs(collection(db, "students"));
  return snap.docs.map(d => d.data()).sort((a, b) => (a.order || 0) - (b.order || 0));
}

/** Save (upsert) a student config document. */
export async function saveStudent(student) {
  await setDoc(doc(db, "students", student.id), student);
}

/** Delete a student config document. */
export async function deleteStudentConfig(studentId) {
  await deleteDoc(doc(db, "students", studentId));
}

/**
 * Remove all activities, remarks, and FEDC comments for a deleted target
 * from every session belonging to that student.
 */
export async function deleteTargetDataFromSessions(studentId, targetName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("studentId", "==", studentId))
  );
  const key = sanitizeKey(targetName);
  for (const sessionDoc of snap.docs) {
    const data = sessionDoc.data();
    const updates = {};
    const actIds = [];
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === targetName) {
        updates[`activities.${actId}`] = deleteField();
        actIds.push(actId);
      }
    }
    for (const [remId, rem] of Object.entries(data.remarks || {})) {
      if (actIds.includes(rem.activityId)) updates[`remarks.${remId}`] = deleteField();
    }
    if ((data.fedcComments || {})[key] !== undefined) {
      updates[`fedcComments.${key}`] = deleteField();
    }
    if (Object.keys(updates).length > 0) {
      await updateDoc(doc(db, "sessions", sessionDoc.id), updates);
    }
  }
}

/** Delete a session document entirely (e.g. empty sessions on leave). */
export async function deleteSession(sessionId) {
  await deleteDoc(doc(db, "sessions", sessionId));
}

// ─── EXPORT DATA ─────────────────────────────────────────────

/** Fetch recent sessions for a student, newest-first (for session picker). */
export async function getRecentSessionsForStudent(studentId, maxCount = 60) {
  // No orderBy here on purpose — combining where("studentId") with an
  // orderBy on a different field needs a Firestore composite index that
  // doesn't exist in this project (confirmed: the v516/v517 attempts to add
  // one both failed silently, since callers swallow the error). Sorting and
  // slicing client-side is slower as a student's history grows, but it's
  // guaranteed to work without needing any index to be created first.
  const snap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId))
  );
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxCount);
}

/** Fetch all sessions for a student, sorted oldest-first. */
export async function getAllSessionsForStudent(studentId) {
  // No orderBy on purpose — see getRecentSessionsForStudent above. This is
  // the exact query shape that produced the real "query requires an index"
  // error from Export All, confirming the studentId+date composite index
  // doesn't exist in this project. Sort client-side instead.
  const snap = await getDocs(
    query(collection(db, "sessions"), where("studentId", "==", studentId))
  );
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function getAllSessionsForGroup(groupId) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Fetch today's unfinished session IDs, keyed by studentId. */
export async function getTodayUnfinishedStudentIds() {
  const today = getTodayString();
  const snap = await getDocs(
    query(collection(db, "sessions"),
      where("date", "==", today),
      where("finished", "==", false))
  );
  return new Set(snap.docs.map(d => d.data().studentId));
}

// ─── TEMPLATE CONFIG ─────────────────────────────────────────

export async function loadTemplates() {
  const snap = await getDocs(collection(db, "templates"));
  return snap.docs.map(d => d.data()).sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function saveTemplate(template) {
  await setDoc(doc(db, "templates", template.id), template);
}

export async function deleteTemplate(templateId) {
  await deleteDoc(doc(db, "templates", templateId));
}

// ─── REMARK PRESETS ──────────────────────────────────────────

export async function loadRemarkPresets() {
  const snap = await getDocs(collection(db, "remarkPresets"));
  return snap.docs.map(d => d.data()).sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function saveRemarkPreset(preset) {
  await setDoc(doc(db, "remarkPresets", preset.id), preset);
}

export async function deleteRemarkPreset(presetId) {
  await deleteDoc(doc(db, "remarkPresets", presetId));
}

// ─── GROUP CONFIG ─────────────────────────────────────────────

export async function loadGroups() {
  const snap = await getDocs(collection(db, "groups"));
  return snap.docs.map(d => d.data()).sort((a, b) => (a.order || 0) - (b.order || 0));
}

export async function saveGroup(group) {
  await setDoc(doc(db, "groups", group.id), group);
}

export async function deleteGroup(groupId) {
  await deleteDoc(doc(db, "groups", groupId));
}

// ─── GROUP SESSION ────────────────────────────────────────────

// studentLinks: this group's { rosterName: studentId } map (see Manage Group's
// "Link to registered student" control) — only linked attendees get a
// personal lifetime session number; an unlinked name just has none yet.
export async function getOrCreateGroupSessionForDate(groupId, dateStr, targets = [], attendees = [], studentLinks = {}) {
  const month = getMonthString(dateStr);
  const linkedIds = [...new Set(attendees.map(name => studentLinks[name]).filter(Boolean))];

  // One fetch of this group's sessions covers both the exists-check and the
  // month-count below — used to be two separate queries. And each
  // attendee's personal lifetime number is looked up in parallel
  // (Promise.all) instead of one at a time — these used to run sequentially
  // in a for-loop even though each attendee's lookup is fully independent of
  // the others, so a group of N students cost N sequential round trips on
  // every single "Start Session" click.
  const groupSnap    = await getDocs(query(collection(db, "sessions"), where("groupId", "==", groupId)));
  const existingDoc  = groupSnap.docs.find(d => d.data().date === dateStr);

  if (existingDoc) {
    const existingId      = existingDoc.id;
    const existingNumbers = existingDoc.data().attendeePersonalSessionNumbers || {};
    const idsNeedingNumber = linkedIds.filter(id => existingNumbers[id] == null);
    const numberPairs = await Promise.all(
      idsNeedingNumber.map(async id => [id, await assignLifetimeSessionNumber(id, dateStr, null, "group")])
    );
    const numbersPatch = {};
    for (const [id, num] of numberPairs) numbersPatch[`attendeePersonalSessionNumbers.${id}`] = num;
    await updateDoc(doc(db, "sessions", existingId), { attendees, attendeeIds: linkedIds, ...numbersPatch });
    return existingId;
  }

  const dates = new Set(groupSnap.docs.filter(d => d.data().month === month).map(d => d.data().date));
  dates.add(dateStr);
  const sessionNumber = [...dates].sort().indexOf(dateStr) + 1;

  const numberPairs = await Promise.all(
    linkedIds.map(async id => [id, await assignLifetimeSessionNumber(id, dateStr, null, "group")])
  );
  const attendeePersonalSessionNumbers = Object.fromEntries(numberPairs);

  const targetsSnapshot = targets.map(t => ({
    id: t.id, name: t.name, maxPoints: t.maxPoints,
    predefinedActivities: t.predefinedActivities || [],
    notes: t.notes || [], hasComment: t.hasComment || false, fullName: t.fullName || ""
  }));
  const ref = await addDoc(collection(db, "sessions"), {
    groupId, date: dateStr, month, sessionNumber, attendees,
    attendeeIds: linkedIds, attendeePersonalSessionNumbers,
    finished: false, activities: {}, remarks: {}, fedcComments: {},
    targetsSnapshot, createdAt: serverTimestamp()
  });
  return ref.id;
}

export async function getRecentGroupSessions(groupId, maxCount = 60) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, maxCount);
}

// ─── STUDENT REGISTRY MIGRATION (one-time) ─────────────────────
// Before this feature, groups only stored attendee names as free-typed
// strings with no link to the students collection, and individual session
// numbers reset every month. This migration: (1) splits any student missing
// firstName/lastName off their combined name, (2) links every group's
// roster names to a registered student — auto-creating one for any name
// that doesn't already match an existing student, (3) backfills studentId
// + attendeeIds onto every historical group session so they're covered by
// getGroupSessionsForStudent, then (4) renumbers each affected student's
// individual sessions and group sessions into two separate lifetime
// sequences (each starting at 1) — individual and group counts are
// deliberately independent of one another.
// previewRegistryMigration() makes no writes — run it first and review the
// report before calling runRegistryMigration() for real.

function splitName(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

export async function previewRegistryMigration() {
  const students = await loadStudentsConfig();
  const groups   = await loadGroups();
  const byName = new Map(students.map(s => [s.name.trim().toLowerCase(), s]));

  const nameSplits = students
    .filter(s => !s.firstName || !s.lastName)
    .map(s => ({ id: s.id, name: s.name, ...splitName(s.name) }));

  const toLink   = [];
  const toCreate = [];
  for (const g of groups) {
    const links = g.studentLinks || {};
    for (const name of (g.students || [])) {
      if (links[name]) continue;
      const match = byName.get(name.trim().toLowerCase());
      if (match) toLink.push({ groupName: g.name, rosterName: name, studentName: match.name });
      else toCreate.push({ groupName: g.name, rosterName: name });
    }
  }

  let sessionsToBackfill = 0;
  for (const g of groups) {
    const snap = await getDocs(query(collection(db, "sessions"), where("groupId", "==", g.id)));
    sessionsToBackfill += snap.docs.filter(d => !d.data().attendeeIds).length;
  }

  return { nameSplits, toLink, toCreate, sessionsToBackfill };
}

export async function runRegistryMigration() {
  const students = await loadStudentsConfig();
  const groups   = await loadGroups();
  const byName = new Map(students.map(s => [s.name.trim().toLowerCase(), s]));
  const createdLog = [];

  // Phase 1: split names that don't have firstName/lastName yet.
  for (const s of students) {
    if (s.firstName && s.lastName) continue;
    const { firstName, lastName } = splitName(s.name);
    s.firstName = firstName; s.lastName = lastName;
    await updateDoc(doc(db, "students", s.id), { firstName, lastName });
  }

  // Phase 2: link (or auto-create + link) every group roster name.
  for (const g of groups) {
    const links = { ...(g.studentLinks || {}) };
    let changed = false;
    for (const name of (g.students || [])) {
      if (links[name]) continue;
      const key = name.trim().toLowerCase();
      let match = byName.get(key);
      if (!match) {
        const { firstName, lastName } = splitName(name);
        match = {
          id: generateId("s"), name: name.trim(), firstName, lastName,
          type: "existing", order: students.length, targets: []
        };
        await saveStudent(match);
        students.push(match);
        byName.set(key, match);
        createdLog.push({ groupName: g.name, rosterName: name, studentId: match.id });
      }
      links[name] = match.id;
      changed = true;
    }
    if (changed) { g.studentLinks = links; await saveGroup(g); }
  }

  // Phase 3: backfill studentId on historical remarks + attendeeIds on the
  // session document, using the links just established above.
  for (const g of groups) {
    const links = g.studentLinks || {};
    const snap = await getDocs(query(collection(db, "sessions"), where("groupId", "==", g.id)));
    for (const d of snap.docs) {
      const data = d.data();
      const updates = {};
      const attendeeIds = new Set(data.attendeeIds || []);
      for (const [remId, r] of Object.entries(data.remarks || {})) {
        const linkedId = r.studentName && links[r.studentName];
        if (linkedId && r.studentId !== linkedId) {
          updates[`remarks.${remId}.studentId`] = linkedId;
          attendeeIds.add(linkedId);
        }
      }
      (data.attendees || []).forEach(name => { if (links[name]) attendeeIds.add(links[name]); });
      const idsArr = [...attendeeIds];
      if (Object.keys(updates).length || idsArr.length !== (data.attendeeIds || []).length) {
        updates.attendeeIds = idsArr;
        await updateDoc(doc(db, "sessions", d.id), updates);
      }
    }
  }

  // Phase 4: give each affected student's individual sessions and group
  // sessions a lifetime number where they're still missing one (their
  // individual sessions previously used a per-month count, and their group
  // sessions had no personal count at all until phase 3 linked them) — oldest
  // numbered session = 1, counting only up from there, independently for
  // each track.
  // Deliberately only fills in MISSING numbers (s.number == null) and never
  // touches a session that already has one — this used to unconditionally
  // reset every session to sequential-by-date order on every run, which
  // silently destroyed any manual "Change Session Number" edit the moment
  // this one-time setup was run a second time (e.g. because a new group was
  // added later and the preview reported other legitimate work to do). A
  // student's first migration run assigns every session a number, so on any
  // run after that this loop is a no-op for them — safe to re-run indefinitely.
  const affectedIds = new Set();
  for (const g of groups) Object.values(g.studentLinks || {}).forEach(id => affectedIds.add(id));
  for (const s of students) {
    const indivSnap = await getDocs(query(collection(db, "sessions"), where("studentId", "==", s.id)));
    if (!indivSnap.empty) affectedIds.add(s.id);
  }
  for (const studentId of affectedIds) {
    const indiv = (await getIndividualSessionsForStudent(studentId)).sort((a, b) => a.date.localeCompare(b.date));
    let nextIndivNum = indiv.reduce((max, s) => Math.max(max, s.number || 0), 0) + 1;
    for (const s of indiv) {
      if (s.number == null) await updateDoc(doc(db, "sessions", s.id), { sessionNumber: nextIndivNum++ });
    }
    const group = (await getGroupSessionsForStudent(studentId)).sort((a, b) => a.date.localeCompare(b.date));
    let nextGroupNum = group.reduce((max, s) => Math.max(max, s.number || 0), 0) + 1;
    for (const s of group) {
      if (s.number == null) {
        await updateDoc(doc(db, "sessions", s.id), { [`attendeePersonalSessionNumbers.${studentId}`]: nextGroupNum++ });
      }
    }
  }

  return createdLog;
}

export async function deleteGroupTargetDataFromSessions(groupId, targetName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  const key = sanitizeKey(targetName);
  for (const sd of snap.docs) {
    const data = sd.data();
    const updates = {};
    const actIds = [];
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === targetName) { updates[`activities.${actId}`] = deleteField(); actIds.push(actId); }
    }
    for (const [remId, rem] of Object.entries(data.remarks || {})) {
      if (actIds.includes(rem.activityId)) updates[`remarks.${remId}`] = deleteField();
    }
    if ((data.fedcComments || {})[key] !== undefined) updates[`fedcComments.${key}`] = deleteField();
    if (Object.keys(updates).length > 0) await updateDoc(doc(db, "sessions", sd.id), updates);
  }
}

/** Add a remark for a specific student in a group session. */
export async function addGroupRemark(sessionId, actId, studentName, text = "", remId = generateId("r")) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}`]: { activityId: actId, studentName, text, trials: [], order: Date.now() }
  });
  return remId;
}

/** Add remarks for multiple students in one write (no sequential re-renders).
 *  remIds, if supplied, must be the same length as entries (see addRemark). */
export async function addGroupRemarksBatch(sessionId, entries, remIds = null) {
  const updates = {};
  const now = Date.now();
  const ids = remIds || entries.map(() => generateId("r"));
  entries.forEach(({ actId, studentName }, i) => {
    updates[`remarks.${ids[i]}`] = { activityId: actId, studentName, text: "", trials: [], order: now };
  });
  await updateDoc(doc(db, "sessions", sessionId), updates);
  return ids;
}

/** Delete multiple remarks in one write (no sequential re-renders). */
export async function deleteRemarksBatch(sessionId, remIds) {
  const updates = {};
  for (const remId of remIds) updates[`remarks.${remId}`] = deleteField();
  await updateDoc(doc(db, "sessions", sessionId), updates);
}

/** Clear a remark's text and trials without removing the record (keeps the student row visible). */
export async function clearRemark(sessionId, remId) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.text`]: "",
    [`remarks.${remId}.trials`]: []
  });
}
