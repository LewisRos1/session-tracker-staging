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
 * this student, and shifts any of their existing sessions whose position
 * shifted as a result (e.g. inserting a back-dated session pushes every
 * later one up by one). excludeSessionId skips a session's own pre-edit
 * entry when recomputing for a date change on that same session. kind
 * ("individual" | "group") scopes this to just that track — a student's
 * individual and group session counts are deliberately independent of each
 * other, each its own lifetime sequence.
 *
 * IMPORTANT: this shifts existing sessions RELATIVE to their own current
 * number (+1 each, for every session from the insertion point onward) —
 * it must never recompute a session's number from its absolute chronological
 * position. A boss-driven Change Session Number edit deliberately makes a
 * session's number NOT match its chronological position (e.g. continuing a
 * real-world paper-tracked count) — recomputing from scratch on every later
 * "Start Session" call silently undid that edit the moment any new session
 * was created for that student afterward. (Real bug, found from boss
 * reports of an edited number "reverting" with no migration button involved.)
 */
// prefetchedExisting: pass an already-fetched list (from getIndividualSessionsForStudent
// /getGroupSessionsForStudent) to skip the redundant re-fetch — used by the
// "start a session" hot path, which already has to fetch this same list to
// check whether today's session exists yet.
async function assignLifetimeSessionNumber(studentId, dateStr, excludeSessionId, kind, prefetchedExisting = null) {
  const fetchExisting = kind === "individual" ? getIndividualSessionsForStudent : getGroupSessionsForStudent;
  const field = kind === "individual" ? "sessionNumber" : `attendeePersonalSessionNumbers.${studentId}`;
  const existing = (prefetchedExisting || await fetchExisting(studentId))
    .filter(s => s.id !== excludeSessionId)
    .sort((a, b) => a.date.localeCompare(b.date));

  const insertPos = existing.findIndex(s => s.date > dateStr);
  const pos = insertPos === -1 ? existing.length : insertPos;
  const myNumber = pos === 0 ? 1 : (existing[pos - 1].number || 0) + 1;

  for (let i = pos; i < existing.length; i++) {
    const s = existing[i];
    const newNum = (s.number || 0) + 1;
    updateDoc(doc(db, "sessions", s.id), { [field]: newNum }).catch(() => {});
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

  await updateDoc(doc(db, "sessions", sessionId), { date: newDateStr, month });
  await resequenceIndividualSessions(studentId);
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

// actId can be supplied by the caller (e.g. to write the activity into local
// state immediately, before this write reaches the server — see addRemark's
// matching comment) — otherwise one is generated here.
export async function adoptOrphanActivity(sessionId, actId, parentActivity, configId = null) {
  const updates = { [`activities.${actId}.parentActivity`]: parentActivity };
  if (configId) updates[`activities.${actId}.configId`] = configId;
  await updateDoc(doc(db, "sessions", sessionId), updates);
}

export async function addActivity(sessionId, targetName, activityName, order, isPredefined = false, actId = generateId("a"), parentActivity = null, configId = null) {
  const actData = { targetName, activityName, order, isPredefined };
  if (parentActivity) actData.parentActivity = parentActivity;
  if (configId) actData.configId = configId;
  await updateDoc(doc(db, "sessions", sessionId), {
    [`activities.${actId}`]: actData
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

// An activity can occasionally get created TWICE within the same session
// under the exact same (targetName, activityName) — not a rename/typo
// problem (the name matches the current config perfectly either way), but
// a duplicate-creation race: the structured/mapped-score auto-fill
// features check "does a matching activity already exist?" before
// creating one, and if two snapshot callbacks (e.g. two devices/tabs open
// on the same session, or a reload mid-write) each run that check before
// the other's addActivity has landed, both conclude "no" and both create
// one. Every screen that looks up an activity by name only ever returns
// ONE of the two (Array.find()'s first match), so whichever duplicate
// isn't picked becomes invisible everywhere except exports (which have a
// separate orphan-recovery fallback that surfaces it again, looking like
// a confusing ghost duplicate). Folds the duplicate's remarks onto the
// primary activity and removes the now-empty shell — no data deleted,
// just re-pointed to the activity that's actually displayed.
export async function mergeDuplicateActivity(sessionId, primaryActId, duplicateActId) {
  const snap = await getDoc(doc(db, "sessions", sessionId));
  if (!snap.exists()) return;
  const data = snap.data();
  const updates = {};
  for (const [remId, rem] of Object.entries(data.remarks || {})) {
    if (rem.activityId === duplicateActId) {
      updates[`remarks.${remId}.activityId`] = primaryActId;
    }
  }
  updates[`activities.${duplicateActId}`] = deleteField();
  await updateDoc(doc(db, "sessions", sessionId), updates);
}

export async function deleteOrphanAcrossSessions(studentId, targetName, activityName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("studentId", "==", studentId))
  );
  for (const sessionDoc of snap.docs) {
    const data = sessionDoc.data();
    const updates = {};
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === targetName && act.activityName === activityName) {
        updates[`activities.${actId}`] = deleteField();
        for (const [remId, rem] of Object.entries(data.remarks || {})) {
          if (rem.activityId === actId) updates[`remarks.${remId}`] = deleteField();
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      await updateDoc(doc(db, "sessions", sessionDoc.id), updates);
    }
  }
}

export async function deleteGroupOrphanAcrossSessions(groupId, targetName, activityName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  for (const sessionDoc of snap.docs) {
    const data = sessionDoc.data();
    const updates = {};
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === targetName && act.activityName === activityName) {
        updates[`activities.${actId}`] = deleteField();
        for (const [remId, rem] of Object.entries(data.remarks || {})) {
          if (rem.activityId === actId) updates[`remarks.${remId}`] = deleteField();
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      await updateDoc(doc(db, "sessions", sessionDoc.id), updates);
    }
  }
}

// ─── TRASH (SOFT DELETE — 30-DAY RECYCLE BIN) ──────────────────────────────

const TRASH_EXPIRY_DAYS = 30;

export async function softDeleteActivityAcrossSessions(entityType, entityId, entityName, targetName, activityName) {
  const q = entityType === "group"
    ? query(collection(db, "sessions"), where("groupId",   "==", entityId))
    : query(collection(db, "sessions"), where("studentId", "==", entityId));
  const snap = await getDocs(q);

  const sessionsData   = [];
  const sessionUpdates = [];

  for (const sessionDoc of snap.docs) {
    const data    = sessionDoc.data();
    const acts    = data.activities || {};
    const remarks = data.remarks    || {};

    const matches = Object.entries(acts).filter(([, a]) =>
      a.targetName === targetName && a.activityName === activityName
    );
    if (matches.length === 0) continue;

    const updates = {};
    for (const [actId, actRecord] of matches) {
      const actRemarks = {};
      for (const [remId, rem] of Object.entries(remarks)) {
        if (rem.activityId === actId) { actRemarks[remId] = rem; updates[`remarks.${remId}`] = deleteField(); }
      }
      updates[`activities.${actId}`] = deleteField();

      const hasData = Object.values(actRemarks).some(r =>
        (r.text || "").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim().length > 0 ||
        (r.trials || []).some(t => t !== null && t !== -1)
      );
      if (hasData) {
        sessionsData.push({
          sessionId: sessionDoc.id,
          sessionDate: data.date || "",
          sessionNumber: data.sessionNumber || data.number || 0,
          activityId: actId,
          activityRecord: actRecord,
          remarks: actRemarks
        });
      }
    }
    if (Object.keys(updates).length > 0) sessionUpdates.push({ sessionId: sessionDoc.id, updates });
  }

  if (sessionsData.length > 0) {
    const now       = new Date();
    const expiresAt = new Date(now.getTime() + TRASH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await addDoc(collection(db, "trash"), {
      entityType, entityId, entityName,
      targetName, activityName,
      deletedAt:    now.toISOString(),
      expiresAt:    expiresAt.toISOString(),
      sessionCount: sessionsData.length,
      sessionsData
    });
  }

  for (const { sessionId, updates } of sessionUpdates) {
    await updateDoc(doc(db, "sessions", sessionId), updates);
  }
}

export async function getTrashItems() {
  const snap = await getDocs(collection(db, "trash"));
  return snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export async function restoreTrashItem(trashId) {
  const trashSnap = await getDoc(doc(db, "trash", trashId));
  if (!trashSnap.exists()) throw new Error("Trash item not found");
  const item = trashSnap.data();
  for (const entry of (item.sessionsData || [])) {
    const sessionRef  = doc(db, "sessions", entry.sessionId);
    const sessionSnap = await getDoc(sessionRef);
    if (!sessionSnap.exists()) continue;
    const updates = {};
    updates[`activities.${entry.activityId}`] = entry.activityRecord;
    for (const [remId, remRecord] of Object.entries(entry.remarks || {})) {
      updates[`remarks.${remId}`] = remRecord;
    }
    await updateDoc(sessionRef, updates);
  }
  await deleteDoc(doc(db, "trash", trashId));
}

export async function permanentlyDeleteTrashItem(trashId) {
  await deleteDoc(doc(db, "trash", trashId));
}

export async function cleanupExpiredTrash() {
  try {
    const snap = await getDocs(collection(db, "trash"));
    const now  = new Date().toISOString();
    for (const d of snap.docs) {
      if ((d.data().expiresAt || "") <= now) await deleteDoc(d.ref);
    }
  } catch { /* silent — trash access may fail before rules are updated */ }
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

export async function setOptionScore(sessionId, remId, score) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.optionScore`]: score
  });
}

export async function clearOptionScore(sessionId, remId) {
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}.optionScore`]: deleteField()
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

/** Fetch a single student's latest config directly from Firestore (bypasses in-memory state). */
export async function getStudentById(studentId) {
  const snap = await getDoc(doc(db, "students", studentId));
  return snap.exists() ? snap.data() : null;
}

/** Save (upsert) a student config document. */
export async function saveStudent(student) {
  if (!student.name || !student.name.trim()) {
    throw new Error("Cannot save a student with a blank name.");
  }
  await setDoc(doc(db, "students", student.id), student);
}

/** Delete a student config document. */
export async function deleteStudentConfig(studentId) {
  await deleteDoc(doc(db, "students", studentId));
}

/** Toggle the "Ready for Word Export" flag on a student document. */
export async function setStudentWordExportReady(studentId, ready) {
  await updateDoc(doc(db, "students", studentId), { readyForWordExport: ready });
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

// Activities are matched to a target's predefinedActivities config by exact
// name text (see export.js's getAllActivitiesForTarget and app.js's
// findActivityByName) — so editing an activity's name without also updating
// every session that already recorded a remark under the old name would
// silently orphan that remark: invisible in the live UI, and surfaced as a
// confusing duplicate row in exports. Called right after a rename is saved
// in Edit Target, mirroring deleteTargetDataFromSessions' query shape above.
export async function renameActivityAcrossSessions(studentId, targetName, oldName, newName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("studentId", "==", studentId))
  );
  for (const sessionDoc of snap.docs) {
    const data = sessionDoc.data();
    const updates = {};
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === targetName && act.activityName === oldName) {
        updates[`activities.${actId}.activityName`] = newName;
      }
    }
    if (Object.keys(updates).length > 0) {
      await updateDoc(doc(db, "sessions", sessionDoc.id), updates);
    }
  }
}

// Same orphaning problem as renameActivityAcrossSessions above, but for the
// TARGET's own name rather than an activity within it: every session
// activity stores its parent target's name as plain text (act.targetName),
// so renaming a target without this would leave every historical session's
// activities — and everything keyed off them (remarks, trials, exports) —
// stuck under the old name and invisible under the renamed target.
export async function renameTargetAcrossSessions(studentId, oldName, newName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("studentId", "==", studentId))
  );
  for (const sessionDoc of snap.docs) {
    const data = sessionDoc.data();
    const updates = {};
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === oldName) {
        updates[`activities.${actId}.targetName`] = newName;
      }
    }
    if (Object.keys(updates).length > 0) {
      await updateDoc(doc(db, "sessions", sessionDoc.id), updates);
    }
  }
}

