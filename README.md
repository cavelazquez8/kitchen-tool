# Mise — Kitchen companion

A touch-friendly kitchen inventory, recipe library, meal planner, shopping list, and optional Gemini assistant. The dark interface works in Microsoft Edge on a narrow phone, an unfolded device, and a laptop.

[Open Mise](https://cavelazquez8.github.io/kitchen-tool/). GitHub Pages publishes each push to `main`; the site address is public, while your kitchen data stays in your browser.

## Everyday use

- Add foods with in-app autocomplete, scan barcodes, or tap familiar ingredients while shopping.
- Scanning automatically continues by default. Turn it off in the scanner; the preference stays on this device.
- Each scan opens a quick review with storage destination, quantity, and optional expiration date. **Add & scan next** saves that purchase immediately; **Undo** removes it. Choose **Bulk scan** to send a batch to one location, optionally adding clear matches automatically. Duplicates, unknown products, and uncertain ingredient identities always require review.
- Keep purchases separate by storage location, unit, purchase date, and expiration date. Countable items have −1 and Undo; Used some handles larger changes.
- Choose **Recipe source** to browse your cookbook or search TheMealDB, RecipeAPI.io, or Spoonacular. Local results update as you type; online sources use a clearly named Search button. Category, cuisine, and expiration preferences apply to displayed recipes; sorting offers Name or Most matches. Categories and cuisines can be edited on each recipe, and counts reflect the filtered source.
- Optional sources show **Configured** after a setup check; **Test search** verifies a small live request. Empty states distinguish failed searches, no upstream matches, and results hidden by filters. Blank Spoonacular searches start with one chosen inventory ingredient and compare results with the rest of your kitchen.
- Open an imported recipe and choose **Delete recipe** to remove it from your personal library after confirmation. Any matching meal-plan entry is removed at the same time.
- Remove any recipe from **Saved recipes** using its trash button. Bundled cookbook recipes stay available in the cookbook after their saved copy is removed.
- Use **Add to Gemini** on recipe cards or details to attach multiple recipes without leaving the browser. Review or remove attachments in Gemini before sending a message.
- Adjust recorded inventory quantities with **+ / −** and Undo; unknown amounts stay manual. A small matching icon marks items whose recipe matching ingredient name needs review.
- **Clear all** under What to buy removes the shopping list after confirmation. Quick shopping entry keeps its scanner and searchable ingredient field without suggested-item chips.
- Choose **Recipe collection** for saved favorites, personal imports, your own recipes, or saved AI recipes. Collections combine with availability and text filters. Personal imports include text, website, image, and video imports; API saves remain under saved recipes.
- Add your own recipes or import pasted recipes. Website import uses published Recipe JSON-LD through the optional backend.
- Review recorded quantities, cook with step timers, and optionally keep the screen awake. Finish cooking reviews deductions before changing inventory.
- Save recipes and choose meal-plan portions. Request a shopping list to combine requirements and subtract inventory once.
- Ask Gemini follow-up questions inside Mise after connecting the optional free-tier backend. Copy for Gemini remains available without a backend.
- Choose a Gemini model in settings and save it on this device. **Worker default** uses Cloudflare’s configured model; supported free-tier choices travel with your requests.
- Mise checks Google’s model catalog and Standard free-tier pricing when you open settings after an hour. **Refresh models** checks immediately. Review and enable new verified choices before saving; paid or unverified models remain disabled. After the initial Worker update for discovery, new eligible model IDs need no separate Worker deployment.
- Open **Your profile** from Gemini or settings to manage daily nutrition targets and multiple body scans. Save PDFs, pictures, or pasted text; explicitly read with Gemini, review, then choose **Add to Gemini** for the reports you want in a conversation. Backups include the original files.
- Review recipe nutrition with USDA food matches and confirmed edible weights. Whole-recipe totals are available without a serving yield; partial estimates and missing data are labelled, and recorded yields enable per-serving values.

Matching and shopping calculations run locally. Unknown quantities, package contents, and original recipe yields stay unknown until you record them. Clear ingredient names are recognized; ambiguous branded foods require a confirmed generic ingredient name or an explicit **Use product name** choice. Barcode identities and reviewed original package sizes are remembered separately from remaining stock. Matching never guesses a package's weight or a mass/volume conversion.

Related milk, rice, and fresh/dried herb forms are shown for review; Mise does not assume substitutions or compare their quantities.

Food entry includes more than 5,700 locally searched Open Food Facts ingredient names, recent items, and common foods. **Find packaged products** performs an explicit online search for branded products, without a request on every keystroke. See [catalog attribution and updates](docs/food-catalog.md). Kitchen tools retain their separate suggestions and manual entry.

The built-in cookbook is a versioned snapshot of Wikibooks recipes, served with Mise and matched locally without a recipe API key or subscription. It loads only when Recipes is opened. Saved recipes remain available if the collection or online provider cannot load. TheMealDB requests are bounded and user initiated; they do not enumerate its full database.

Online result counts describe recipes loaded by your current search, not the provider's entire database. Changing a search term or source cancels stale results and paging; filter changes apply immediately without spending another API request. **Load more from [source]** requests another page for that same search. Only recipes you save join your personal cookbook.

Wikibooks content is adapted under CC BY-SA 4.0. Recipe details, saved records, and backups preserve contributor attribution, original revision links, and the content license. Recipe photos are not copied from Wikibooks. Unsupported, incomplete, or ambiguous source structures are excluded during ingestion; unknown amounts and yields remain unknown.

See [optional free recipe-source setup](docs/provider-setup.md). Provider keys stay in Worker secrets. RecipeAPI.io allows selected personal-library saves with attribution. Spoonacular results are temporary discovery links, expire within one hour, and never enter saved recipes, meal plans, Gemini context, or backups. The existing Gemini Worker needs the updated downloadable code before these optional endpoints work.

The downloadable Worker uses request options accepted by Cloudflare, including older dashboard compatibility dates. `npm run check` now runs the built Worker in workerd with intercepted upstream responses to check both providers and website imports without real keys or network access. Copying JavaScript into Cloudflare does not apply this repository's Wrangler settings.

## Data and backups

Kitchen data is saved in **this browser only**. There is no active Firebase connection. Another device, browser profile, or website origin has a separate kitchen. Clearing site data removes the local copy. To move to a new site address, download a backup on the old address and restore it on the new one, then reconnect Gemini (pairing credentials are not in backups).

Settings → Download backup saves inventory, tools, saved recipes, meal plan, shopping list, and conversation. Restoring requires confirmation and replaces the current kitchen. Older inventory-only backups remain supported. Google API keys and device pairing credentials are excluded. Markdown export is a copyable Gemini context document, not a restore format.

The built-in public collection is separate from personal kitchen data. Browsing never adds recipes or food to your inventory; only recipes you deliberately save enter your backup.

## Free Gemini connection

Follow [the setup guide](docs/gemini-setup.md). Your Google API key stays in a Cloudflare Worker secret; the interface stores only a separate personal pairing token. Keep Google billing unlinked and Cloudflare on Workers Free. Consumer Gemini subscriptions do not include Gemini API quota.

Inventory, recipe editing/matching, shopping lists, and backups work without Gemini. Website import and AI extraction require the optional backend. Text import also works locally. Free quotas and small-media limits apply; a successful connection check verifies pairing, and your first question verifies actual model access.

The recipe starting points highlight 24 existing, attributed cookbook dishes. Gemini's default recommendation mode receives a small locally retrieved shortlist and returns recipe IDs; Mise displays the original records with their missing groceries. Inventory is a preference, so an empty kitchen can still lead to a meal. Creating a recipe from inventory remains an explicit choice. Recommendations do not imply that a dish has verified nutrition or meets a dietary restriction.

Recipe starting points can shuffle the everyday collection or the whole built-in cookbook. Random picks stay in place until you shuffle again or switch back to inventory order; shuffling makes no provider or AI requests. Inside a recipe's nutrition review, **Test USDA lookup** distinguishes a configured key from a successful live food search without applying any food matches.

Optional [USDA nutrition support](docs/nutrition-setup.md) uses a free server-side key, reviewed food matches, and confirmed edible weights. Daily targets can be entered manually or extracted from pasted recommendations or a report image for review. Report files are not saved in kitchen data. Unknown nutrient values and missing recipe yields remain unknown. Approved targets and reviewed food matches travel in backups; API and pairing credentials do not.

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

## Refresh the built-in cookbook

`npm run recipes:update` snapshots the official Wikibooks API in sequential batches, validates ingredients and instructions, and atomically replaces `public/data/wikibooks-recipes.json`. It also updates the ingestion report under `docs/`. Review the report, run checks, and commit the data and parser together before publishing. Regular app builds use the committed snapshot and do not crawl a recipe service.

The previous Firebase adapter and emulator fixtures are retained as inactive code for a potential future sync feature. They do not select the current repository or require account setup. `npm run test:rules` can still test that adapter's rules with Java 21.

## Updates

Builds use versioned assets. Releases keep the same website address and never force a reload during editing, scanning, or cooking. Refresh when convenient to load a new release; local kitchen data is stored separately.

The Sites source workflow prepares, checks, commits, uploads, and privately publishes this project's release. The GitHub workflow runs checks and browser tests if this repository is connected to GitHub; it does not provision Firebase or deploy to a different host.

`npm run build` also rebuilds the downloadable Worker module from source. Changing the frontend does not require rotating secrets or changing your Worker address. After backend changes, deploy the new Worker module to the same Worker; existing secrets remain in its settings.

Keep schemas backward compatible: rolling back website code does not roll back kitchen data. Back up the kitchen before a major change.
