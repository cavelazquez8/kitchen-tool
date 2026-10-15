# Connect Mise to free Gemini

Mise saves kitchen data in your browser. No Firebase account or database is needed.
The optional Cloudflare Worker sends Gemini requests without exposing your Google API
key. Its personal access token pairs one browser with your Worker. File backups contain
kitchen data, not either secret; pair another device separately after restoring a backup.

## Keep both services free

1. In [Google AI Studio](https://aistudio.google.com/api-keys), select the Mise project.
   Confirm the project remains on the Free tier and has **no linked billing account**.
   Use its API key only as the Worker's `GEMINI_API_KEY` secret. Do not enter it in Mise,
   a chat message, a source file, or a client environment variable.
2. Keep Cloudflare **Workers Free**. This Worker uses its included `workers.dev` address;
   it does not provision paid storage, AI gateways, search, or a custom domain.
3. Gemini API free access is separate from your consumer Gemini subscription. Availability
   and quotas depend on the project and can change. Google permits product-improvement
   use of unpaid API submissions; send only content you are comfortable submitting.

The default model is `gemini-3.5-flash-lite`. Its text/image/video/audio inputs and text
outputs are listed as free on Google's pricing page, checked October 10, 2026. The other
reviewed choices are `gemini-3.1-flash-lite` and `gemini-3.8-flash`. These built-in choices
remain available when discovery cannot be reached. Mise also discovers newer models
using Google's live catalog and official pricing; it never selects them automatically.
A reviewed model name does **not** detect or disable Google project billing: keep billing
unlinked. A free-tier price describes Google's Free tier, not a promise that requests
will be free when your Google project is connected to a billing account.

## Build and deploy from this project

Use Node 24 or newer. From `kitchen-wrapper/server`:

```sh
npm ci
npm run build
npm run login
npm run deploy
```

`build` bundles locally without deploying or spending Gemini quota. `login` opens
Cloudflare's authorization flow in your browser. `deploy` uploads only the AI backend
and prints its `https://mise-gemini.<your-subdomain>.workers.dev` address. Keep the Mise
interface on its existing hosting address.

For deployment through Cloudflare's dashboard instead: run `npm run build`, create a
Worker named `mise-gemini` on Workers Free, and paste the complete bundled module from
`server/dist/index.js` into its editor. Save/deploy, then add the settings below. Do not
paste the unbundled TypeScript source; it imports a shared validation module.

## Add the Worker settings

In **Workers & Pages → mise-gemini → Settings → Variables and Secrets**, add:

| Name                | Type   | Value                                                                  |
| ------------------- | ------ | ---------------------------------------------------------------------- |
| `GEMINI_API_KEY`    | Secret | Your Google AI Studio key                                              |
| `MISE_ACCESS_TOKEN` | Secret | A new random pairing token, generated in Mise's AI connection settings |
| `ALLOWED_ORIGIN`    | Text   | `https://mise-kitchen-cv8.expertroot3.chatgpt.site`                    |
| `GEMINI_MODEL`      | Text   | `gemini-3.5-flash-lite`                                                |

The origin is the exact interface address, with no trailing slash or path. Wrangler
already sets the two text values from `server/wrangler.jsonc`; set them explicitly when
using the dashboard. Save/deploy the settings. The Worker refuses AI requests until both
secrets are present and the access token is sufficiently strong.

If using the CLI for secrets, these commands prompt privately for each value:

```sh
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put MISE_ACCESS_TOKEN
```

Keep secret values out of command arguments, shell history, Git, screenshots and this
conversation. Both keys can be rotated later. Changing `MISE_ACCESS_TOKEN` disconnects
previously paired browsers until you enter the new token in each one.

## Pair Mise

1. Open Mise's AI connection settings.
2. Generate a personal access token and store the same value in the Worker's
   `MISE_ACCESS_TOKEN` secret. This token is separate from your Google API key.
3. Enter the Worker base URL and that personal access token in Mise; save and test.
4. A successful connection test confirms the Worker address, origin, settings and pairing.
   It makes no Gemini generation request. A newly discovered selection also checks
   Google's catalog and pricing, but neither check establishes that generation quota
   is available or that your project has billing disabled.
5. Send one short cooking question to verify Gemini itself. Errors explain a missing or
   rejected key, unavailable model, quota exhaustion, or network failure.

For an existing Worker, download the latest `mise-gemini-worker.js` from Mise settings,
replace the complete code in Cloudflare's editor, and deploy. Keep the existing secrets
and allowed origin. New recipe recommendations and nutrition report extraction need
this updated code; profile PDF reading and choosing a Gemini model inside Mise also
need the updated Worker. Automatic model discovery needs one more replacement with
the current bundle; future supported free releases then appear without replacing code
for each model. A successful health check alone does not verify Gemini generation access.

## Optional recipe discovery inside the conversation

The assistant can search for real publisher recipes, inspect their original ingredients
and instructions, and show source-linked cards with the publisher's available photograph,
time and serving information. Inventory helps avoid duplicate purchases; it does not
force every recommendation to use only what you own. Ordinary cooking questions do not
require a search or a generated recipe.

This uses a separate [Tavily Free account](https://app.tavily.com/), currently including
1,000 monthly credits without a payment card. Keep paid usage disabled: do not enable
pay-as-you-go or attach a paid search account. Free quotas and provider plans can change.

1. Replace the Worker code with the latest `mise-gemini-worker.js` download and deploy,
   keeping the existing Google key, pairing token and allowed origin.
2. In Cloudflare's Worker settings, add secret `TAVILY_API_KEY` with the free-account key,
   and text variable `TAVILY_PLAN` with the exact value `free`.
3. Deploy the settings, then use **Check connection** in Mise. Recipe discovery is
   reported as configured separately from Gemini. The check makes no search and does
   not establish live search quota; a normal meal request verifies the actual service.

The assistant still works without a search key: it can discuss cooking and attached or
saved recipes, and try a user-provided publisher link. It explains when live discovery
is unavailable instead of pretending it searched. Google Search grounding is not enabled
as a paid fallback. Search requests contain a focused model-chosen dish/meal query, not
an automatically copied inventory or body report. Search snippets and publisher pages
are untrusted input and cannot change inventory or profile fields.

Each user message allows at most two basic searches (one credit each), four publisher
page inspections, and four Gemini generation calls. Retrieved page ingredients and
instructions are parsed independently of Gemini; search snippets alone cannot become
a recipe card. Gemini can recommend only provided saved-recipe IDs or verified fetched
IDs. Failed, blocked or unsupported pages stay failures, not fabricated recipes. This
is an on-demand personal importer, not a bulk recipe redistribution service. It preserves
original source attribution and does not add recipes to your saved collection until you
choose to save them.

Tool turns count toward the same Gemini limits as ordinary requests. Page reads are
bounded and concurrent, and the complete research turn times out after 110 seconds;
the browser waits at most 125 seconds. Google errors identify the selected model and
HTTP status, with bounded diagnostics for rejected requests. Mise never silently switches
models or enables paid billing. Failed requests keep your conversation and saved data.

References: [Tavily search API](https://docs.tavily.com/documentation/api-reference/endpoint/search),
[Tavily pricing](https://www.tavily.com/pricing),
[Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling).

## Model selection

The optional model selector stores a preference in this browser. **Worker default**
uses the Worker's `GEMINI_MODEL` setting, or Mise's default. A selected model accompanies
each Gemini request and never changes the Worker globally. The built-in choices are
`gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` and `gemini-3.8-flash`. For discovered
choices, Mise requires an explicit review and save before sending requests. Google must
list the exact model ID with `generateContent` support, and its
[Standard pricing table](https://ai.google.dev/gemini-api/docs/pricing) must list free
input **and** output for that exact ID. Specialized voice, image-generation and embedding
models are excluded from cooking chat. Paid-only models and models with missing or
unreadable pricing remain disabled. Model aliases do not inherit another model's price.

The authenticated `/models` endpoint checks Google's paginated model catalog and public
English pricing page. It sends the Google key only to Google's API, never to the pricing
website or browser, and makes no generation request. Results are cached for up to one
hour in each Worker isolate and are separated by API key. **Refresh models** checks
both sources again. If fresh pricing cannot be checked, new models cannot be authorized
using stale verification. Metadata checks have a separate best-effort limit of ten per
minute per isolate; they do not consume Mise's generation counters. Google's own access
and quota limits still apply.

Availability, pricing and quotas can change; discovery does not establish your account's
billing status. Keep billing disabled. Mise does not fall back to an unselected or
paid-only model. The Worker default remains a built-in model; choose newly discovered
models through Mise's selector rather than setting an unreviewed environment default.

The pairing token is saved only in this browser's separate connection settings. It is a
credential: protect it and use **Disconnect** on shared devices. Mise does not include
it in inventory exports or backups. The browser never receives the Google API key.

## Limits and imports

- Requests require the exact allowed origin plus the personal bearer token. Origin
  checking alone is not authentication; the private token supplies authentication.
- Each Worker isolate allows up to 6 AI requests/minute, 100/day and 2 simultaneously.
  These are best-effort limits, **not a globally persistent quota**: Cloudflare can create
  or restart isolates. Google's own free-project quota remains the final limit. Leave
  Google billing disabled rather than relying on these counters to prevent charges.
- An upstream quota error pauses that isolate for at least 60 seconds. Mise never retries
  with a paid model; inventory and recipe matching continue locally, and copying context
  to the consumer Gemini website remains available.
- Recipe extraction accepts pasted text or a JPG, PNG, WebP, MP4 or WebM file under 1 MB.
  Use a short clip or cropped screenshots. The Worker forwards content inline to Gemini;
  it does not create persistent Cloudflare storage or a Gemini Files API upload. Free
  Workers have a 10 ms CPU budget; large media or complex pages can exceed it even below
  the file-size cap. Prefer smaller/cropped images or clips and inspect Cloudflare's
  `Exceeded CPU Time Limits` error if requests fail. Live free-plan media performance
  must be verified after deployment; no paid plan is enabled as a fallback.
- **Website link import** uses the authenticated `/import` endpoint. It fetches a public
  HTTPS recipe page, reads embedded Recipe JSON-LD, and retains ingredients and steps
  for review without making a Gemini generation request. It checks DNS addresses and
  each redirect, limits downloads to 2 MB, and times out after 15 seconds. No credentials
  or cookies are sent to recipe websites. Login-only/social/dynamic pages may require
  pasted text or media instead.
- **Gemini extraction** uses `/extract`: its optional source link is attribution only;
  that endpoint receives actual text/image/video content and does not fetch the link.
  Unknown quantities remain unknown and results need review before saving.
- Website imports have their own per-isolate request counters, separate from Gemini
  calls. DNS checks reduce obvious private-network requests but do not pin an IP during
  the subsequent HTTPS fetch. This is a private personal importer, not a general public
  URL proxy; keep its access token private.
- Gemini chat sends the selected inventory/context and recent history on each request.
  Generated content cannot directly edit inventory. Mise performs its own quantity math.
  The combined JSON request has a shared 512 KB UTF-8 limit checked by both Mise and
  the Worker; large report text can require removing an attachment or older messages.
- **Recipe-first recommendations** send a small locally retrieved set of real recipes,
  with their recorded ingredients, yields and inventory gaps. Gemini can ask preference
  questions and select up to three of those recipes. The Worker and browser validate
  the returned IDs; generated replacements and unknown IDs are rejected. Mise opens
  the original recipe and retains its attribution. This does not send the entire
  cookbook or run an unrestricted web search, and Spoonacular discovery is excluded.
- Optional reviewed daily nutrition targets accompany cooking questions and recipe
  recommendations. Targets are daily goals; recipe figures are estimated per serving.
  Missing nutrition, unreviewed ingredient weights or unknown yields stay unknown.
- **Nutrition report extraction** uses `/nutrition/extract` with pasted text or a JPG,
  PNG or WebP image under 1 MB. It extracts explicitly recommended daily calories and
  macros for review, preserving absent or ambiguous values as unknown. It does not
  prescribe targets from body measurements, BMI or basal metabolic rate. This consumes
  the same Gemini allowance as chat and never applies goals automatically.
  [USDA nutrition setup](nutrition-setup.md) is separate and optional.
- **Profile report reading** uses `/profile/extract` with pasted text or a PDF, JPG,
  PNG or WebP file up to 4 MB. PDFs are sent to Gemini as native inline document data,
  following Google's [document processing guide](https://ai.google.dev/gemini-api/docs/generate-content/document-processing).
  The result preserves readable labels, measurements, units, ranges and notes for
  review, plus an unambiguous scan date when present. Literal measurements and explicit
  recommendations also populate editable label/value fields, preserving source units
  and ranges. Recommended ranges do not become invented midpoint targets. BMR and energy
  expenditure are measurements, not daily calorie recommendations. The original
  file stays in this browser's profile storage; reading it sends its contents to
  Gemini once and consumes the same AI allowance as chat. It creates no persistent
  Worker storage or Gemini Files API upload. Larger files can exceed a free Worker's
  CPU budget; a smaller picture or pasted report text remains available.
- Saving a profile report does not automatically send it in cooking conversations.
  **Add to Gemini** adds only the selected reviewed report text to chat context,
  within a 24,000-character total limit. Raw files and other saved reports are not
  attached. Attached reports remain reference data; approved daily nutrition targets
  are separate. Removed report context is omitted from subsequent requests, while
  older chat messages may still mention it until the conversation is cleared.

## Local development

Copy `server/.dev.vars.example` to ignored `server/.dev.vars` and fill values privately.
Set `ALLOWED_ORIGIN` to `http://localhost:5173`, then run `npm run dev` in `server`.
Pair the interface with `http://localhost:8787`. Do not commit `.dev.vars`; do not use real
credentials in automated tests. Change the origin back to the hosted address before
production deployment.

## Official references

- [Gemini pricing and free availability](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini model listing and capabilities](https://ai.google.dev/api/models)
- [Gemini billing and projects](https://ai.google.dev/gemini-api/docs/billing)
- [API key security](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini generateContent REST reference](https://ai.google.dev/api/generate-content)
- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Gemini video input](https://ai.google.dev/gemini-api/docs/video-understanding)
- [Gemini unpaid-service data terms](https://ai.google.dev/gemini-api/terms)
- [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare CLI deployment](https://developers.cloudflare.com/workers/get-started/guide/)
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare free resource limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Recipe structured data](https://schema.org/Recipe)
