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
- Barcode scans default to automatic next-item capture with repeated-frame suppression. Quick review commits each purchase immediately, with destination and optional expiration visible. Bulk mode can remember one destination; optional automatic saves apply only to clear new products. Repeat items, unknown products, and uncertain identities require confirmation. Original package quantities remain separate from a batch's remaining stock.
- Gemini supports copied Markdown and an optional free-tier API behind an authenticated Cloudflare Worker. No Firebase setup, receipt imports, or Obsidian in this release. API secrets stay server-side; local pairing credentials never enter backups.
- The assistant helps choose real publisher recipes through bounded search and page-inspection tools. Inventory prevents duplicate shopping; limiting dishes to on-hand ingredients or prioritizing expiry requires the user's request. Natural cooking follow-ups do not require recommending a recipe. Tavily search requires a server-side key and explicit TAVILY_PLAN=free; never enable paid fallback. Only inspected complete recipes or supplied local candidates produce recipe cards. Keep search snippets separate from verified recipe records.
- Recipe browsing starts with the personal collection. The bundled Wikibooks collection and optional TheMealDB, RecipeAPI.io, and Spoonacular searches are additional discovery paths. Preserve per-recipe attribution, license, source revision links, publisher metadata, and original ingredient measures in details and backups. Ingestion must reject incomplete/unsupported structures rather than silently drop required ingredients. Never invent yields or quantities. RecipeAPI selected personal saves retain attribution; Spoonacular is transient source-link discovery only and must expire within one hour, with no persistent records or AI copying. Additional provider keys stay server-side and require explicit free-plan configuration.
- Keep Recipes focused on the collection: one heading, search, Sort by menu, and Filters drawer with removable active-filter chips. Do not restore Everyday picks, duplicate discovery panels, sorting tabs, or multiple always-visible filter rows. Keep source selection and active-filter state clear while leaving detailed controls in the drawer.
- Save assistant cards, attached recipes, and drafts with kitchen data, including backups; a tab change must not discard the conversation. Older Workers remain usable with an explicit upgrade notice and context-preserving fallback. Body scans autofill editable literal report fields; preserve units and ranges, distinguish measurements from recorded recommendations, and never turn BMR into an intake target. Only selected reviewed profile context is attached to chat.
- Chat inventory has independent All, Selected, and None modes. Scope request text, local candidate matching, and copied context consistently; selected products include their batches across locations. Never widen an empty selection to all inventory or infer unshared ingredients are missing. Keep the preference through navigation, backup/restore, and clearing conversation. Optional starred ingredient priorities are soft preferences, scoped to shared inventory in requests, retrieval and copied context, never hard filters. Preserve them in storage and backups. Explain that it applies to new messages; earlier conversation may still mention inventory. Shopping calculations continue using the full kitchen.
- Assistant recipe sources are explicit and persisted: web mode never retrieves saved/bundled recipes automatically; cookbook mode retrieves a bounded shortlist from saved plus bundled records, including saved generated dishes, without live provider calls; create mode has no automatic candidates or previous-card context. Explicit attachments remain discussable in every mode. Reuse previous cards only with recorded matching recipesMode provenance; legacy unproven cards remain visible without automatic request context. Clear previous suggestion cards on source changes and reject old-source reply cards after a mode change. Preserve the selected source when clearing conversation or opening Gemini from another tab, and show failed preference saves honestly. Clear the composer and persisted draft on send, restore retry text after errors, and never clear a newer draft when a reply arrives.
- Provider setup checks mean configured only; verify live access through an explicit small test search. Spoonacular complex-search matching ingredients come from extendedIngredients or the complete usedIngredients/missedIngredients union with fillIngredients=true, never unused inventory ingredients. Do not require the full inventory through includeIngredients; blank searches use one visible chosen ingredient. Report all-record parsing failures separately from genuine zero matches, and let users reveal filtered loaded results without another API request.
- Worker outbound calls must use inline `redirect: 'manual'` and inspect responses; workerd rejects `redirect: 'error'`. Use shared cache headers/Cloudflare cache controls rather than Request.cache so pasted dashboard code also works with older compatibility dates. Validate the built dashboard bundle with `npm run test:worker-runtime`; mocked Node fetch tests do not establish Worker compatibility.
- RecipeBrowser owns one source-scoped results pipeline. Local text filtering is live; API searches and paging are explicit source-named actions. Query/source/ingredient-input changes invalidate stale requests, while presentation filters apply to every loaded source. Personal collection filters are independent from availability: imported records exclude API-provider saves. Counts must describe filtered loaded records, never an external database total. Expiration ordering remains meaningful under alphabetical browsing. The browsing UI offers only Name and Most matches; Most matches counts distinct canonical ingredients in usable stock even when amounts are unknown or insufficient, with shortages shown separately. Availability controls are not shown. Category and cuisine are editable recipe metadata, reflected in filters.
- Recipe quantities scale from recorded original yield, never from guessed portions or nutrition targets. Show the original yield and multiplier, keep instruction text unchanged, and reject invalid target servings visibly before shopping/planning/consumption. Fewest-ingredients-short sorting counts missing and known quantity shortages; keep unknown amounts as separate review flags.
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

Parallel browser-test processes must use separate Playwright output directories so
one process cannot delete another process's active traces.

## Commands

- `npm run dev`: local interface.
- `npm run check`: lint, TypeScript, unit tests, production build.
- `npm run test:e2e`: browser workflows at narrow, unfolded, and desktop sizes.
- `npm run test:rules`: ownership/concurrency tests with the Firestore emulator.
- `npm run emulators`: local auth and Firestore; use demo project only.
- `npm run format`: format edited source; do not claim this is a test.

The GitHub workflow runs checks and uploads build artifacts when the repository is
connected; it does not deploy the private site. Avoid forced reloads, unnecessary
service workers, and destructive data migrations.

The private hosted copy uses Sites. Reuse the project ID in `.openai/hosting.json`
and apply the Sites skill for source synchronization and publication. Preserve its
private audience and website origin. Firebase deployment is a separate optional
delivery path; do not claim it is configured until its account settings exist.
