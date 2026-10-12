# Optional free recipe sources

Mise always keeps its built-in Wikibooks collection, your saved recipes, and TheMealDB searches available without another account. The additional sources below are optional, searched only when you request them, and use your existing authenticated Cloudflare Worker. API keys never go into the browser, Git, local inventory, or backups.

## RecipeAPI.io: recommended for personal use

1. Create an account at <https://recipeapi.io/register>. Select the **Free** plan, with no payment card. Do not start a paid-plan trial.
2. Generate a key in the provider dashboard.
3. Open your existing `mise-gemini` Worker in Cloudflare. Add a **Secret** named `RECIPEAPI_API_KEY` containing that key.
4. Add a **Text** variable named `RECIPEAPI_PLAN` with the value `free`.
5. In Mise settings, download the current `mise-gemini-worker.js`. Replace the Worker's code with that file and deploy. Keep your existing Gemini key, pairing token, allowed origin, and model variables.
6. Check the additional sources in Mise settings. **Configured** means the Worker has a key and free-plan setting; this check does not contact the provider. Press **Test search** beside a configured source to verify a small live search. In Recipes, choose RecipeAPI.io in **Recipe source** and press **Search RecipeAPI.io**.

The documented free allowance is **500 requests per calendar month**, with up to **10 full recipes per request**. Mise sends one request per explicit search/page, with no hidden detail requests, automatic retries, paid scaling, imperial conversion, or translations. Metric quantities are converted locally when compatible units are known.

Selected recipes can be saved in this private personal library with their source attribution. This is access under the provider's personal/non-commercial license, not ownership of its database. Do not bulk redistribute the data or use this free integration in a commercial app. Review the current terms if your account is terminated or the app's purpose changes.

Official references checked October 12, 2026:

- <https://recipeapi.io/docs/api-reference/>
- <https://recipeapi.io/docs/resources/recipes/>
- <https://recipeapi.io/legal/terms-of-service>

## Spoonacular: online discovery only

1. Register directly at <https://spoonacular.com/food-api/console#Dashboard> and choose its **Free** plan, with no card. Avoid RapidAPI, whose plans can permit overage charges.
2. Add the API key as a Cloudflare **Secret** named `SPOONACULAR_API_KEY`.
3. Add a **Text** variable named `SPOONACULAR_PLAN` with the value `free`.
4. Deploy the updated Worker as above.

The direct free plan permits **50 points per day**, then refuses further calls. Mise uses one complex-search request per search/page; ingredient matching data, recipe information, and instructions cost up to **1.85 points for 10 results** at the documented rate. API-reported usage is also checked before later calls.

For a blank Spoonacular search, choose **Start with ingredient** from your inventory. The search requires that ingredient, then Mise compares every returned recipe with your full selected inventory. Sending the entire inventory as required ingredients would exclude recipes that use only some of what you have. RecipeAPI.io supports matching any of the supplied inventory ingredients, so its blank search can use them all.

Spoonacular permits caching user-requested data for only **one hour** and requires deletion if access stops. Mise therefore treats these results as temporary online discovery: open the original recipe source to use it. They cannot be saved, placed in meal plans, copied into Gemini context, or included in inventory backups. Keep the “Powered by Spoonacular” link visible with results.

Official references checked October 12, 2026:

- <https://spoonacular.com/food-api/pricing>
- <https://spoonacular.com/food-api/docs#Search-Recipes-Complex>

## Limits and verification

Mise applies additional monthly/daily, simultaneous-request, rate, timeout, and response-size limits. Local counters are **best effort per Worker isolate** and reset when an isolate is replaced; the providers' free-plan accounts enforce their global allowances. Setting `*_PLAN=free` is an explicit declaration that your actual provider account is on its free plan. The Worker cannot inspect your subscription, cancel a paid account, or disable billing for you.

Provider setup does not alter inventory or Gemini. Existing deployed Workers continue to support Gemini, but need the updated code before these optional endpoints work. Misconfigured keys and exhausted free allowances produce readable errors without retries or paid fallbacks. Live provider access requires your own configured account; automated tests use clearly synthetic fixtures and do not establish live API reliability.

Search distinguishes no upstream matches, unreadable recipe details, request failures, and recipes hidden by your filters. **Show all loaded recipes** removes presentation filters without making another API request or changing the inventory used for the comparison. A successful connection test verifies that search at that moment; it does not guarantee results for every query.

If both sources fail with “could not be reached,” deploy the newest Worker code. Earlier bundles used `redirect: 'error'`, which Cloudflare's runtime rejects before an API request is sent. The current bundle uses manual redirects and cache controls that also work on older dashboard compatibility dates. Website imports share this fix. Recipe pages still need readable published recipe data; pages that block automated requests or omit ingredients/steps use the existing paste or media fallback.
