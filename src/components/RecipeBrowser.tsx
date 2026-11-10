import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  ExternalLink,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { InventoryState } from '../domain/types';
import type { Recipe } from '../recipes/types';
import type { RecipeMatch } from '../recipes/matching';
import {
  browseRecipes,
  dedupeRecipes,
  recipeSourceName,
  requestScopeKey,
  selectRecipeCollection,
  recipeCollectionLabel,
  type RecipeCollection,
  type BrowseOrder,
  type BrowseSource,
} from '../recipes/browse';
import { canonicalIngredientName } from '../recipes/identity';
import { loadLocalRecipes, recipeFacets } from '../recipes/localLibrary';
import { discoverRecipes, searchRecipes } from '../recipes/library';
import { searchRecipeProviders } from '../recipes/providerClient';
import { RECIPE_PROVIDER_INFO, type RecipeProviderSearch } from '../recipes/providers';
import { readGeminiConnection } from '../ai/client';
import { Choice } from './Choice';
import { MatchBadge } from './MatchBadge';
import { Modal } from './Modal';
import './recipeProviders.css';
import './recipeBrowser.css';

const PAGE_SIZE = 24;
type OnlineSource = Exclude<BrowseSource, 'library'>;
type SourceResults = {
  source: OnlineSource;
  scope: string;
  recipes: Recipe[];
  page: number;
  hasMore: boolean;
  search?: RecipeProviderSearch;
  expiresAt?: number;
  warnings: string[];
};
const sourceLabels = {
  themealdb: 'TheMealDB',
  wikibooks: 'Wikibooks Cookbook',
  imported: 'Imported',
  ai: 'AI-created',
  manual: 'Your recipe',
};
function safeLink(value?: string) {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function availabilitySummary(match: RecipeMatch, showMatches: boolean): string {
  if (showMatches) {
    const matches = `${match.onHandCount} matching ingredient${match.onHandCount === 1 ? '' : 's'}`;
    const short = `${match.missingCount} short`;
    return `${matches} · ${short}${match.uncertainCount ? ` · ${match.uncertainCount} amount${match.uncertainCount === 1 ? '' : 's'} to check` : ''}`;
  }
  const count = match.missingCount || match.matchedCount;
  const summary = `${count} ingredient${count === 1 ? '' : 's'} ${
    match.missingCount ? 'short' : 'on hand'
  }`;
  return match.uncertainCount
    ? `${summary} · ${match.uncertainCount} amount${match.uncertainCount === 1 ? '' : 's'} to check`
    : summary;
}
function RecipeCard({
  match,
  saved,
  onOpen,
  onSave,
  onAddToGemini,
  inGeminiContext,
  onRemoveSaved,
  showMatches,
}: {
  match: RecipeMatch;
  saved: boolean;
  onOpen: () => void;
  onSave: () => void;
  onAddToGemini: () => void;
  inGeminiContext: boolean;
  onRemoveSaved?: () => void;
  showMatches: boolean;
}) {
  const recipe = match.recipe;
  return (
    <article className="recipe-card">
      {safeLink(recipe.imageUrl) && <img src={recipe.imageUrl} alt="" loading="lazy" />}
      <div className="recipe-card-body">
        <MatchBadge match={match} />
        <button className="recipe-title" onClick={onOpen}>
          <h3>{recipe.title}</h3>
        </button>
        <p>{availabilitySummary(match, showMatches)}</p>
        <small>
          {recipe.source.name ?? sourceLabels[recipe.source.type]}
          {recipe.category ? ` · ${recipe.category}` : ''}
          {recipe.servings ? ` · ${recipe.servings} servings` : ' · Yield not recorded'}
        </small>
        <div className="hub-actions">
          <button className="button secondary" onClick={onOpen}>
            View recipe
          </button>
          <button
            className="icon-button"
            aria-label={saved ? `${recipe.title} saved` : `Save ${recipe.title}`}
            disabled={saved}
            onClick={onSave}
          >
            {saved ? <Check size={18} /> : <Plus size={18} />}
          </button>
        </div>
        <div className="recipe-card-secondary-actions">
          <button className="text-button" disabled={inGeminiContext} onClick={onAddToGemini}>
            <Sparkles size={15} /> {inGeminiContext ? 'Added to Gemini' : 'Add to Gemini'}
          </button>
          {onRemoveSaved && (
            <button
              className="icon-button"
              aria-label={`Remove ${recipe.title} from saved recipes`}
              onClick={onRemoveSaved}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function RecipeBrowser({
  inventory,
  relevant,
  selectedBatchIds,
  useSelection,
  onUseSelectionChange,
  onOpen,
  onSave,
  onRemoveSaved,
  onAddToGemini,
  geminiRecipeIds,
  onImport,
  onNew,
  onConfigure,
  savedReveal,
  onSavedRevealHandled,
}: {
  inventory: InventoryState;
  relevant: InventoryState;
  selectedBatchIds: readonly string[];
  useSelection: boolean;
  onUseSelectionChange: (enabled: boolean) => void;
  onOpen: (recipe: Recipe) => void;
  onSave: (recipe: Recipe) => void;
  onRemoveSaved: (recipe: Recipe) => void;
  onAddToGemini: (recipe: Recipe) => void;
  geminiRecipeIds: readonly string[];
  onImport: () => void;
  onNew: () => void;
  onConfigure: () => void;
  savedReveal: Recipe | null;
  onSavedRevealHandled: () => void;
}) {
  const [source, setSource] = useState<BrowseSource>('library');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [cuisine, setCuisine] = useState('');
  const [collection, setCollection] = useState<RecipeCollection>('saved');
  const [order, setOrder] = useState<BrowseOrder>('browse');
  const [prioritize, setPrioritize] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [local, setLocal] = useState<Recipe[]>([]);
  const [localBusy, setLocalBusy] = useState(true);
  const [localError, setLocalError] = useState('');
  const [online, setOnline] = useState<SourceResults | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [startIngredient, setStartIngredient] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const localRequest = useRef(0);
  const operation = useRef<{ scope: string; controller: AbortController } | null>(null);
  const saved = useMemo(() => inventory.recipes ?? [], [inventory.recipes]);
  const ingredients = useMemo(() => {
    const active = new Set(
      relevant.batches
        .filter((batch) => batch.quantity !== 0 && batch.stapleStatus !== 'empty')
        .map((batch) => batch.productId),
    );
    return [
      ...new Set(
        relevant.products
          .filter((product) => active.has(product.id) && !product.isStaple)
          .map((product) => canonicalIngredientName(product.ingredientName ?? product.name))
          .filter(Boolean),
      ),
    ]
      .sort()
      .slice(0, 60);
  }, [relevant]);
  const spoonacularIngredient = ingredients.includes(startIngredient)
    ? startIngredient
    : (ingredients[0] ?? '');
  const searchIngredients =
    source === 'spoonacular' ? (spoonacularIngredient ? [spoonacularIngredient] : []) : ingredients;
  const scope = requestScopeKey(source, query, query.trim() ? [] : searchIngredients);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const results = online?.scope === scope && online.source === source ? online : null;
  const rawRecipes = useMemo(
    () =>
      source === 'library'
        ? dedupeRecipes(local, saved)
        : dedupeRecipes(
            results?.recipes ?? [],
            saved.filter((recipe) => results?.recipes.some((item) => item.id === recipe.id)),
          ),
    [source, local, saved, results],
  );
  const collectionRecipes = useMemo(
    () =>
      selectRecipeCollection(
        rawRecipes,
        collection,
        saved.map((recipe) => recipe.id),
      ),
    [rawRecipes, collection, saved],
  );
  const facets = useMemo(() => recipeFacets(collectionRecipes), [collectionRecipes]);
  const matches = useMemo(
    () =>
      browseRecipes(collectionRecipes, relevant, {
        query: source === 'library' ? query : '',
        category,
        cuisine,
        order,
        prioritizeExpiration: prioritize,
        savedIds: saved.map((recipe) => recipe.id),
      }),
    [source, collectionRecipes, relevant, query, category, cuisine, order, prioritize, saved],
  );
  const sourceName = recipeSourceName(source);
  const provider = RECIPE_PROVIDER_INFO.find((item) => item.id === source);
  const resetOnline = useCallback(() => {
    operation.current?.controller.abort();
    operation.current = null;
    setOnlineBusy(false);
    setOnlineError('');
    setOnline(null);
  }, []);
  const openCookbook = useCallback(async () => {
    const request = ++localRequest.current;
    setLocalBusy(true);
    setLocalError('');
    try {
      const recipes = await loadLocalRecipes();
      if (request === localRequest.current) setLocal(recipes);
    } catch (error) {
      if (request === localRequest.current)
        setLocalError(error instanceof Error ? error.message : 'Could not open your cookbook.');
    } finally {
      if (request === localRequest.current) setLocalBusy(false);
    }
  }, []);
  const stopLoads = useCallback(() => {
    localRequest.current++;
    operation.current?.controller.abort();
    operation.current = null;
  }, []);
  useEffect(() => {
    void openCookbook();
    return stopLoads;
  }, [openCookbook, stopLoads]);
  useEffect(() => {
    if (operation.current && operation.current.scope !== scope) {
      operation.current.controller.abort();
      operation.current = null;
      setOnlineBusy(false);
    }
    setOnline((current) => (current?.scope === scope ? current : null));
  }, [scope]);
  useEffect(() => {
    if (!results?.expiresAt) return;
    const expire = () => {
      if (results.expiresAt! <= Date.now()) resetOnline();
    };
    const timeout = window.setTimeout(expire, Math.max(0, results.expiresAt - Date.now()));
    document.addEventListener('visibilitychange', expire);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener('visibilitychange', expire);
    };
  }, [results, resetOnline]);
  useEffect(() => {
    if (!savedReveal) return;
    // Saving an online result keeps its search and page; new personal imports reveal the saved library.
    if (source === 'library' || !savedReveal.id.startsWith(`${source}:`)) {
      resetOnline();
      setSource('library');
      setCollection('saved');
      setQuery('');
      setCategory('');
      setCuisine('');
      setVisibleCount(PAGE_SIZE);
    }
    onSavedRevealHandled();
  }, [savedReveal, source, resetOnline, onSavedRevealHandled]);
  function changeSource(next: BrowseSource) {
    resetOnline();
    setSource(next);
    if (next !== 'library') {
      setCollection('all');
    }
    setCategory('');
    setCuisine('');
    setVisibleCount(PAGE_SIZE);
  }
  function changeCollection(next: RecipeCollection) {
    if (next !== 'all' && source !== 'library') changeSource('library');
    setCollection(next);
    setCategory('');
    setCuisine('');
    setVisibleCount(PAGE_SIZE);
  }
  function changeQuery(next: string) {
    if (requestScopeKey(source, next, next.trim() ? [] : searchIngredients) !== scope)
      resetOnline();
    setQuery(next);
    setVisibleCount(PAGE_SIZE);
  }
  function clearFilters() {
    setCategory('');
    setCuisine('');
    setCollection('all');
    setPrioritize(false);
    onUseSelectionChange(false);
    setVisibleCount(PAGE_SIZE);
  }
  function showLoadedRecipes() {
    setCategory('');
    setCuisine('');
    setCollection('all');
    setVisibleCount(PAGE_SIZE);
  }
  async function searchOnline(nextPage = false) {
    if (source === 'library' || operation.current) return;
    const previous = nextPage ? results : null;
    if (nextPage && (!previous?.hasMore || previous.scope !== scope)) return;
    if (!query.trim() && !ingredients.length) {
      setOnlineError('Type a dish or ingredient, or add groceries to search with your kitchen.');
      return;
    }
    const connection = source === 'themealdb' ? null : readGeminiConnection();
    if (source !== 'themealdb' && !connection) {
      setOnlineError('Connect your recipe sources in Settings, then try this search.');
      onConfigure();
      return;
    }
    const request = { scope, controller: new AbortController() };
    operation.current = request;
    const timer = window.setTimeout(() => request.controller.abort(), 25_000);
    setOnlineBusy(true);
    setOnlineError('');
    if (!nextPage) {
      setOnline(null);
      setVisibleCount(PAGE_SIZE);
    }
    const valid = () =>
      operation.current === request &&
      currentScope.current === request.scope &&
      !request.controller.signal.aborted;
    try {
      let next: SourceResults;
      if (source === 'themealdb') {
        // The outer deadline and cancellation cover every bounded discovery request.
        const fetcher: typeof fetch = (input, init) =>
          fetch(input, { ...init, signal: request.controller.signal });
        const recipes = query.trim()
          ? await searchRecipes(query.trim(), fetcher)
          : await discoverRecipes(relevant, fetcher);
        next = { source, scope: request.scope, recipes, page: 1, hasMore: false, warnings: [] };
      } else {
        const input: RecipeProviderSearch = previous?.search
          ? { ...previous.search, page: previous.page + 1 }
          : {
              provider: source,
              query: query.trim(),
              ...(!query.trim() ? { ingredients: searchIngredients } : {}),
              page: 1,
              limit: 10,
            };
        const reply = await searchRecipeProviders(connection!, input, request.controller.signal);
        next = {
          source,
          scope: request.scope,
          recipes: previous ? dedupeRecipes(previous.recipes, reply.recipes) : reply.recipes,
          page: reply.page,
          hasMore: reply.hasMore,
          search: input,
          warnings: [...new Set([...(previous?.warnings ?? []), ...reply.warnings])],
          ...(reply.expiresAt
            ? { expiresAt: Math.min(previous?.expiresAt ?? reply.expiresAt, reply.expiresAt) }
            : {}),
        };
      }
      if (valid()) {
        setOnline(next);
        if (nextPage) setVisibleCount((count) => Math.max(count, next.recipes.length));
      }
    } catch (error) {
      if (operation.current === request && currentScope.current === request.scope)
        setOnlineError(
          request.controller.signal.aborted
            ? 'This search took too long. Try again.'
            : error instanceof Error
              ? error.message
              : `Could not search ${sourceName}.`,
        );
    } finally {
      window.clearTimeout(timer);
      if (operation.current === request) {
        operation.current = null;
        setOnlineBusy(false);
      }
    }
  }
  const activeFilters: { id: string; label: string; clear: () => void }[] = [
    ...(collection !== 'all'
      ? [
          {
            id: 'collection',
            label: recipeCollectionLabel(collection),
            clear: () => setCollection('all'),
          },
        ]
      : []),
    ...(category ? [{ id: 'category', label: category, clear: () => setCategory('') }] : []),
    ...(cuisine ? [{ id: 'cuisine', label: cuisine, clear: () => setCuisine('') }] : []),
    ...(prioritize
      ? [{ id: 'expiry', label: 'Use expiring first', clear: () => setPrioritize(false) }]
      : []),
    ...(useSelection && selectedBatchIds.length > 0
      ? [{ id: 'selection', label: 'Selected inventory', clear: () => onUseSelectionChange(false) }]
      : []),
  ];
  const hasFilters = activeFilters.length > 0;
  const showing = Math.min(visibleCount, matches.length);
  let emptyHeading = 'No recipes match these filters.';
  let emptyDescription =
    'Try another ingredient, clear the filters, or load more from your chosen source.';
  if (source !== 'library') {
    if (onlineError && !results) {
      emptyHeading = 'Search couldn’t finish.';
      emptyDescription =
        'The message above explains the problem. Try again or test this source in Settings.';
    } else if (!results) {
      emptyHeading = `Ready to search ${sourceName}.`;
      emptyDescription =
        'Enter a dish or ingredient above, or leave it blank to search with your kitchen inventory.';
    } else if (results.recipes.length > 0) {
      emptyHeading = 'Your filters hide these recipes.';
      emptyDescription = `${results.recipes.length} recipes were loaded successfully. Show them all to see which ingredients you have and which are missing.`;
    } else if (results.warnings.some((warning) => warning.includes('omitted'))) {
      // Older Workers returned a successful empty list after rejecting all provider records.
      emptyHeading = 'Recipe details couldn’t be read.';
      emptyDescription =
        'This source returned recipes, but their details could not be read. Update your Worker from Settings and test the source again.';
    } else {
      emptyHeading = `No recipes found on ${sourceName}.`;
      emptyDescription =
        'Try a broader dish or a different ingredient. No recipes were returned for this search.';
    }
  } else if (collection === 'saved' && saved.length === 0) {
    emptyHeading = 'Your favorites start here.';
    emptyDescription = 'Save something you like, import a recipe, or add your own.';
  }
  return (
    <section className="recipe-browser" aria-label="Recipe browser">
      <header className="recipe-browser-heading">
        <div>
          <h1>Recipes</h1>
        </div>
        <div className="recipe-browser-actions">
          <button className="button secondary" onClick={onImport}>
            <Upload size={17} /> Import recipe
          </button>
          <button className="button primary" onClick={onNew}>
            <Plus size={17} /> Add recipe
          </button>
        </div>
      </header>
      <div className="recipe-search-panel">
        {source !== 'library' && (
          <div className="recipe-search-scope">
            <span>
              Searching <strong>{sourceName}</strong>
            </span>
            <button className="text-button" onClick={() => changeSource('library')}>
              Use your cookbook <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}
        <form
          className="hub-search recipe-search-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (source === 'library') {
              setVisibleCount(PAGE_SIZE);
              if (localError) void openCookbook();
            } else void searchOnline();
          }}
        >
          <div className="recipe-search-input">
            <input
              aria-label="Find recipes"
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              placeholder={
                source === 'library' ? 'Search recipes or ingredients' : `Search ${sourceName}`
              }
              maxLength={120}
            />
            {query && (
              <button
                type="button"
                className="icon-button"
                aria-label="Clear recipe search"
                onClick={() => changeQuery('')}
              >
                <X size={17} />
              </button>
            )}
          </div>
          <button
            className="button primary"
            aria-label={
              source === 'library'
                ? 'Search library'
                : onlineBusy
                  ? `Searching ${sourceName}…`
                  : `Search ${sourceName}`
            }
            disabled={source === 'library' ? localBusy : onlineBusy}
          >
            <Search size={20} aria-hidden="true" />
          </button>
        </form>
        {source !== 'library' && (
          <p className="recipe-search-hint">
            {source === 'spoonacular' && !query.trim() && spoonacularIngredient
              ? `Starts with ${spoonacularIngredient}. Choose Search Spoonacular to load recipes.`
              : 'Choose Search to load recipes. Filters and sorting use the results already loaded.'}
          </p>
        )}
      </div>
      <div className="recipe-browse-toolbar">
        <button
          className={
            hasFilters
              ? 'button secondary recipe-filter-button active'
              : 'button secondary recipe-filter-button'
          }
          aria-label={hasFilters ? `Filters (${activeFilters.length})` : 'Filters'}
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(true)}
        >
          <SlidersHorizontal size={17} aria-hidden="true" /> Filters
          {hasFilters && (
            <span className="recipe-filter-count" aria-hidden="true">
              {activeFilters.length}
            </span>
          )}
        </button>
        <div className="recipe-sort-picker">
          <span>Sort by</span>
          <Choice
            label="Sort by"
            value={order}
            options={[
              { value: 'browse', label: 'Name' },
              { value: 'most-matches', label: 'Most matches' },
            ]}
            onChange={(value) => {
              setOrder(value as BrowseOrder);
              setVisibleCount(PAGE_SIZE);
            }}
          />
        </div>
      </div>
      {hasFilters && (
        <div className="recipe-active-filters" role="group" aria-label="Active recipe filters">
          {activeFilters.map((item) => (
            <button
              key={item.id}
              className="recipe-filter-chip"
              aria-label={`Remove ${item.label} filter`}
              onClick={() => {
                item.clear();
                setVisibleCount(PAGE_SIZE);
              }}
            >
              {item.label} <X size={13} aria-hidden="true" />
            </button>
          ))}
          <button className="text-button" onClick={clearFilters}>
            Clear all
          </button>
        </div>
      )}
      <Modal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filter recipes"
        description="Choose what you want to see. Changes apply as you go."
        className="recipe-filter-drawer"
      >
        <div className="recipe-filter-fields">
          <section className="recipe-filter-group" aria-label="Collection filter">
            <h3>Collection</h3>
            <Choice
              label="Recipe collection"
              value={collection}
              options={(['saved', 'all', 'imported', 'manual', 'ai'] as const).map((value) => ({
                value,
                label: recipeCollectionLabel(value),
              }))}
              onChange={(value) => changeCollection(value as RecipeCollection)}
            />
            <p>All recipes includes the community cookbook.</p>
          </section>
          <section className="recipe-filter-group" aria-label="Recipe details filters">
            <h3>Category &amp; cuisine</h3>
            <p>From recipe details. Edit a recipe to change its category or cuisine.</p>
            <label className="recipe-filter-field">
              <span>Category</span>
              <Choice
                label="Recipe category"
                value={category}
                options={[
                  { value: '', label: 'Every category' },
                  ...[...new Set([...facets.categories, ...(category ? [category] : [])])].map(
                    (name) => ({ value: name, label: name }),
                  ),
                ]}
                onChange={(value) => {
                  setCategory(value);
                  setVisibleCount(PAGE_SIZE);
                }}
              />
            </label>
            <label className="recipe-filter-field">
              <span>Cuisine</span>
              <Choice
                label="Recipe cuisine"
                value={cuisine}
                options={[
                  { value: '', label: 'Every cuisine' },
                  ...[...new Set([...facets.cuisines, ...(cuisine ? [cuisine] : [])])].map(
                    (name) => ({ value: name, label: name }),
                  ),
                ]}
                onChange={(value) => {
                  setCuisine(value);
                  setVisibleCount(PAGE_SIZE);
                }}
              />
            </label>
          </section>
          <section
            className="recipe-filter-group recipe-kitchen-filters"
            aria-label="Ingredient preferences"
          >
            <label>
              <input
                type="checkbox"
                checked={prioritize}
                onChange={(event) => {
                  setPrioritize(event.target.checked);
                  setVisibleCount(PAGE_SIZE);
                }}
              />
              <span>Prioritize expiring ingredients</span>
            </label>
            <p>Favors recipes using ingredients with a recorded date in the next 3 days.</p>
            {selectedBatchIds.length > 0 && (
              <label>
                <input
                  type="checkbox"
                  checked={useSelection}
                  onChange={(event) => {
                    onUseSelectionChange(event.target.checked);
                    setVisibleCount(PAGE_SIZE);
                  }}
                />
                <span>Use only selected inventory</span>
              </label>
            )}
          </section>
          <section className="recipe-filter-group" aria-label="Recipe source filter">
            <h3>Recipe source</h3>
            <Choice
              label="Recipe source"
              value={source}
              options={[
                { value: 'library', label: 'Your collection & community cookbook' },
                { value: 'themealdb', label: 'TheMealDB' },
                { value: 'recipeapi', label: 'RecipeAPI.io' },
                { value: 'spoonacular', label: 'Spoonacular' },
              ]}
              onChange={(value) => changeSource(value as BrowseSource)}
            />
            <p>
              {source === 'library'
                ? 'Browse your collection or choose All recipes for the built-in cookbook.'
                : source === 'spoonacular'
                  ? 'Temporary discovery. Open recipes on their original website.'
                  : 'Search this source, then save recipes to your collection.'}
            </p>
            {source === 'spoonacular' && !query.trim() && ingredients.length > 1 && (
              <label className="recipe-filter-field">
                <span>Start with ingredient</span>
                <Choice
                  label="Start with ingredient"
                  value={spoonacularIngredient}
                  options={ingredients.map((name) => ({ value: name, label: name }))}
                  onChange={(value) => {
                    resetOnline();
                    setStartIngredient(value);
                  }}
                />
              </label>
            )}
            {provider && (
              <button
                className="text-button"
                onClick={() => {
                  setFiltersOpen(false);
                  onConfigure();
                }}
              >
                Recipe source settings
              </button>
            )}
          </section>
        </div>
        <div className="recipe-filter-footer">
          <button className="text-button" disabled={!hasFilters} onClick={clearFilters}>
            Clear all
          </button>
          <button className="button primary" onClick={() => setFiltersOpen(false)}>
            Show recipes
          </button>
        </div>
      </Modal>
      <section className="recipe-result-section" aria-label={`${sourceName} search results`}>
        {source === 'library' && localBusy && (
          <p className="settings-note" role="status">
            Opening your cookbook…
          </p>
        )}
        {source === 'library' && localError && (
          <p className="library-error" role="alert">
            {localError}{' '}
            <button className="text-button" onClick={() => void openCookbook()}>
              Retry cookbook
            </button>
          </p>
        )}
        {source !== 'library' && onlineBusy && (
          <p className="settings-note" role="status">
            Searching {sourceName}…
          </p>
        )}
        {source !== 'library' && onlineError && (
          <p className="library-error recipe-source-feedback" role="alert">
            {onlineError}
          </p>
        )}
        <div className="library-results" role="status" aria-live="polite">
          <span>
            {source !== 'library' && !results
              ? `${onlineError ? 'Search failed' : 'No recipes loaded'} · ${sourceName}`
              : `Showing ${showing.toLocaleString()} of ${matches.length.toLocaleString()} recipes · ${sourceName}`}
            {collection !== 'all' ? ` · ${recipeCollectionLabel(collection)}` : ''}
            {query.trim() && (source === 'library' || results) ? ` for “${query.trim()}”` : ''}
          </span>
        </div>
        {order === 'most-matches' && (
          <p className="recipe-order-note">
            Matches count ingredients you have, even if you need more. Amounts are checked
            separately against the original recipe.
          </p>
        )}
        {source !== 'library' && results && (
          <p className="recipe-loaded-note">
            {results.recipes.length} recipes loaded · {matches.length} match your filters.
          </p>
        )}
        {results?.warnings.map((warning) => (
          <p className="settings-note" key={warning}>
            {warning}
          </p>
        ))}
        <div className="recipe-grid">
          {matches.slice(0, visibleCount).map((match) =>
            source === 'spoonacular' ? (
              <article className="recipe-discovery-card" key={match.recipe.id}>
                <MatchBadge match={match} />
                <h3>{match.recipe.title}</h3>
                <p>{availabilitySummary(match, order === 'most-matches')}</p>
                {match.recipe.source.attribution && (
                  <small>{match.recipe.source.attribution}</small>
                )}
                {safeLink(match.recipe.source.url) && (
                  <a
                    className="button secondary"
                    href={match.recipe.source.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open original recipe <ExternalLink size={16} />
                  </a>
                )}
              </article>
            ) : (
              <RecipeCard
                key={match.recipe.id}
                match={match}
                showMatches={order === 'most-matches'}
                saved={saved.some((recipe) => recipe.id === match.recipe.id)}
                onOpen={() => onOpen(match.recipe)}
                onSave={() => onSave(match.recipe)}
                onAddToGemini={() => onAddToGemini(match.recipe)}
                inGeminiContext={geminiRecipeIds.includes(match.recipe.id)}
                onRemoveSaved={
                  saved.some((recipe) => recipe.id === match.recipe.id)
                    ? () => onRemoveSaved(match.recipe)
                    : undefined
                }
              />
            ),
          )}
        </div>
        {visibleCount < matches.length && (
          <div className="library-more">
            <button
              className="button primary"
              onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
            >
              {source === 'library' ? 'Load more recipes' : 'Show more loaded recipes'}
            </button>
            <small>{matches.length - visibleCount} more matching recipes</small>
          </div>
        )}
        {source !== 'library' && results?.hasMore && (
          <div className="library-more">
            <button
              className="button secondary"
              disabled={onlineBusy}
              onClick={() => void searchOnline(true)}
            >
              {onlineBusy ? 'Loading…' : `Load more from ${sourceName}`}
            </button>
            <small>Find more recipes from this search.</small>
          </div>
        )}
        {source === 'spoonacular' && results && (
          <a
            className="recipe-loaded-note"
            href="https://spoonacular.com/food-api"
            target="_blank"
            rel="noreferrer"
          >
            Powered by Spoonacular · Temporary online discovery
          </a>
        )}
        {!matches.length && !(source === 'library' ? localBusy : onlineBusy) && (
          <div className="empty-state compact">
            <BookOpen size={36} />
            <h2>{emptyHeading}</h2>
            <p>{emptyDescription}</p>
            {source === 'library' && collection === 'saved' && saved.length === 0 ? (
              <button className="button secondary" onClick={showLoadedRecipes}>
                Browse all recipes
              </button>
            ) : source !== 'library' && results && results.recipes.length > 0 ? (
              <button className="button secondary" onClick={showLoadedRecipes}>
                Show all loaded recipes
              </button>
            ) : hasFilters ? (
              <button className="button secondary" onClick={clearFilters}>
                Clear recipe filters
              </button>
            ) : source === 'library' && query.trim() ? (
              <button className="button secondary" onClick={() => changeQuery('')}>
                Clear recipe search
              </button>
            ) : null}
          </div>
        )}
        {source === 'library' &&
          matches.some((match) => match.recipe.source.type === 'wikibooks') && (
            <p className="recipe-attribution">
              Community recipes by{' '}
              <a
                href="https://en.wikibooks.org/wiki/Cookbook:Table_of_Contents"
                target="_blank"
                rel="noreferrer"
              >
                Wikibooks contributors
              </a>{' '}
              ·{' '}
              <a
                href="https://creativecommons.org/licenses/by-sa/4.0/"
                target="_blank"
                rel="noreferrer"
              >
                CC BY-SA 4.0
              </a>
              . Original sources and ingredient measures stay with each recipe.
            </p>
          )}
      </section>
    </section>
  );
}
