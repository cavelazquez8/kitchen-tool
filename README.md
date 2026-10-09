# Mise — Kitchen inventory

A touch-friendly kitchen inventory with a dark interface, grocery barcode scanning,
and Markdown you can paste into Gemini. Works at narrow phone, unfolded, and laptop
sizes. The first release does not connect to an AI API, Obsidian, or receipt imports.

## Private hosted copy

[Open Mise](https://mise-kitchen-cv8.expertroot3.chatgpt.site) in Microsoft Edge.
This copy uses Sites and starts with browser-only saving. Its identity is recorded
in `.openai/hosting.json`; future edits reuse that project and the same website URL.
Firebase sync and the GitHub deployment pipeline below require separate account
configuration. They are implemented but are not connected in the hosted copy.

## Run locally

Use Node 24 LTS and npm 11 or later (`.nvmrc` records the Node major).

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. Without Firebase configuration, inventory is stored in
**this browser only**. A different device, browser profile, or website origin has a
different inventory. Clearing site data removes the browser copy. Settings → Download
backup saves a complete JSON inventory that you can restore on another device; restore
requires confirmation because it replaces the inventory you are viewing. Markdown
copy/download is the human-readable Gemini export, not a restore format.

The generated `package-lock.json` is committed. Use `npm ci` for reproducible
installs. No credentials are needed to use local mode.

## Shared inventory and HTTPS

1. Create a Firebase project on the **Spark** plan; do not enable paid billing.
2. Register a web app and enable Google sign-in in Authentication.
3. Create a Standard Firestore database. Keep its initial rules closed until the
   repository rules are deployed.
4. Copy `.env.example` to `.env.local` and fill the four `VITE_FIREBASE_` client values
   from the Firebase app configuration. Restart Vite after changing these values.
5. Add localhost and your eventual Hosting domain under Authentication → Settings →
   Authorized domains. Firebase client values are public; security comes from auth
   and database rules. Never put service-account credentials in a `VITE_` variable.
6. Run the initial deployment below from your configured account:

```sh
npx firebase login
npm run check
npm run test:rules
npm run build
npx firebase deploy --project YOUR_PROJECT_ID --only firestore:rules,hosting
```

Sign in with the same Google account on each device. Cloud inventory is separate
from browser inventory. Transfer a browser copy only with the explicit settings
action; replacing a nonempty cloud inventory requires a separate confirmation.
Download the existing inventory before replacement if you want a readable copy.
Signing out returns to
that device's existing browser copy, not an automatically downloaded cloud copy.

HTTPS is required for phone camera access. Opening the laptop's development server
over ordinary LAN HTTP will not enable camera scanning on the phone. Use the deployed
HTTPS website for real-device testing. Typed barcode entry remains available.

Free service quotas apply. Keep billing disabled; exceeding a quota may make the
service unavailable. No cloud resources are created by installing this repository.

## Tests

```sh
npm run check
npx playwright install chromium
npm run test:e2e
npm run test:rules
```

Rules tests use the `demo-kitchen` emulator project and require Java 21+. Browser tests
cover representative 412px, 896px, and desktop widths; they do not establish exact
Samsung hardware dimensions or native fold detection. Perform a real-device check
in Microsoft Edge for camera permissions, touch editing, clipboard copying, folding,
keyboard appearance, and split-screen resizing. There is no Samsung Internet target.

For interactive emulator work, run `npm run emulators`, set
`VITE_USE_FIREBASE_EMULATORS=true` in `.env.local`, and restart the dev server. Emulator
mode always uses `demo-kitchen`, never production. Emulator addresses target the
local laptop, so use this mode locally rather than on the phone.

## Push updates

Create a GitHub repository and connect this project. The delivery workflow runs
checks, a production-dependency security audit, emulator rules tests, and browser
tests for pull requests and main pushes.
Live deployment remains disabled until Firebase is configured.

In GitHub's **production environment**, configure:

- Variables: `FIREBASE_PROJECT_ID`, `VITE_FIREBASE_API_KEY`,
  `VITE_FIREBASE_AUTH_DOMAIN`, and `VITE_FIREBASE_APP_ID`.
- Secret: `FIREBASE_SERVICE_ACCOUNT`, containing the Firebase Hosting deployment
  service-account JSON. Obtain/configure this through Firebase's GitHub integration;
  never commit or expose the JSON in the browser build.

The workflow's deployment gate reads the project ID at repository scope, so also set
the `FIREBASE_PROJECT_ID` **repository variable**. Restrict production deployments to
main. After the first manual rules deployment, pushes to main deploy the website
only after all checks pass. Future database rule changes must be tested and deployed
explicitly with `firebase deploy --only firestore:rules`.

The same website address receives every release. Hashed assets are cached, while
HTML revalidates; refresh when convenient to receive a new version. The app does not
force a reload during editing or scanning and does not cache old app code in a
service worker. Browser/cloud inventory is stored separately from website assets.
Firebase Hosting's release history supports rolling back the website; keep schema
changes backward compatible because rolling back assets does not restore data.

References: [Firebase GitHub integration](https://firebase.google.com/docs/hosting/github-integration),
[Google sign-in](https://firebase.google.com/docs/auth/web/google-signin),
[Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions).

Barcode product suggestions use Open Food Facts and may be incomplete. Review unknown
products manually; expiration dates are entered by the user, not inferred from UPCs.

## Dependency maintenance

The production dependency audit currently reports no findings. A scoped gRPC override
keeps Firebase's Node-side dependency on a patched, compatible major version. CI
blocks deployment for high or critical production dependency findings.

The latest Firebase CLI still brings development-only audit findings through braces,
basic-ftp, OpenTelemetry, and uuid. These packages are not included in the browser
build. Recheck upstream releases during maintenance; do not use `npm audit fix
--force`, whose suggested changes include unsupported downgrades and breaking
dependency substitutions. Build and emulator tools run only in the development/CI
environment.
