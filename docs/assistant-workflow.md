# Choosing a meal and getting groceries

Mise's primary assistant workflow is a conversation about what to cook, followed by a
real source recipe and an inventory-aware shopping list. Inventory is context for
avoiding duplicate purchases. It restricts recommendations only when requested.

The inventory chip in Gemini opens three choices: **All inventory**, **Choose
ingredients**, or **No inventory**. The searchable ingredient picker includes every
purchase of each chosen product, across storage locations. This preference controls
new chat requests, local candidate matching, and copied kitchen context. An empty
selection shares nothing; unshared ingredients are not reported as missing. Only All
inventory also includes kitchen tools. The choice survives navigation, reloads,
backup/restore, and clearing the conversation. Earlier messages may still mention
previously shared inventory; start a fresh conversation to remove that chat history.
Shopping list calculations continue to use the complete inventory.

## Discovery

The optional authenticated Worker conversation uses Gemini function calls to search
publisher pages and inspect their recipe data. Tavily requires `TAVILY_API_KEY` and
`TAVILY_PLAN=free`. Search uses the basic depth with automatic paid-depth selection
disabled. Each message allows at most two searches, four page inspections, and four
model turns. Provider quota failures stay visible; there is no automatic paid service.

Search returns short snippets and exact URLs. Page inspection fetches public HTTPS
pages using the existing DNS, redirect, size, and cancellation controls, then parses
complete Recipe JSON-LD outside the model. Only inspected originals and supplied local
recipe candidates can become recommendation cards. The model can reply conversationally
without recommending a recipe. Missing metadata, ambiguous yields, and unknown amounts
remain unknown.

Recipe records preserve source links, photographs where provided, authors, durations,
ratings and declared nutrition. These fields describe the source; they do not prove a
recipe was tested or is appropriate for a medical condition. Publisher nutrition is
displayed on its stated serving basis. Ingredient-based USDA review is optional.

This is on-demand personal discovery and import, not a redistributed catalog of
publisher recipes or photographs. A future shared/public catalog requires permissioned
content and appropriate photo licensing.

## Choosing and shopping

Opening a recipe shows original ingredients and steps. The user chooses servings when
the original yield is recorded. **Make shopping list** saves the original, adds the meal
to the plan, aggregates planned quantities, and subtracts compatible inventory supply.
It does not modify or consume inventory. Unknown quantities and incompatible units are
flagged for review rather than inferred.

Assistant suggestions, attachments, conversation text and the draft are saved with the
kitchen. They survive tab changes, reloads, and file backup/restore. Credentials remain
outside kitchen backups. Saved recipes are the default recipe collection; community
cookbook browsing and individual API providers remain optional.

## Reports and daily goals

Reading a body scan fills editable literal report fields, including ranges and units.
Measurements and recorded intake recommendations are separate. Daily goals require
explicit user review. Selected structured fields provide compact Gemini context;
original files are stored locally and are not re-uploaded during ordinary chat.

## Updating the two deployed parts

The private Sites frontend updates at the same address after publication. The separately
owned Cloudflare Worker needs its updated downloadable code pasted and deployed in
Cloudflare, preserving existing secrets. Older Workers continue conversation with an
upgrade notice; their missing tools are not represented as working web discovery.

Live publisher imports have been checked on Budget Bytes, RecipeTin Eats and
Spend With Pennies. Search orchestration is covered by mocked protocol and native
Worker tests; a user's live Gemini/Tavily search requires their configured accounts.
