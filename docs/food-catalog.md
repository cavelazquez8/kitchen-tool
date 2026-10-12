# Food suggestions

Mise combines recent inventory labels, its small original generic/branded catalog, and a separately licensed snapshot of English Open Food Facts ingredient taxonomy names. The large index is loaded only when an item/ingredient picker needs it, cached locally after a successful download, and searched entirely on the device. Suggestions never assert package quantity, substitution suitability, nutrition, or verified product identity.

Source: https://static.openfoodfacts.org/data/taxonomies/ingredients.json

Attribution: Open Food Facts contributors. Adapted English ingredient name index under Open Database License 1.0 (ODbL), with individual contents under Database Contents License 1.0. No product images are copied. Source URL, snapshot date, source checksum, license links, and attribution are retained in the downloadable `public/data/food-ingredients.json` index.

- ODbL: https://opendatacommons.org/licenses/odbl/1-0/
- Database Contents License: https://opendatacommons.org/licenses/dbcl/1-0/
- Official reuse guidance: https://openfoodfacts.github.io/documentation/docs/Product-Opener/api/tutorials/license-be-on-the-legal-side/

Update deliberately with `node scripts/update-food-catalog.mjs`. For reproducible ingestion from a saved upstream snapshot, pass its JSON path as the first argument. Ordinary application builds never fetch third-party catalog data.

Packaged-product searches are explicit requests to Open Food Facts, bounded to 12 results, debounced by an action cooldown, and cached. They do not run while typing. Only the search text is sent. The selected product can fill a display name and brand; the user still records quantity and confirms the ingredient name.
