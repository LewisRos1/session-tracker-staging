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
  getDocs,
  query,
  where,
  orderBy,
  limit as firestoreLimit,
  onSnapshot,
  deleteField,
  serverTimestamp
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
setPersistence(auth, browserLocalPersistence); // stay signed in across reloads
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

/** Like getOrCreateTodaySession but for any date (used when boss chooses session date upfront). */
export async function getOrCreateSessionForDate(studentId, dateStr, targets = []) {
  const month = getMonthString(dateStr);

  const existingSnap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId),
      where("date",      "==", dateStr))
  );
  if (!existingSnap.empty) return existingSnap.docs[0].id;

  const monthSnap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId),
      where("month",     "==", month))
  );
  const existingDates = new Set(monthSnap.docs.map(d => d.data().date));
  existingDates.add(dateStr);
  const sortedDates   = [...existingDates].sort();
  const sessionNumber = sortedDates.indexOf(dateStr) + 1;

  // Renumber any existing sessions whose position shifted
  for (const d of monthSnap.docs) {
    const newNum = sortedDates.indexOf(d.data().date) + 1;
    if (newNum !== d.data().sessionNumber) {
      updateDoc(doc(db, "sessions", d.id), { sessionNumber: newNum }).catch(() => {});
    }
  }

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

  // Recalculate session number within the target month
  const monthSnap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId),
      where("month",     "==", month))
  );
  const dates = new Set(
    monthSnap.docs.filter(d => d.id !== sessionId).map(d => d.data().date)
  );
  dates.add(newDateStr);
  const sessionNumber = [...dates].sort().indexOf(newDateStr) + 1;

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

  await updateDoc(doc(db, "sessions", sessionId), { date: newDateStr, month, sessionNumber });
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

export async function addRemark(sessionId, actId, text, predefinedKey = null) {
  const remId = generateId("r");
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
  const snap = await getDocs(
    query(collection(db, "sessions"),
      where("studentId", "==", studentId),
      orderBy("date", "asc"))
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
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

export async function getOrCreateGroupSessionForDate(groupId, dateStr, targets = [], attendees = []) {
  const month = getMonthString(dateStr);
  const existing = await getDocs(
    query(collection(db, "sessions"),
      where("groupId", "==", groupId),
      where("date",    "==", dateStr))
  );
  if (!existing.empty) {
    await updateDoc(doc(db, "sessions", existing.docs[0].id), { attendees });
    return existing.docs[0].id;
  }
  const monthSnap = await getDocs(
    query(collection(db, "sessions"),
      where("groupId", "==", groupId),
      where("month",   "==", month))
  );
  const dates = new Set(monthSnap.docs.map(d => d.data().date));
  dates.add(dateStr);
  const sessionNumber = [...dates].sort().indexOf(dateStr) + 1;
  const targetsSnapshot = targets.map(t => ({
    id: t.id, name: t.name, maxPoints: t.maxPoints,
    predefinedActivities: t.predefinedActivities || [],
    notes: t.notes || [], hasComment: t.hasComment || false, fullName: t.fullName || ""
  }));
  const ref = await addDoc(collection(db, "sessions"), {
    groupId, date: dateStr, month, sessionNumber, attendees,
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
export async function addGroupRemark(sessionId, actId, studentName, text = "") {
  const remId = generateId("r");
  await updateDoc(doc(db, "sessions", sessionId), {
    [`remarks.${remId}`]: { activityId: actId, studentName, text, trials: [], order: Date.now() }
  });
  return remId;
}

/** Add remarks for multiple students in one write (no sequential re-renders). */
export async function addGroupRemarksBatch(sessionId, entries) {
  const updates = {};
  const now = Date.now();
  const remIds = [];
  for (const { actId, studentName } of entries) {
    const remId = generateId("r");
    remIds.push(remId);
    updates[`remarks.${remId}`] = { activityId: actId, studentName, text: "", trials: [], order: now };
  }
  await updateDoc(doc(db, "sessions", sessionId), updates);
  return remIds;
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