// A Select-one/Tick-boxes activity's recorded answer is the literal option
// text (rem.text), not an index/ID into inlineOptions — so retyping an
// option's wording (e.g. "Low" → "Fair") leaves every already-recorded
// answer of "Low" stuck under text that no longer matches any current pill,
// same orphaning shape as the rename bugs above. Called once per renamed
// option (isMulti activities store a comma-joined list of selections, so
// the old option text is replaced as a token within that list rather than
// requiring an exact whole-field match).
export async function renameRemarkOptionAcrossSessions(studentId, targetName, activityName, oldOpt, newOpt, isMulti) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("studentId", "==", studentId))
  );
  for (const sessionDoc of snap.docs) {
    const data = sessionDoc.data();
    const actIds = Object.entries(data.activities || {})
      .filter(([, act]) => act.targetName === targetName && act.activityName === activityName)
      .map(([actId]) => actId);
    if (actIds.length === 0) continue;
    const updates = {};
    for (const [remId, rem] of Object.entries(data.remarks || {})) {
      if (!actIds.includes(rem.activityId)) continue;
      if (isMulti) {
        const parts = (rem.text || "").split(", ").map(s => s.trim()).filter(Boolean);
        if (!parts.includes(oldOpt)) continue;
        updates[`remarks.${remId}.text`] = parts.map(p => (p === oldOpt ? newOpt : p)).join(", ");
      } else {
        if (rem.text !== oldOpt) continue;
        updates[`remarks.${remId}.text`] = newOpt;
      }
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

/**
 * Delete an empty individual session and shift all later sessions' numbers
 * down by 1 so no gap appears in the sequence.
 */
export async function deleteEmptyIndividualSession(sessionId, studentId, dateStr) {
  await deleteDoc(doc(db, "sessions", sessionId));
  const later = (await getIndividualSessionsForStudent(studentId)).filter(s => s.date > dateStr);
  for (const s of later) {
    updateDoc(doc(db, "sessions", s.id), { sessionNumber: (s.number || 0) - 1 }).catch(() => {});
  }
}

/**
 * Fill any gaps in a student's individual session numbers while preserving the
 * user's custom starting offset (e.g. 8,9,10,12 → 8,9,10,11 not 1,2,3,4).
 */
export async function resequenceIndividualSessions(studentId) {
  const sessions = (await getIndividualSessionsForStudent(studentId))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sessions.length === 0) return;
  const base = sessions[0].number ?? 1;
  for (let i = 0; i < sessions.length; i++) {
    const expected = base + i;
    if (sessions[i].number !== expected) {
      updateDoc(doc(db, "sessions", sessions[i].id), { sessionNumber: expected }).catch(() => {});
    }
  }
}

// ─── EXPORT DATA ─────────────────────────────────────────────

/** Fetch a single session document by ID. Used to get fresh data right before exporting. */
export async function getSessionById(sessionId) {
  const snap = await getDoc(doc(db, "sessions", sessionId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

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

// When a group roster slot is re-pointed at a different registered student
// (e.g. it was linked to an auto-created placeholder like "Hayden" and gets
// corrected to the real "Hayden Chan"), this is the same orphaning problem
// as renameActivityAcrossSessions, just one layer up: every existing session
// for this group still has the OLD name/id baked into its attendees/
// attendeeIds/attendeePersonalSessionNumbers/remarks, so the student
// registry keeps showing that history under the old (now-unlinked) student
// instead of the new one. Reassigns all of it in one pass. oldId may be
// null (the slot was previously unlinked/empty) — in that case there's
// nothing to migrate, callers should skip calling this entirely.
export async function reassignGroupStudentAcrossSessions(groupId, oldName, oldId, newName, newId) {
  if (!oldId) return;
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  for (const sd of snap.docs) {
    const data = sd.data();
    const updates = {};

    const attendees = data.attendees || [];
    const nameIdx = attendees.indexOf(oldName);
    if (nameIdx !== -1) {
      const newAttendees = attendees.slice();
      newAttendees[nameIdx] = newName;
      updates.attendees = newAttendees;
    }

    const attendeeIds = data.attendeeIds || [];
    if (attendeeIds.includes(oldId)) {
      updates.attendeeIds = attendeeIds.map(id => (id === oldId ? newId : id));
    }

    // Guard oldId === newId (a pure name-change re-sync, not an actual
    // re-link to a different student): without it, these two lines write
    // the SAME Firestore field path twice in one updates object, and the
    // deleteField() always wins — silently wiping the session number it
    // was just told to preserve.
    const numbers = data.attendeePersonalSessionNumbers || {};
    if (numbers[oldId] !== undefined && oldId !== newId) {
      updates[`attendeePersonalSessionNumbers.${newId}`] = numbers[oldId];
      updates[`attendeePersonalSessionNumbers.${oldId}`] = deleteField();
    }

    for (const [remId, rem] of Object.entries(data.remarks || {})) {
      if (rem.studentName === oldName) updates[`remarks.${remId}.studentName`] = newName;
    }

    if (Object.keys(updates).length > 0) await updateDoc(doc(db, "sessions", sd.id), updates);
  }
}

// Group counterpart of renameActivityAcrossSessions above — see its comment.
export async function renameGroupActivityAcrossSessions(groupId, targetName, oldName, newName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  for (const sd of snap.docs) {
    const data = sd.data();
    const updates = {};
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === targetName && act.activityName === oldName) {
        updates[`activities.${actId}.activityName`] = newName;
      }
    }
    if (Object.keys(updates).length > 0) await updateDoc(doc(db, "sessions", sd.id), updates);
  }
}

// Group counterpart of renameTargetAcrossSessions above — see its comment.
export async function renameGroupTargetAcrossSessions(groupId, oldName, newName) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  for (const sd of snap.docs) {
    const data = sd.data();
    const updates = {};
    for (const [actId, act] of Object.entries(data.activities || {})) {
      if (act.targetName === oldName) {
        updates[`activities.${actId}.targetName`] = newName;
      }
    }
    if (Object.keys(updates).length > 0) await updateDoc(doc(db, "sessions", sd.id), updates);
  }
}

// Group counterpart of renameRemarkOptionAcrossSessions above — see its
// comment. Renames the option for every attendee's recorded answer under
// this activity, regardless of which student said it.
export async function renameGroupRemarkOptionAcrossSessions(groupId, targetName, activityName, oldOpt, newOpt, isMulti) {
  const snap = await getDocs(
    query(collection(db, "sessions"), where("groupId", "==", groupId))
  );
  for (const sd of snap.docs) {
    const data = sd.data();
    const actIds = Object.entries(data.activities || {})
      .filter(([, act]) => act.targetName === targetName && act.activityName === activityName)
      .map(([actId]) => actId);
    if (actIds.length === 0) continue;
    const updates = {};
    for (const [remId, rem] of Object.entries(data.remarks || {})) {
      if (!actIds.includes(rem.activityId)) continue;
      if (isMulti) {
        const parts = (rem.text || "").split(", ").map(s => s.trim()).filter(Boolean);
        if (!parts.includes(oldOpt)) continue;
        updates[`remarks.${remId}.text`] = parts.map(p => (p === oldOpt ? newOpt : p)).join(", ");
      } else {
        if (rem.text !== oldOpt) continue;
        updates[`remarks.${remId}.text`] = newOpt;
      }
    }
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
