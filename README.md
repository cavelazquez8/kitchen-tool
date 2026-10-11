# Mise — Kitchen companion

A touch-friendly kitchen inventory, recipe library, meal planner, shopping list, and optional Gemini assistant. The dark interface works in Microsoft Edge on a narrow phone, an unfolded device, and a laptop.

[Open Mise](https://mise-kitchen-cv8.expertroot3.chatgpt.site). Future releases reuse the project in `.openai/hosting.json` and the same URL.

## Everyday use

- Add foods with in-app autocomplete, scan barcodes, or tap familiar ingredients while shopping.
- Scanning automatically continues by default. Turn it off in the scanner; the preference stays on this device.
- Repeated intentional scans ask before adding another package. Unknown products open a complete manual entry form and pause the camera.
- Keep purchases separate by storage location, unit, purchase date, and expiration date. Countable items have −1 and Undo; Used some handles larger changes.
- Discover familiar recipes from the free TheMealDB API, add your own, or import pasted recipes. Website import uses published Recipe JSON-LD through the optional backend.
- Review recorded quantities, cook with step timers, and optionally keep the screen awake. Finish cooking reviews deductions before changing inventory.
- Save recipes and choose meal-plan portions. Request a shopping list to combine requirements and subtract inventory once.
- Ask Gemini follow-up questions inside Mise after connecting the optional free-tier backend. Copy for Gemini remains available without a backend.

Matching and shopping calculations run locally. Unknown quantities, package contents, and original recipe yields stay unknown until you record them. A generic ingredient name can map a branded product to recipe ingredients. The bundled food/tool catalogue is an autocomplete starter; it is not a comprehensive product database. Barcode suggestions come from Open Food Facts.

TheMealDB provides a modest starter library rather than an exhaustive recipe database. Mise fetches bounded suggestions/search results without crawling the whole service. Attribution and recipe source links remain visible.

## Data and backups

Kitchen data is saved in **this browser only**. There is no active Firebase connection. Another device, browser profile, or website origin has a separate kitchen. Clearing site data removes the local copy.

Settings → Download backup saves inventory, tools, saved recipes, meal plan, shopping list, and conversation. Restoring requires confirmation and replaces the current kitchen. Older inventory-only backups remain supported. Google API keys and device pairing credentials are excluded. Markdown export is a copyable Gemini context document, not a restore format.

## Free Gemini connection

Follow [the setup guide](docs/gemini-setup.md). Your Google API key stays in a Cloudflare Worker secret; the interface stores only a separate personal pairing token. Keep Google billing unlinked and Cloudflare on Workers Free. Consumer Gemini subscriptions do not include Gemini API quota.

Inventory, recipe editing/matching, shopping lists, and backups work without Gemini. Website import and AI extraction require the optional backend. Text import also works locally. Free quotas and small-media limits apply; a successful connection check verifies pairing, and your first question verifies actual model access.

## Run and verify

Use Node 24 and npm 11 or newer.

```sh
npm ci
npm ci --prefix server
npm run dev
```

Open `http://localhost:5173`. Camera access on a phone requires HTTPS; use the deployed website for real-device scanning. Typed barcode entry always remains available.

```sh
npm run check
npx playwright install chromium
npm run test:e2e
```

The browser suite exercises representative 412px, 896px, and desktop widths. It does not prove exact Galaxy hardware dimensions or native fold detection. Check camera permissions, the Edge keyboard, folding, split screen, clipboard, and wake lock on your actual phone.

The previous Firebase adapter and emulator fixtures are retained as inactive code for a potential future sync feature. They do not select the current repository or require account setup. `npm run test:rules` can still test that adapter's rules with Java 21.

## Updates

Builds use versioned assets. Releases keep the same website address and never force a reload during editing, scanning, or cooking. Refresh when convenient to load a new release; local kitchen data is stored separately.

The Sites source workflow prepares, checks, commits, uploads, and privately publishes this project's release. The GitHub workflow runs checks and browser tests if this repository is connected to GitHub; it does not provision Firebase or deploy to a different host.

`npm run build` also rebuilds the downloadable Worker module from source. Changing the frontend does not require rotating secrets or changing your Worker address. After backend changes, deploy the new Worker module to the same Worker; existing secrets remain in its settings.

Keep schemas backward compatible: rolling back website code does not roll back kitchen data. Back up the kitchen before a major change.
