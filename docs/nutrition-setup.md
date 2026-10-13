# Optional USDA nutrition estimates

Daily nutrition goals are optional and entered or reviewed by you. Mise does not derive recommended intake from body fat, weight, or other body measurements. A report or pasted recommendation can supply the values for review; blank fields remain unknown. Goals mean **per day**, while a recipe estimate means the original recipe or one recorded serving.

## Connect the free food database

1. Get a free data.gov key at [USDA FoodData Central API key signup](https://fdc.nal.usda.gov/api-key-signup/). No paid plan is needed.
2. In your existing Cloudflare Worker, add a **Secret** named `USDA_API_KEY` with that key. Keep it out of the browser, Git, and backups.
3. Download the current `mise-gemini-worker.js` from Mise settings. Replace your Worker's code and deploy, retaining your existing Gemini key, pairing token, allowed origin, and provider configuration.
4. Open a recipe and choose **Estimate with USDA**. **USDA key configured** checks only the secret's presence. Choose **Test USDA lookup** to run one small search for carrots and see whether live access works; this does not select an ingredient match or change your recipe. A normal ingredient search also verifies live access.

The normal API allowance is 1,000 requests per hour per IP address. USDA's `DEMO_KEY` is an exploration key with only 30 requests per hour and 50 per day; Mise requires your own key. Mise sends one request per explicit search or food selection, with no automatic retry or paid fallback. Its additional rate limits are best effort per Worker isolate; USDA enforces the actual account/IP limits. Missing setup leaves your inventory, recipes, and manually entered goals available.

## Review each ingredient match

Choose the USDA food matching the ingredient's actual form: for example, raw chicken and cooked chicken or dry rice and cooked rice have different nutrient amounts. Confirm the **total edible grams in the original recipe**. Recorded portions can help when their description matches what you used; a generic cup or a count is not automatically converted to grams.

USDA supplies nutrient amounts per 100 grams. Mise multiplies these by confirmed edible weight and divides the complete recipe by its **recorded yield** for a serving estimate. Brand label values per serving are never mistaken for per-100-gram data. Foundation foods' Atwater energy fields are supported alongside legacy energy fields. Nutrients absent from the source remain unknown.

An unreviewed ingredient or missing nutrient prevents a complete total for that nutrient. Partial subtotals are identified as partial. An unknown recipe yield prevents a per-serving estimate. Editing the ingredient list, amounts, or yield invalidates old matches so that you can review them again. These are estimates from the selected records and do not account automatically for cooking losses, drained liquids, or edible versus discarded portions.

FoodData Central records are public domain under CC0; confirmed source records may be kept locally and in backups with their FDC IDs and source links. Recipe content retains its own attribution and license. Nutrition lookup is optional and does not increase recipe-provider allowances or enable synchronization.

Official references checked October 13, 2026:

- [USDA API guide, key responsibility, limits, and licensing](https://fdc.nal.usda.gov/api-guide/)
- [USDA API specification](https://fdc.nal.usda.gov/api-spec/fdc_api.html)
- [Foundation food energy fields, edible weights, and portion calculation](https://fdc.nal.usda.gov/Foundation_Foods_Documentation/)

Automated tests use synthetic food data. Live access requires your own USDA key and has not been established by those tests.
