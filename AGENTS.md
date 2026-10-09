# Kitchen Wrapper

User friendliness is the product's primary acceptance criterion. Build a restrained,
professional dark interface with clear actions, readable inventory, generous touch
targets, accessible dialogs, and useful empty/error states. Primary mobile browser:
Microsoft Edge on the user's foldable Android phone; support narrow split-screen,
cover-sized, unfolded, and desktop viewports without claiming native posture support.

## Product constraints

- Start with empty inventory. Test/demo fixtures must never seed a real account.
- Home inventory groups Fridge, Freezer, and Pantry; tools are separate.
- Purchases retain separate quantities, purchase dates, and entered expiration dates.
- Unknown quantity is `null`, distinct from zero. Dates are date-only strings.
- Staples remain stocked until manually marked low/empty. No automatic shopping.
- Barcode scans add one package, with session review and repeated-frame suppression.
- Gemini receives copied/downloaded Markdown. No AI API, receipt imports, or Obsidian.
- Distinguish browser-only storage from signed-in cloud sync. Never imply local sync.
- Do not overwrite existing cloud data unless the user explicitly confirms replacement.
- Keep unfinished edits and scan sessions through responsive layout changes.

## Engineering

React, strict TypeScript, Vite, Tailwind, Firebase optional persistence, ZXing scanner.
Pure inventory operations live in `src/domain`; persistence in `src/lib`; scanner
integration is isolated from views. Firestore transaction reducers must be pure:
generate IDs and dates before starting an update. Validate external persisted data.
Keep Firebase service-account credentials out of source and client environment values.
Do not enable paid billing or provision cloud resources without explicit authorization.

Use small commits describing complete changes. Preserve the npm lockfile; use `npm ci`
after the first installation. Before reporting completion, run checks appropriate to
the changes and state any untested behavior honestly.

## Commands

- `npm run dev`: local interface.
- `npm run check`: lint, TypeScript, unit tests, production build.
- `npm run test:e2e`: browser workflows at narrow, unfolded, and desktop sizes.
- `npm run test:rules`: ownership/concurrency tests with the Firestore emulator.
- `npm run emulators`: local auth and Firestore; use demo project only.
- `npm run format`: format edited source; do not claim this is a test.

Deployment is configured for GitHub main pushes after checks pass. Firebase/GitHub
account setup is required before that workflow can deliver updates. Avoid forced
reloads, unnecessary service workers, and destructive data migrations.

The private hosted copy uses Sites. Reuse the project ID in `.openai/hosting.json`
and apply the Sites skill for source synchronization and publication. Preserve its
private audience and website origin. Firebase deployment is a separate optional
delivery path; do not claim it is configured until its account settings exist.
