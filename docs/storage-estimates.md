# Storage-life suggestions: proposed next step

This is a design proposal, not a feature currently shipped in Mise.

Use reviewed storage guidance to suggest an editable **use-soon estimate** during scan
review. A barcode identifies a product; it does not establish its actual remaining life.
Match the confirmed food identity/category, storage location and condition (for example
raw, cooked, opened or unopened). If that match is uncertain, leave the estimate blank.
The reference is USDA’s [FoodKeeper](https://www.foodsafety.gov/keep-food-safe/foodkeeper-app).

Keep estimated dates distinct from dates entered from a package. Record the estimate’s
source, stated range, food condition, storage location and reference date. Package
instructions and a date the user enters take precedence. A suggestion can be accepted,
edited or ignored without slowing down the next scan.

Purchase, opening, cooking and freezing can be different reference events. Moving food
to another location must not silently reset its age; location changes should prompt a
review of estimates while preserving explicit dates. Freezer guidance often concerns
quality, as explained by USDA’s [Freezing and Food Safety](https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation/food-safety-basics/freezing-and-food-safety).
Do not label an estimated quality date as a guaranteed safe-until date.

Begin with a small verified set of common food categories and storage states. Expand
coverage when sources can be mapped reliably. Keep manual dates available at all times;
unknown dates remain unknown and sort after dated stock. No paid API is required for a
curated reference table, subject to verifying the dataset’s reuse terms before ingestion.
