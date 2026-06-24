// ============================================================
// CONFIG.JS — App-wide constants + initial seed data for Firebase
// Student/target/activity config is stored in Firestore after first run.
// ============================================================

export const CONFIG = {

  // The actual PIN is no longer stored here — it's the password on a real
  // Firebase Auth account now (see signInWithPin in firebase-service.js),
  // checked by Firebase's servers instead of compared inside this
  // downloadable file. This just tells the keypad UI how many dots to show.
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
