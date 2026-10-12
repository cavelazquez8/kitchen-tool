import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Check, ExternalLink, Plus, Search, Upload, Utensils, X } from 'lucide-react';
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
  type BrowseFilter,
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
const labels = { ready: 'Ready to cook', almost: 'Almost ready', check: 'Check quantities' };
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
function RecipeCard({
  match,
  saved,
  onOpen,
  onSave,
}: {
  match: RecipeMatch;
  saved: boolean;
  onOpen: () => void;
  onSave: () => void;
}) {
  const recipe = match.recipe;
  return (
    <article className="recipe-card">
      {safeLink(recipe.imageUrl) ? (
        <img src={recipe.imageUrl} alt="" loading="lazy" />
      ) : (
        <div className="recipe-art" aria-hidden="true">
          <Utensils size={30} strokeWidth={1.3} />
          <span>{recipe.category ?? 'From the cookbook'}</span>
        </div>
      )}
      <div className="recipe-card-body">
        <span className={`match-badge ${match.status}`}>{labels[match.status]}</span>
        <button className="recipe-title" onClick={onOpen}>
          <h3>{recipe.title}</h3>
        </button>
        <p>
          {match.missingCount
            ? `${match.missingCount} ingredient${match.missingCount === 1 ? '' : 's'} short`
            : `${match.matchedCount} ingredients on hand`}
          {match.uncertainCount > 0 ? ' · Check amounts' : ''}
        </p>
        <small>
          {recipe.source.name ?? sourceLabels[recipe.source.type]}
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
  const [filter, setFilter] = useState<BrowseFilter>('all');
  const [collection, setCollection] = useState<RecipeCollection>('all');
  const [order, setOrder] = useState<BrowseOrder>('kitchen');
  const [prioritize, setPrioritize] = useState(false);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [local, setLocal] = useState<Recipe[]>([]);
  const [localBusy, setLocalBusy] = useState(true);
  const [localError, setLocalError] = useState('');
  const [online, setOnline] = useState<SourceResults | null>(null);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [startIngredient, setStartIngredient] = useState('');
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
        filter,
        order,
        prioritizeExpiration: prioritize,
        savedIds: saved.map((recipe) => recipe.id),
      }),
    [
      source,
      collectionRecipes,
      relevant,
      query,
      category,
      cuisine,
      filter,
      order,
      prioritize,
      saved,
    ],
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
      setFilter('all');
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
      if (filter === 'saved') setFilter('all');
    }
    setCategory('');
    setCuisine('');
    setVisibleCount(PAGE_SIZE);
  }
  function changeCollection(next: RecipeCollection) {
    if (next !== 'all' && source !== 'library') changeSource('library');
    setCollection(next);
    if (filter === 'saved') setFilter('all');
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
    setFilter('all');
    setCollection('all');
    setPrioritize(false);
    onUseSelectionChange(false);
    setVisibleCount(PAGE_SIZE);
    if (source === 'library') changeQuery('');
  }
  function showLoadedRecipes() {
    setCategory('');
    setCuisine('');
    setFilter('all');
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
  const hasFilters =
    !!category ||
    !!cuisine ||
    filter !== 'all' ||
    collection !== 'all' ||
    prioritize ||
    (useSelection && selectedBatchIds.length > 0) ||
    (source === 'library' && !!query.trim());
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
  } else if (filter === 'saved') {
    emptyHeading = 'Your favorites start here.';
    emptyDescription = 'Save something you like, import a recipe, or add your own.';
  }
  return (
    <section className="recipe-browser" aria-label="Recipe browser">
      <section className="library-intro">
        <div>
          <span className="library-eyebrow">YOUR NEXT GOOD MEAL</span>
          <h2>Find your next meal.</h2>
          <p>
            {source !== 'library'
              ? `${sourceName} recipes, compared with your kitchen.`
              : collection !== 'all'
                ? `${recipeCollectionLabel(collection)} from your personal library.`
                : local.length
                  ? `${local.length.toLocaleString()} built-in recipes · Your saved favorites, too.`
                  : 'Your cookbook and saved favorites.'}
          </p>
        </div>
        <BookOpen size={36} strokeWidth={1.3} aria-hidden="true" />
      </section>
      <div className="recipe-search-panel">
        <div className="recipe-source-picker">
          <span className="recipe-source-label">Recipe source</span>
          <Choice
            label="Recipe source"
            value={source}
            options={[
              { value: 'library', label: 'Your cookbook' },
              { value: 'themealdb', label: 'TheMealDB' },
              { value: 'recipeapi', label: 'RecipeAPI.io' },
              { value: 'spoonacular', label: 'Spoonacular' },
            ]}
            onChange={(value) => changeSource(value as BrowseSource)}
          />
          <p>
            {source === 'library'
              ? 'Built-in recipes and everything you’ve saved.'
              : source === 'spoonacular'
                ? 'Temporary discovery. Open recipes on their original website.'
                : 'Find more recipes, then save the ones you like.'}
          </p>
        </div>
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
            <Search size={18} aria-hidden="true" />
            <input
              aria-label="Find recipes"
              value={query}
              onChange={(event) => changeQuery(event.target.value)}
              placeholder={
                source === 'library' ? 'Search dishes or ingredients…' : `Search ${sourceName}…`
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
            disabled={source === 'library' ? localBusy : onlineBusy}
          >
            {source === 'library'
              ? 'Search library'
              : onlineBusy
                ? `Searching ${sourceName}…`
                : `Search ${sourceName}`}
          </button>
        </form>
        <div className="recipe-search-note">
          <span>
            {source === 'library'
              ? 'Results update as you type. Filters apply immediately.'
              : source === 'spoonacular' && !query.trim() && spoonacularIngredient
                ? `Search starts with ${spoonacularIngredient}, then compares each recipe with your kitchen.`
                : 'Search when ready. Changing filters uses the recipes already loaded.'}
          </span>
          {provider && (
            <button className="text-button" onClick={onConfigure}>
              Recipe source settings
            </button>
          )}
        </div>
        {source === 'spoonacular' && !query.trim() && ingredients.length > 1 && (
          <div className="recipe-start-ingredient">
            <Choice
              label="Start with ingredient"
              value={spoonacularIngredient}
              options={ingredients.map((name) => ({ value: name, label: name }))}
              onChange={(value) => {
                resetOnline();
                setStartIngredient(value);
              }}
            />
          </div>
        )}
        <div className="recipe-browser-actions">
          <button className="button secondary" onClick={onImport}>
            <Upload size={17} /> Import recipe
          </button>
          <button className="button secondary" onClick={onNew}>
            <Plus size={17} /> Your own recipe
          </button>
        </div>
      </div>
      <div className="library-browse-controls">
        <div className="library-view" role="group" aria-label="Recipe order">
          {(['kitchen', 'browse'] as const).map((value) => (
            <button
              key={value}
              className={order === value ? 'active' : ''}
              aria-pressed={order === value}
              onClick={() => {
                setOrder(value);
                setVisibleCount(PAGE_SIZE);
              }}
            >
              {value === 'kitchen' ? 'For your kitchen' : 'Browse all'}
            </button>
          ))}
        </div>
        <div className="recipe-collection-picker">
          <span className="recipe-source-label">Recipe collection</span>
          <Choice
            label="Recipe collection"
            value={collection}
            options={(['all', 'saved', 'imported', 'manual', 'ai'] as const).map((value) => ({
              value,
              label: recipeCollectionLabel(value),
            }))}
            onChange={(value) => changeCollection(value as RecipeCollection)}
          />
        </div>
      </div>
      <div className="hub-filters">
        {(['all', 'ready', 'close', 'saved', 'imported'] as const).map((value) => (
          <button
            key={value}
            className={
              (
                value === 'saved' || value === 'imported'
                  ? collection === value
                  : filter === value && (value !== 'all' || collection === 'all')
              )
                ? 'active'
                : ''
            }
            aria-pressed={
              value === 'saved' || value === 'imported'
                ? collection === value
                : filter === value && (value !== 'all' || collection === 'all')
            }
            onClick={() => {
              if (value === 'saved' || value === 'imported') changeCollection(value);
              else {
                setFilter(value);
                if (value === 'all') setCollection('all');
              }
              setVisibleCount(PAGE_SIZE);
            }}
          >
            {
              {
                all: 'All recipes',
                ready: 'Ready to cook',
                close: 'Missing up to 2',
                saved: 'Saved recipes',
                imported: 'Imported recipes',
              }[value]
            }
          </button>
        ))}
      </div>
      <details className="library-refine">
        <summary>
          Refine recipes
          {category || cuisine ? ` · ${[category, cuisine].filter(Boolean).join(' / ')}` : ''}
        </summary>
        <div className="library-browse-controls">
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
          <Choice
            label="Recipe cuisine"
            value={cuisine}
            options={[
              { value: '', label: 'Every cuisine' },
              ...[...new Set([...facets.cuisines, ...(cuisine ? [cuisine] : [])])].map((name) => ({
                value: name,
                label: name,
              })),
            ]}
            onChange={(value) => {
              setCuisine(value);
              setVisibleCount(PAGE_SIZE);
            }}
          />
        </div>
        <div className="hub-preferences">
          <label>
            <input
              type="checkbox"
              checked={prioritize}
              onChange={(event) => {
                setPrioritize(event.target.checked);
                setVisibleCount(PAGE_SIZE);
              }}
            />{' '}
            Prioritize expiring ingredients
          </label>
          {selectedBatchIds.length > 0 && (
            <label>
              <input
                type="checkbox"
                checked={useSelection}
                onChange={(event) => {
                  onUseSelectionChange(event.target.checked);
                  setVisibleCount(PAGE_SIZE);
                }}
              />{' '}
              Use only selected inventory
            </label>
          )}
          <button
            className="text-button"
            onClick={() => {
              setOrder('kitchen');
              setVisibleCount(PAGE_SIZE);
              if (source !== 'library') void searchOnline();
              else if (localError) void openCookbook();
            }}
          >
            Refresh suggestions
          </button>
        </div>
      </details>
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
          {hasFilters && (
            <button className="text-button" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
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
                <span className={`match-badge ${match.status}`}>{labels[match.status]}</span>
                <h3>{match.recipe.title}</h3>
                <p>
                  {match.missingCount
                    ? `${match.missingCount} ingredients short`
                    : `${match.matchedCount} ingredients on hand`}
                  {match.uncertainCount ? ' · Check amounts' : ''}
                </p>
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
                saved={saved.some((recipe) => recipe.id === match.recipe.id)}
                onOpen={() => onOpen(match.recipe)}
                onSave={() => onSave(match.recipe)}
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
            {source !== 'library' && results && results.recipes.length > 0 ? (
              <button className="button secondary" onClick={showLoadedRecipes}>
                Show all loaded recipes
              </button>
            ) : hasFilters ? (
              <button className="button secondary" onClick={clearFilters}>
                Clear recipe filters
              </button>
            ) : null}
          </div>
        )}
      </section>
    </section>
  );
}
