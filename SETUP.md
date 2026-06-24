# Therapy Session Tracker — Setup Guide

## File Structure

```
session-tracker/
├── index.html          ← main app
├── styles.css
├── config.js           ← edit students/targets here
├── app.js              ← UI logic
├── firebase-service.js ← Firebase config goes here
├── export.js           ← Excel export
├── manifest.json       ← PWA manifest
├── sw.js               ← service worker
├── icon-192.png        ← PWA icon (generate below)
├── icon-512.png        ← PWA icon (generate below)
└── generate-icons.html ← open once to make the icons
```

---

## Step 1 — Create Firebase Project

1. Go to [console.firebase.google.com](https://console.firebase.google.com)
2. Click **Add project** → give it a name → continue
3. Disable Google Analytics (not needed) → **Create project**

### Enable Firestore
4. In the left sidebar → **Firestore Database** → **Create database**
5. Choose **Start in production mode** → pick a region close to you → **Enable**

### Get your config keys
6. Click the gear icon → **Project settings**
7. Scroll down to **Your apps** → click **</>** (Web app)
8. Register the app (any nickname) → copy the `firebaseConfig` object

---

## Step 2 — Fill in Firebase Config

Open `firebase-service.js` and replace the placeholder values:

```javascript
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSy...",        // ← paste your value
  authDomain:        "your-app.firebaseapp.com",
  projectId:         "your-app",
  storageBucket:     "your-app.appspot.com",
  messagingSenderId: "123456789",
  appId:             "1:123456789:web:..."
};
```

### Set Firestore Security Rules
In Firebase Console → Firestore → **Rules** tab, paste:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      // PIN protection is handled by the app.
      // Anyone with the URL can read/write — fine for a private app.
      allow read, write: if true;
    }
  }
}
```
Click **Publish**.

---

## Step 3 — Generate App Icons

1. Open `generate-icons.html` in Chrome
2. Two PNG files will download automatically: `icon-192.png` and `icon-512.png`
3. Place both files in the same folder as `index.html`

---

## Step 4 — Host on GitHub Pages

1. Create a GitHub repository (can be private with GitHub Pro, or public)
2. Push all files to the repo root (or a `/docs` folder)
3. In repo **Settings → Pages** → Source: `main` branch, `/ (root)` → **Save**
4. GitHub Pages URL will be something like `https://yourusername.github.io/repo-name`
5. Add it to the home screen on your device (browser → Share → Add to Home Screen)

### Firestore: allow GitHub Pages origin
In Firebase Console → **Authentication** → **Settings** → **Authorized domains**,
add your GitHub Pages domain (e.g. `yourusername.github.io`).

---

## Step 5 — Test

1. Open the URL → enter PIN `T7M2KP`
2. Tap a student name → session screen opens
3. Select a target → add an activity (or for FEDC, tap **+ Add Remark** on a predefined activity)
4. Add remarks and trials
5. Close the tab → reopen → everything is still there (Firebase offline mode)

---

## Editing Students / Targets

All student and target configuration is in **`config.js`** — no other files need changing.

To add a new target to a student, add an entry to that student's `targets` array:
```javascript
{ name: "New Target", maxPoints: 3 }
```

To add predefined activities to any target (making it FEDC-style):
```javascript
{
  name: "My Target",
  maxPoints: 3,
  predefinedActivities: [
    { name: "First activity" },
    { name: "Second activity", group: "Optional section heading" }
  ],
  hasComment: true  // adds a free-text Comment field
}
```

---

## PIN

The PIN is set in `config.js`:
```javascript
PIN: "T7M2KP"
```
Change it here to update. No other files need editing.
