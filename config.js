// ============================================================
// CONFIG.JS — App-wide constants + initial seed data for Firebase
// Student/target/activity config is stored in Firestore after first run.
// ============================================================

// ─── FIREBASE CONFIGURATION ────────────────────────────────
// This file stays in each repo — never overwritten during deploys.
// Staging repo has staging values; live repo has live values.
export const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDzIdlSu_ipdbPtg9TEdWorGaznkslqsGI",
  authDomain:        "session-tracker-staging.firebaseapp.com",
  projectId:         "session-tracker-staging",
  storageBucket:     "session-tracker-staging.firebasestorage.app",
  messagingSenderId: "43697728086",
  appId:             "1:43697728086:web:505e802505e14b0346a9f7"
};
// ────────────────────────────────────────────────────────────

export const CONFIG = {

  PIN: "0108",
  PIN_LENGTH: 8,

  SCORE_LABELS: {
    3: {
      0: "Refuse to Engage",
      1: "Fully Prompt",
      2: "Partial Prompt",
      3: "Independent"
    },
    4: {
      0: "Refuse to Respond / Call Out",
      1: "Partial Prompted (Choice given)",
      2: "Prompted Response (Beyond 5s)",
      3: "Delayed Response (5s)",
      4: "Attempt Independently"
    }
  },

  // ─── Seed data ────────────────────────────────────────────
  // Written to Firebase once on first run (when students collection is empty).
  // After that, all edits happen through the Admin screen.
  INITIAL_STUDENTS: []
};
