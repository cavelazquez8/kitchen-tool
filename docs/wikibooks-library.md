# Wikibooks starter recipe collection

Mise bundles a structured snapshot of the English [Wikibooks Cookbook](https://en.wikibooks.org/wiki/Cookbook:Recipes). It requires no recipe-service account or subscription. The browser downloads the collection when opening Recipes, then searches and matches the complete collection locally. The existing TheMealDB integration provides additional online discovery.

The current snapshot includes **3,571 recipes from 3,796 Cookbook recipe pages**. It excludes 225 pages that are unfinished, have unsupported markup, use ingredient tables, contain unparsed ingredient prose, or require combining separate ingredient sections. The snapshot has 935 explicitly recorded serving yields; all other yields remain unknown. See [the generated ingestion report](wikibooks-ingestion-report.json) for the snapshot date, exclusion counts, and exact excluded titles. Category totals also include pages outside the Cookbook namespace, so Wikibooks' displayed category count is larger than the number of pages considered here.

Recipes are community-contributed source material, not recipes tested by Mise. Ingestion checks structure and preserves source instructions. It does not verify cooking quality. Source ambiguity remains visible through the original ingredient text, unknown amounts, and the application's ingredient-review flow.

## Attribution and licensing

The recipe text and its structured adaptation are licensed under **[Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/)**. Credit belongs to **Wikibooks contributors**. Every recipe retains a link to the exact source revision, the license identifier and URL, and a notice that text was adapted for Mise. Those fields must remain in recipe details, saved recipes, and exported backups. A source page's history identifies its contributors. [Wikimedia reuse terms](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use#7._Licensing_of_Content) explain attribution through page links and the requirements for adapted text.

The CC BY-SA license applies to this recipe collection and adaptations of its recipe text. It does not change the license of Mise's independent application code. The collection is a separate data artifact at `public/data/wikibooks-recipes.json`.

No Wikibooks photographs are included: media have individual licenses and attribution requirements. Recipe text links are displayed as plain text during cooking, while the source link provides the original page, equipment, notes, and references.

Adaptations include removing wiki markup and references from cooking steps, expanding a small whitelist of explicit fraction/unit templates, separating instructions into steps, and normalizing ingredient names for matching. The original readable ingredient line is preserved. Alternative units are removed only from matching names when the parenthetical text contains recognizable measurements; quantities are never converted or invented during ingestion. Ranges, approximations, alternatives, and compound measures stay unknown. Exact serving yields are read only from source recipe-summary fields; ranges and yields in loaves or pieces are not treated as servings.

## Updating the snapshot

Use the repository's required Node version and installed dependencies:

```sh
node scripts/update-recipe-library.mjs
npx vitest run src/recipes/wikibooks.test.ts src/recipes/library.test.ts
```

The script reads `Category:Recipes` through the public MediaWiki API, filters to Cookbook pages, and requests current revision content in batches of 50. Requests run sequentially with `maxlag=5`, a short pause, bounded retries, and an identifying user agent. API failures abort the update before replacing the previous collection. Ordinary production builds use the committed snapshot and do not contact Wikimedia.

For parser development, optionally preserve a source snapshot outside the repository, then regenerate repeatedly without making further API requests:

```sh
node scripts/update-recipe-library.mjs --raw-cache /tmp/mise-wikibooks-source.json
node scripts/update-recipe-library.mjs --from-cache /tmp/mise-wikibooks-source.json
```

After an update, review the report and spot-check common recipes, fractions, unknown quantities, yields, and matching names. Commit the parser, generated data, updated report, and documentation together. The full collection is about 6.7 MB of JSON, or 1.4 MB compressed, and is loaded separately from the application's initial JavaScript bundle.

API references: [category members](https://www.mediawiki.org/wiki/API:Categorymembers), [revisions](https://www.mediawiki.org/wiki/API:Revisions), [API etiquette](https://www.mediawiki.org/wiki/API:Etiquette).
