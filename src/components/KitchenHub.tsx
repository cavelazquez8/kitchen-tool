import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  BookOpen,
  Check,
  Clipboard,
  Plus,
  ScanLine,
  ShoppingCart,
  Sparkles,
  Trash2,
  Utensils,
  Upload,
  X,
  ExternalLink,
} from 'lucide-react';
import type { InventoryState, ShoppingItem } from '../domain/types';
import type { InventoryReducer } from '../lib/repository';
import { generateMarkdown } from '../domain/export';
import { formatQuantity } from '../domain/inventory';
import { rankRecipes, matchRecipe, buildShoppingList } from '../recipes/matching';
import { discoverRecipes, searchRecipes } from '../recipes/library';
import { searchRecipeProviders } from '../recipes/providerClient';
import {
  canPersistProviderRecipe,
  RECIPE_PROVIDER_INFO,
  type RecipeProviderId,
  type RecipeProviderResults,
  type RecipeProviderSearch,
} from '../recipes/providers';
import { canonicalIngredientName } from '../recipes/identity';
import { loadLocalRecipes, searchLocalRecipes, recipeFacets } from '../recipes/localLibrary';
import { isRecipe, type Recipe } from '../recipes/types';
import {
  normalizeAiRecipe,
  boundedChatHistory,
  boundedInventoryContext,
  recipeContext,
} from '../ai/context';
import { parseIngredientLine, parseRecipeText } from '../recipes/parse';
import { FOOD_CATALOG } from '../recipes/catalog';
import {
  readGeminiConnection,
  sendGeminiChat,
  extractGeminiRecipe,
  fileToGeminiMedia,
  importGeminiRecipeUrl,
  type AiReply,
} from '../ai/client';
import { Modal } from './Modal';
import { Autocomplete } from './Autocomplete';
import { RecipeEditor } from './RecipeEditor';
import { FinishCooking } from './FinishCooking';
import { Choice } from './Choice';
import './recipeProviders.css';

export type HubPage = 'recipes' | 'shopping' | 'assistant';
interface Props {
  page: HubPage;
  inventory: InventoryState;
  selectedBatchIds: string[];
  update: (reducer: InventoryReducer) => Promise<void>;
  onToast: (message: string) => void;
  onQuickAdd: (name: string, quantity?: number | null, unit?: string, shoppingId?: string) => void;
  onScan: () => void;
  onConfigure: () => void;
  onNavigate: (page: HubPage) => void;
}
const labels = { ready: 'Ready to cook', almost: 'Almost ready', check: 'Check quantities' };
const sourceLabels = {
  themealdb: 'TheMealDB',
  wikibooks: 'Wikibooks Cookbook',
  imported: 'Imported',
  ai: 'AI-created',
  manual: 'Your recipe',
};
const RECIPE_PAGE_SIZE = 24;
function safeLink(value?: string) {
  try {
    const url = new URL(value ?? '');
    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
function blankRecipe(): Recipe {
  return {
    id: crypto.randomUUID(),
    title: '',
    servings: null,
    ingredients: [{ name: '', quantity: null, unit: '' }],
    steps: [],
    source: { type: 'manual' },
  };
}
function RecipeCard({
  recipe,
  inventory,
  onOpen,
  onSave,
  saved,
}: {
  recipe: Recipe;
  inventory: InventoryState;
  onOpen: () => void;
  onSave: () => void;
  saved: boolean;
}) {
  const match = matchRecipe(recipe, inventory);
  return (
    <article className="recipe-card">
      {recipe.imageUrl && safeLink(recipe.imageUrl) && (
        <img src={recipe.imageUrl} alt="" loading="lazy" />
      )}
      {!safeLink(recipe.imageUrl) && (
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
export function KitchenHub({
  page,
  inventory,
  selectedBatchIds,
  update,
  onToast,
  onQuickAdd,
  onScan,
  onConfigure,
  onNavigate,
}: Props) {
  const [catalog, setCatalog] = useState<Recipe[]>([]);
  const [localCatalog, setLocalCatalog] = useState<Recipe[]>([]);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [category, setCategory] = useState('');
  const [cuisine, setCuisine] = useState('');
  const [libraryView, setLibraryView] = useState<'kitchen' | 'browse'>('kitchen');
  const [visibleCount, setVisibleCount] = useState(RECIPE_PAGE_SIZE);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [onlineBusy, setOnlineBusy] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [onlineSource, setOnlineSource] = useState<'themealdb' | RecipeProviderId>('themealdb');
  const [providerResults, setProviderResults] = useState<RecipeProviderResults | null>(null);
  const [providerSearch, setProviderSearch] = useState<RecipeProviderSearch | null>(null);
  const [libraryError, setLibraryError] = useState('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'ready' | 'close' | 'saved'>('all');
  const [prioritize, setPrioritize] = useState(false);
  const [useSelection, setUseSelection] = useState(false);
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [editingNotes, setEditingNotes] = useState<readonly string[]>([]);
  const [clearChatOpen, setClearChatOpen] = useState(false);
  const [detail, setDetail] = useState<Recipe | null>(null);
  const [detailServings, setDetailServings] = useState('');
  const [finishing, setFinishing] = useState<{ recipe: Recipe; servings?: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [media, setMedia] = useState<File | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [candidates, setCandidates] = useState<Recipe[]>([]);
  const [chatRecipe, setChatRecipe] = useState<Recipe | null>(null);
  const [shoppingName, setShoppingName] = useState('');
  const [manualShoppingName, setManualShoppingName] = useState('');
  const [timers, setTimers] = useState<Record<string, number>>({});
  const [minutes, setMinutes] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [awake, setAwake] = useState(false);
  const libraryRequest = useRef(0);
  const onlineRequest = useRef(0);
  const cancelOnlineSearch = useCallback(() => {
    onlineRequest.current++;
    setOnlineBusy(false);
  }, []);
  const endRef = useRef<HTMLDivElement>(null);
  const saved = useMemo(() => inventory.recipes ?? [], [inventory.recipes]);
  const plan = inventory.mealPlan ?? [];
  const shopping = inventory.shoppingList ?? [];
  const history = inventory.chatHistory ?? [];
  const relevant = useMemo(
    () =>
      useSelection
        ? {
            ...inventory,
            batches: inventory.batches.filter((batch) => selectedBatchIds.includes(batch.id)),
          }
        : inventory,
    [inventory, useSelection, selectedBatchIds],
  );
  const allRecipes = useMemo(
    () => [
      ...new Map(
        [...localCatalog, ...catalog, ...saved].map((recipe) => [recipe.id, recipe]),
      ).values(),
    ],
    [localCatalog, catalog, saved],
  );
  const facets = useMemo(() => recipeFacets(allRecipes), [allRecipes]);
  const matches = useMemo(() => {
    const recipes = searchLocalRecipes(allRecipes, submittedQuery, { category, cuisine });
    const ranked = rankRecipes(recipes, relevant, { prioritizeExpiration: prioritize }).filter(
      (item) =>
        filter === 'all' ||
        (filter === 'ready' && item.status === 'ready') ||
        (filter === 'close' && item.missingCount <= 2) ||
        (filter === 'saved' && saved.some((recipe) => recipe.id === item.recipe.id)),
    );
    if (libraryView === 'browse' || !relevant.batches.length)
      ranked.sort((a, b) => a.recipe.title.localeCompare(b.recipe.title));
    return ranked;
  }, [
    allRecipes,
    relevant,
    prioritize,
    submittedQuery,
    category,
    cuisine,
    libraryView,
    filter,
    saved,
  ]);
  const providerMatches = useMemo(
    () =>
      rankRecipes(providerResults?.recipes ?? [], relevant, { prioritizeExpiration: prioritize }),
    [providerResults, relevant, prioritize],
  );
  useEffect(() => {
    if (!providerResults || providerResults.storage !== 'session') return;
    if (page !== 'recipes' || onlineSource !== 'spoonacular') {
      setProviderResults(null);
      return;
    }
    const remaining = (providerResults.expiresAt ?? 0) - Date.now();
    if (remaining <= 0) {
      setProviderResults(null);
      return;
    }
    const timer = window.setTimeout(() => setProviderResults(null), remaining);
    const expire = () => {
      if ((providerResults.expiresAt ?? 0) <= Date.now()) setProviderResults(null);
    };
    document.addEventListener('visibilitychange', expire);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', expire);
    };
  }, [providerResults, page, onlineSource]);
  useEffect(() => {
    if (page !== 'recipes') return;
    let active = true;
    const request = ++libraryRequest.current;
    setLibraryBusy(true);
    setLibraryError('');
    loadLocalRecipes()
      .then((recipes) => {
        if (active && request === libraryRequest.current) setLocalCatalog(recipes);
      })
      .catch((e) => {
        if (active && request === libraryRequest.current)
          setLibraryError(e instanceof Error ? e.message : 'Could not load recipes.');
      })
      .finally(() => {
        if (active && request === libraryRequest.current) setLibraryBusy(false);
      });
    return () => {
      active = false;
      cancelOnlineSearch();
    };
  }, [page, cancelOnlineSearch]);
  useEffect(() => {
    if (!Object.keys(timers).length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [timers]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [history.length, aiBusy]);
  useEffect(() => {
    if (!awake || !detail) return;
    let lock: { release: () => Promise<void> } | undefined;
    let released = false;
    const manager = (
      navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
      }
    ).wakeLock;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || !manager) return;
      try {
        const next = await manager.request('screen');
        if (released) await next.release();
        else lock = next;
      } catch {
        /* Browser may decline. */
      }
    };
    void acquire();
    document.addEventListener('visibilitychange', acquire);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', acquire);
      void lock?.release();
    };
  }, [awake, detail]);
  async function mutate(reducer: InventoryReducer, success?: string) {
    try {
      await update(reducer);
      if (success) onToast(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
      throw e;
    }
  }
  async function saveRecipe(recipe: Recipe, reveal = false) {
    if (!canPersistProviderRecipe(recipe))
      throw new Error('Open the original source to use this online discovery recipe.');
    if (!isRecipe(recipe)) throw new Error('Please review the recipe details before saving.');
    await mutate(
      (state) => ({
        ...state,
        recipes: [...(state.recipes ?? []).filter((r) => r.id !== recipe.id), recipe],
      }),
      'Recipe saved.',
    );
    setDetail((current) => (current?.id === recipe.id ? recipe : current));
    if (reveal) {
      onlineRequest.current++;
      setOnlineBusy(false);
      setFilter('saved');
      setQuery('');
      setSubmittedQuery('');
      setCategory('');
      setCuisine('');
      setVisibleCount(RECIPE_PAGE_SIZE);
    }
  }
  function openEditor(recipe: Recipe, notes: readonly string[] = []) {
    setEditingNotes(notes);
    setEditing(recipe);
  }
  function reviewReply(reply: AiReply) {
    const recipes = reply.recipes.map((draft) =>
      normalizeAiRecipe(draft, crypto.randomUUID(), { type: 'ai', name: 'Gemini' }),
    );
    if (recipes.length) {
      setCandidates(recipes);
      setChatRecipe(recipes[0]);
    }
    return recipes;
  }
  async function loadLibrary(event?: FormEvent, discover = false) {
    event?.preventDefault();
    onlineRequest.current++;
    setOnlineBusy(false);
    setSubmittedQuery(discover ? '' : query.trim());
    if (discover) setQuery('');
    setLibraryView(discover ? 'kitchen' : 'browse');
    setVisibleCount(RECIPE_PAGE_SIZE);
    const request = ++libraryRequest.current;
    setLibraryBusy(true);
    setLibraryError('');
    try {
      const recipes = await loadLocalRecipes();
      if (request === libraryRequest.current) setLocalCatalog(recipes);
    } catch (e) {
      if (request === libraryRequest.current)
        setLibraryError(e instanceof Error ? e.message : 'Could not load the recipe library.');
    } finally {
      if (request === libraryRequest.current) setLibraryBusy(false);
    }
  }
  async function loadOnlineRecipes(nextPage = false) {
    if (onlineBusy) return;
    if (onlineSource !== 'themealdb') {
      const connection = readGeminiConnection();
      if (!connection) {
        onConfigure();
        return;
      }
      const active = new Set(
        relevant.batches
          .filter((batch) => batch.quantity !== 0 && batch.stapleStatus !== 'empty')
          .map((batch) => batch.productId),
      );
      const ingredients = [
        ...new Set(
          relevant.products
            .filter((product) => active.has(product.id) && !product.isStaple)
            .map((product) => canonicalIngredientName(product.ingredientName ?? product.name))
            .filter(Boolean),
        ),
      ].slice(0, 60);
      const input: RecipeProviderSearch =
        nextPage && providerSearch && providerResults
          ? { ...providerSearch, page: providerResults.page + 1 }
          : {
              provider: onlineSource,
              query: query.trim(),
              ...(!query.trim() && ingredients.length ? { ingredients } : {}),
              page: 1,
              limit: 10,
            };
      if (!input.query && !input.ingredients?.length) {
        setOnlineError(
          'Enter a dish or ingredient above, or add groceries to find recipes for your kitchen.',
        );
        return;
      }
      const request = ++onlineRequest.current;
      setOnlineBusy(true);
      setOnlineError('');
      setLibraryError('');
      if (!nextPage) setProviderResults(null);
      try {
        const result = await searchRecipeProviders(connection, input);
        if (request !== onlineRequest.current) return;
        setProviderSearch(input);
        setProviderResults((current) =>
          nextPage && current?.provider === result.provider
            ? {
                ...result,
                recipes: [
                  ...new Map(
                    [...current.recipes, ...result.recipes].map((recipe) => [recipe.id, recipe]),
                  ).values(),
                ],
                ...(result.expiresAt
                  ? { expiresAt: Math.min(current.expiresAt ?? result.expiresAt, result.expiresAt) }
                  : {}),
                warnings: [...new Set([...current.warnings, ...result.warnings])],
              }
            : result,
        );
      } catch (e) {
        if (request === onlineRequest.current)
          setOnlineError(e instanceof Error ? e.message : 'Could not search this recipe source.');
      } finally {
        if (request === onlineRequest.current) setOnlineBusy(false);
      }
      return;
    }
    const request = ++onlineRequest.current;
    const term = query.trim();
    setSubmittedQuery(term);
    setVisibleCount(RECIPE_PAGE_SIZE);
    setOnlineBusy(true);
    setLibraryError('');
    try {
      const recipes = term ? await searchRecipes(term) : await discoverRecipes(relevant);
      if (request !== onlineRequest.current) return;
      setCatalog((current) => [
        ...new Map([...current, ...recipes].map((r) => [r.id, r])).values(),
      ]);
      if (!recipes.length)
        setLibraryError(
          'No additional recipes found. Your built-in and saved recipes are still available.',
        );
    } catch (e) {
      if (request === onlineRequest.current)
        setLibraryError(e instanceof Error ? e.message : 'Could not search TheMealDB.');
    } finally {
      if (request === onlineRequest.current) setOnlineBusy(false);
    }
  }
  async function ask(prompt = message) {
    if (!prompt.trim() || aiBusy) return;
    const connection = readGeminiConnection();
    if (!connection) {
      onConfigure();
      return;
    }
    setAiBusy(true);
    setError('');
    const user = { id: crypto.randomUUID(), role: 'user' as const, text: prompt.trim() };
    try {
      await mutate((state) => ({
        ...state,
        chatHistory: [...(state.chatHistory ?? []), user].slice(-80),
      }));
      setMessage('');
      const reply = await sendGeminiChat(connection, {
        message: prompt.trim(),
        inventory: boundedInventoryContext(generateMarkdown(relevant, { includeTools: true })),
        ...(chatRecipe ? { recipe: recipeContext(chatRecipe) } : {}),
        history: boundedChatHistory(history),
      });
      const assistant = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        text:
          reply.message.trim() ||
          (reply.recipes.length
            ? 'Here are recipes to review below.'
            : 'No answer was returned. Try a shorter question.'),
      };
      await mutate((state) => ({
        ...state,
        chatHistory: [...(state.chatHistory ?? []), assistant].slice(-80),
      }));
      reviewReply(reply);
      if (reply.warnings.length) setError(reply.warnings.join(' '));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'Gemini is unavailable. Copy your inventory to continue externally.',
      );
    } finally {
      setAiBusy(false);
    }
  }
  async function importRecipe(useAi: boolean) {
    setError('');
    try {
      if (!useAi) {
        const recipe = parseRecipeText(importText, crypto.randomUUID(), importUrl);
        if (!isRecipe(recipe))
          throw new Error(
            'Use a title, Ingredients heading, and Steps heading, or choose Extract with Gemini.',
          );
        setImportOpen(false);
        openEditor(recipe);
        return;
      }
      const connection = readGeminiConnection();
      if (!connection) {
        setImportOpen(false);
        onConfigure();
        return;
      }
      setAiBusy(true);
      const reply =
        media || importText.trim()
          ? await extractGeminiRecipe(connection, {
              text: importText.trim() || undefined,
              sourceUrl: importUrl.trim() || undefined,
              ...(media ? { media: await fileToGeminiMedia(media) } : {}),
            })
          : await importGeminiRecipeUrl(connection, importUrl.trim());
      const first = reply.recipes[0];
      if (!first)
        throw new Error(
          reply.message || 'No complete recipe was found. Paste the ingredients and steps instead.',
        );
      const recipe = normalizeAiRecipe(first, crypto.randomUUID(), {
        type: 'imported',
        ...(importUrl.trim() ? { url: importUrl.trim() } : {}),
      });
      if (!isRecipe(recipe)) throw new Error('Check the source URL and recipe details.');
      setImportOpen(false);
      openEditor(recipe, reply.warnings);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import.');
    } finally {
      setAiBusy(false);
    }
  }
  async function addToPlan(recipe: Recipe) {
    const servings = recipe.servings
      ? detailServings.trim()
        ? Number(detailServings)
        : recipe.servings
      : null;
    if (servings !== null && (!Number.isFinite(servings) || servings <= 0))
      throw new Error('Enter a positive number of servings.');
    await saveRecipe(recipe);
    await mutate(
      (state) => ({
        ...state,
        mealPlan: [
          ...(state.mealPlan ?? []).filter((item) => item.recipeId !== recipe.id),
          { recipeId: recipe.id, servings },
        ],
      }),
      'Added to your meal plan.',
    );
  }
  async function generateShopping() {
    const selections = plan.flatMap((item) => {
      const recipe = saved.find((r) => r.id === item.recipeId);
      return recipe
        ? [{ recipe, ...(item.servings !== null ? { servings: item.servings } : {}) }]
        : [];
    });
    const result = buildShoppingList(selections, inventory);
    const items: ShoppingItem[] = result.items.map((item) => ({
      id: crypto.randomUUID(),
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      status: item.status,
      checked: false,
      ...(item.reason ? { note: item.reason } : {}),
    }));
    const generated = items.map((item) => ({ ...item, id: 'recipe:' + item.id }));
    await mutate(
      (state) => ({
        ...state,
        shoppingList: [
          ...(state.shoppingList ?? []).filter(
            (item) => !item.checked && !item.id.startsWith('recipe:'),
          ),
          ...generated,
        ],
      }),
      'Shopping list updated.',
    );
    setError(result.warnings.join(' '));
  }
  const detailMatch = detail
    ? matchRecipe(detail, relevant, {
        ...(detail.servings && detailServings ? { servings: Number(detailServings) } : {}),
      })
    : null;
  const quickFoods = [
    ...new Set([
      ...inventory.products.map((product) => product.name),
      'Bananas',
      'Carrots',
      'Onions',
      'Tomatoes',
      'Apples',
      'Eggs',
    ]),
  ].slice(0, 8);

  return (
    <div className="kitchen-hub">
      {page === 'recipes' && (
        <>
          <section className="library-intro">
            <div>
              <span className="library-eyebrow">YOUR NEXT GOOD MEAL</span>
              <h2>Your built-in cookbook.</h2>
              <p>
                {localCatalog.length
                  ? `${localCatalog.length.toLocaleString()} built-in recipes · Free to browse · No account needed`
                  : 'A free built-in cookbook, matched to your kitchen.'}
              </p>
            </div>
            <BookOpen size={36} strokeWidth={1.3} aria-hidden="true" />
          </section>
          <div className="hub-toolbar">
            <form
              className="hub-search"
              onSubmit={(event) => {
                void loadLibrary(event);
              }}
            >
              <input
                aria-label="Find recipes"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search dishes or ingredients…"
              />
              <button className="button secondary" disabled={libraryBusy}>
                Search library
              </button>
            </form>
            <button
              className="button secondary"
              onClick={() => {
                setImportText('');
                setImportUrl('');
                setMedia(null);
                setImportOpen(true);
              }}
            >
              <Upload size={17} />
              Import recipe
            </button>
            <button className="button primary" onClick={() => openEditor(blankRecipe())}>
              <Plus size={17} />
              Your own recipe
            </button>
          </div>
          <div className="library-browse-controls">
            <div className="library-view" aria-label="Recipe order">
              {(['kitchen', 'browse'] as const).map((view) => (
                <button
                  key={view}
                  className={libraryView === view ? 'active' : ''}
                  aria-pressed={libraryView === view}
                  onClick={() => {
                    setLibraryView(view);
                    setVisibleCount(RECIPE_PAGE_SIZE);
                  }}
                >
                  {view === 'kitchen' ? 'For your kitchen' : 'Browse all'}
                </button>
              ))}
            </div>
          </div>
          <div className="hub-filters">
            {(['all', 'ready', 'close', 'saved'] as const).map((value) => (
              <button
                className={filter === value ? 'active' : ''}
                key={value}
                aria-pressed={filter === value}
                onClick={() => {
                  setFilter(value);
                  setVisibleCount(RECIPE_PAGE_SIZE);
                }}
              >
                {
                  {
                    all: 'All recipes',
                    ready: 'Ready to cook',
                    close: 'Missing up to 2',
                    saved: 'Saved recipes',
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
                  ...facets.categories.map((name) => ({ value: name, label: name })),
                ]}
                onChange={(value) => {
                  setCategory(value);
                  setVisibleCount(RECIPE_PAGE_SIZE);
                }}
              />
              {facets.cuisines.length > 0 && (
                <Choice
                  label="Recipe cuisine"
                  value={cuisine}
                  options={[
                    { value: '', label: 'Every cuisine' },
                    ...facets.cuisines.map((name) => ({ value: name, label: name })),
                  ]}
                  onChange={(value) => {
                    setCuisine(value);
                    setVisibleCount(RECIPE_PAGE_SIZE);
                  }}
                />
              )}
            </div>
            <div className="hub-preferences">
              <label>
                <input
                  type="checkbox"
                  checked={prioritize}
                  onChange={(e) => setPrioritize(e.target.checked)}
                />
                Prioritize expiring ingredients
              </label>
              {selectedBatchIds.length > 0 && (
                <label>
                  <input
                    type="checkbox"
                    checked={useSelection}
                    onChange={(e) => setUseSelection(e.target.checked)}
                  />
                  Use only selected inventory
                </label>
              )}
              <button
                className="text-button"
                disabled={libraryBusy}
                onClick={() => {
                  setQuery('');
                  setCategory('');
                  setCuisine('');
                  setFilter('all');
                  void loadLibrary(undefined, true);
                }}
              >
                Refresh suggestions
              </button>
            </div>
          </details>
          <div className="library-online">
            <div>
              <strong>Explore more recipes</strong>
              <p>Search another source with your dish or ingredients on hand.</p>
            </div>
            <div className="recipe-source-actions">
              <Choice
                label="Online recipe source"
                value={onlineSource}
                options={[
                  { value: 'themealdb', label: 'TheMealDB · No setup' },
                  { value: 'recipeapi', label: 'RecipeAPI.io · Free account' },
                  { value: 'spoonacular', label: 'Spoonacular · Online discovery' },
                ]}
                onChange={(value) => {
                  cancelOnlineSearch();
                  setOnlineSource(value as typeof onlineSource);
                  setProviderResults(null);
                  setProviderSearch(null);
                  setLibraryError('');
                  setOnlineError('');
                }}
              />
              <button
                className="button secondary"
                disabled={onlineBusy}
                onClick={() => {
                  void loadOnlineRecipes();
                }}
              >
                {onlineBusy ? 'Searching…' : 'More recipes online'}
              </button>
            </div>
            {onlineSource !== 'themealdb' && (
              <div className="recipe-source-note">
                <span>
                  {
                    RECIPE_PROVIDER_INFO.find((provider) => provider.id === onlineSource)
                      ?.freeAllowance
                  }
                </span>
                <button className="text-button" onClick={onConfigure}>
                  Set up recipe sources
                </button>
              </div>
            )}
            {onlineError && (
              <p className="recipe-source-error" role="alert">
                {onlineError}
              </p>
            )}
          </div>
          {providerResults && (
            <section
              className="provider-result-section"
              aria-label={`${RECIPE_PROVIDER_INFO.find((provider) => provider.id === providerResults.provider)?.name} search results`}
            >
              <div className="provider-results-heading">
                <div>
                  <h3>
                    From{' '}
                    {
                      RECIPE_PROVIDER_INFO.find(
                        (provider) => provider.id === providerResults.provider,
                      )?.name
                    }
                  </h3>
                  <p>
                    {providerResults.recipes.length}{' '}
                    {providerResults.recipes.length === 1 ? 'recipe' : 'recipes'} · Compared with
                    your kitchen
                  </p>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    cancelOnlineSearch();
                    setProviderResults(null);
                  }}
                >
                  Clear results
                </button>
              </div>
              {providerResults.warnings.map((warning) => (
                <p className="field-note" key={warning}>
                  {warning}
                </p>
              ))}
              <div className="recipe-grid">
                {providerMatches.map((item) =>
                  providerResults.storage === 'personal' ? (
                    <RecipeCard
                      key={item.recipe.id}
                      recipe={item.recipe}
                      inventory={relevant}
                      saved={saved.some((recipe) => recipe.id === item.recipe.id)}
                      onOpen={() => {
                        setDetail(item.recipe);
                        setDetailServings(item.recipe.servings ? String(item.recipe.servings) : '');
                      }}
                      onSave={() => openEditor(item.recipe)}
                    />
                  ) : (
                    <article className="recipe-discovery-card" key={item.recipe.id}>
                      <span className={`match-badge ${item.status}`}>{labels[item.status]}</span>
                      <h3>{item.recipe.title}</h3>
                      <p>
                        {item.missingCount
                          ? `${item.missingCount} ingredients short`
                          : `${item.matchedCount} ingredients on hand`}
                        {item.uncertainCount ? ' · Check amounts' : ''}
                      </p>
                      {item.recipe.source.attribution && (
                        <small>{item.recipe.source.attribution}</small>
                      )}
                      {safeLink(item.recipe.source.url) && (
                        <a
                          className="button secondary"
                          href={item.recipe.source.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open original recipe <ExternalLink size={16} />
                        </a>
                      )}
                    </article>
                  ),
                )}
              </div>
              {!providerResults.recipes.length && (
                <p className="settings-note">
                  No readable recipes found. Try another dish or ingredient.
                </p>
              )}
              {providerResults.hasMore && (
                <div className="library-more">
                  <button
                    className="button secondary"
                    disabled={onlineBusy}
                    onClick={() => {
                      void loadOnlineRecipes(true);
                    }}
                  >
                    {onlineBusy ? 'Searching…' : 'Next recipes from this source'}
                  </button>
                </div>
              )}
              {providerResults.provider === 'spoonacular' && (
                <a
                  className="field-note"
                  href="https://spoonacular.com/food-api"
                  target="_blank"
                  rel="noreferrer"
                >
                  Powered by Spoonacular · Temporary online discovery
                </a>
              )}
            </section>
          )}
          {libraryBusy && (
            <p role="status" className="settings-note">
              Opening your cookbook…
            </p>
          )}
          {libraryError && (
            <p role="alert" className="library-error">
              {libraryError}{' '}
              {!localCatalog.length && (
                <button
                  className="text-button"
                  onClick={() => {
                    void loadLibrary();
                  }}
                >
                  Retry cookbook
                </button>
              )}
            </p>
          )}
          <div className="library-results" role="status" aria-live="polite">
            <span>
              Showing {Math.min(visibleCount, matches.length).toLocaleString()} of{' '}
              {matches.length.toLocaleString()} recipes
              {submittedQuery ? ` for “${submittedQuery}”` : ''}
            </span>
            {(submittedQuery || category || cuisine || filter !== 'all') && (
              <button
                className="text-button"
                onClick={() => {
                  setQuery('');
                  setSubmittedQuery('');
                  setCategory('');
                  setCuisine('');
                  setFilter('all');
                  setVisibleCount(RECIPE_PAGE_SIZE);
                  onlineRequest.current++;
                  setOnlineBusy(false);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
          <div className="recipe-grid">
            {matches.slice(0, visibleCount).map((item) => (
              <RecipeCard
                key={item.recipe.id}
                recipe={item.recipe}
                inventory={relevant}
                saved={saved.some((r) => r.id === item.recipe.id)}
                onOpen={() => {
                  setDetail(item.recipe);
                  setDetailServings(item.recipe.servings ? String(item.recipe.servings) : '');
                }}
                onSave={() => openEditor(item.recipe)}
              />
            ))}
          </div>
          {visibleCount < matches.length && (
            <div className="library-more">
              <button
                className="button primary"
                onClick={() => setVisibleCount((count) => count + RECIPE_PAGE_SIZE)}
              >
                Load more recipes
              </button>
              <small>{(matches.length - visibleCount).toLocaleString()} more to explore</small>
            </div>
          )}
          {!libraryBusy && !matches.length && (
            <div className="empty-state compact">
              <BookOpen size={36} />
              <h2>
                {filter === 'saved' ? 'Your favorites start here.' : 'Let’s broaden the search.'}
              </h2>
              <p>
                {filter === 'saved'
                  ? 'Save something you like, import a recipe, or add your own.'
                  : 'Try a dish or ingredient name, clear the filters, or ask Gemini for a variation.'}
              </p>
              <button
                className="button secondary"
                onClick={() => {
                  setCategory('');
                  setCuisine('');
                  setFilter('all');
                  void loadLibrary(undefined, true);
                }}
              >
                Browse the cookbook
              </button>
            </div>
          )}
          <p className="footnote">
            Built-in recipes adapted from{' '}
            <a
              href="https://en.wikibooks.org/wiki/Cookbook:Table_of_Contents"
              target="_blank"
              rel="noreferrer"
            >
              Wikibooks contributors
            </a>{' '}
            under{' '}
            <a
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              target="_blank"
              rel="noreferrer"
            >
              CC BY-SA 4.0
            </a>
            . Additional recipes from{' '}
            <a href="https://www.themealdb.com" target="_blank" rel="noreferrer">
              TheMealDB
            </a>
            . Source links stay with saved recipes. Unknown amounts and yields stay flagged.
          </p>
        </>
      )}
      {page === 'shopping' && (
        <>
          <section className="quick-shopping">
            <div className="hub-section-title">
              <div>
                <h2>Quick add while you shop</h2>
                <p>Scan packaged foods or tap a familiar ingredient.</p>
              </div>
              <button className="button secondary" onClick={onScan}>
                <ScanLine size={18} />
                Scan
              </button>
            </div>
            <div className="quick-foods">
              {quickFoods.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    const product = inventory.products.find((p) => p.name === name);
                    const batch = inventory.batches.find((b) => b.productId === product?.id);
                    const unit = batch?.unit ?? 'each';
                    const countable = [
                      'each',
                      'piece',
                      'pieces',
                      'package',
                      'can',
                      'bottle',
                      'bag',
                      'packet',
                    ].includes(unit.toLowerCase());
                    onQuickAdd(name, countable ? 1 : null, unit);
                  }}
                >
                  <Plus size={16} />
                  {name}
                </button>
              ))}
            </div>
            <form
              className="hub-search"
              onSubmit={(e) => {
                e.preventDefault();
                if (shoppingName.trim()) onQuickAdd(shoppingName.trim());
              }}
            >
              <Autocomplete
                label="Quick-add ingredient"
                value={shoppingName}
                options={[...inventory.products.map((p) => p.name), ...FOOD_CATALOG]}
                onChange={setShoppingName}
                placeholder="Find produce or another ingredient…"
              />
              <button className="button primary" disabled={!shoppingName.trim()}>
                Add to inventory
              </button>
            </form>
          </section>
          <section className="plan-panel">
            <div className="hub-section-title">
              <div>
                <h2>Your meal plan</h2>
                <p>Choose recipes, set portions, then request your shopping list.</p>
              </div>
            </div>
            {!plan.length && (
              <p className="settings-note">
                Open a recipe and choose Add to meal plan to get started.
              </p>
            )}
            {plan.map((item) => {
              const recipe = saved.find((r) => r.id === item.recipeId);
              if (!recipe) return null;
              return (
                <div className="plan-row" key={item.recipeId}>
                  <strong>{recipe.title}</strong>
                  <label>
                    Servings
                    <input
                      aria-label={`Servings for ${recipe.title}`}
                      type="number"
                      min="0.1"
                      step="any"
                      value={item.servings ?? ''}
                      placeholder="Original"
                      disabled={!recipe.servings}
                      onChange={(e) => {
                        const servings = e.target.value === '' ? null : Number(e.target.value);
                        if (servings !== null && (!Number.isFinite(servings) || servings <= 0))
                          return;
                        void mutate((state) => ({
                          ...state,
                          mealPlan: (state.mealPlan ?? []).map((i) =>
                            i.recipeId === item.recipeId ? { ...i, servings } : i,
                          ),
                        })).catch(() => {});
                      }}
                    />
                  </label>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${recipe.title} from meal plan`}
                    onClick={() => {
                      void mutate((state) => ({
                        ...state,
                        mealPlan: (state.mealPlan ?? []).filter(
                          (i) => i.recipeId !== item.recipeId,
                        ),
                      })).catch(() => {});
                    }}
                  >
                    <X size={18} />
                  </button>
                  {!recipe.servings && (
                    <small>Set the original recipe yield to choose portions.</small>
                  )}
                </div>
              );
            })}
            <button
              className="button primary"
              disabled={!plan.length}
              onClick={() => {
                void generateShopping().catch(() => {});
              }}
            >
              <ShoppingCart size={17} />
              Make shopping list
            </button>
          </section>
          <section className="shopping-panel">
            <div className="hub-section-title">
              <h2>What to buy</h2>
              <span>{shopping.filter((item) => !item.checked).length} remaining</span>
            </div>
            <form
              className="hub-search"
              onSubmit={(e) => {
                e.preventDefault();
                const ingredient = parseIngredientLine(manualShoppingName);
                if (!ingredient.name.trim()) return;
                const item: ShoppingItem = {
                  id: crypto.randomUUID(),
                  name: ingredient.name,
                  quantity: ingredient.quantity,
                  unit: ingredient.unit,
                  checked: false,
                  status: ingredient.quantity === null ? 'check' : 'missing',
                };
                void mutate((state) => ({
                  ...state,
                  shoppingList: [...(state.shoppingList ?? []), item],
                }))
                  .then(() => setManualShoppingName(''))
                  .catch(() => {});
              }}
            >
              <input
                aria-label="Add shopping-list item"
                value={manualShoppingName}
                onChange={(e) => setManualShoppingName(e.target.value)}
                placeholder="e.g. 2 onions"
              />
              <button className="button secondary" disabled={!manualShoppingName.trim()}>
                Add to list
              </button>
            </form>
            {!shopping.length && (
              <p className="settings-note">
                Your shopping list appears when you request it. You can also add items above.
              </p>
            )}
            {shopping.map((item) => (
              <div className={`shopping-row ${item.checked ? 'checked' : ''}`} key={item.id}>
                <label className="checkbox-hit">
                  <input
                    type="checkbox"
                    aria-label={`Bought ${item.name}`}
                    checked={item.checked}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      void mutate((state) => ({
                        ...state,
                        shoppingList: (state.shoppingList ?? []).map((i) =>
                          i.id === item.id ? { ...i, checked } : i,
                        ),
                      })).catch(() => {});
                    }}
                  />
                </label>
                <div>
                  <strong>{item.name}</strong>
                  <small>
                    {item.status === 'check'
                      ? 'Check amount'
                      : formatQuantity(item.quantity, item.unit)}
                    {item.note ? ` · ${item.note}` : ''}
                  </small>
                </div>
                <button
                  className="button secondary small"
                  disabled={!!item.addedBatchId}
                  onClick={() => onQuickAdd(item.name, item.quantity, item.unit || 'each', item.id)}
                >
                  {item.addedBatchId ? 'Added' : 'Add purchase'}
                </button>
                <button
                  className="icon-button"
                  aria-label={`Remove ${item.name} from shopping list`}
                  onClick={() => {
                    void mutate((state) => ({
                      ...state,
                      shoppingList: (state.shoppingList ?? []).filter((i) => i.id !== item.id),
                    })).catch(() => {});
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
            {shopping.length > 0 && (
              <button
                className="text-button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(
                      shopping
                        .filter((i) => !i.checked)
                        .map(
                          (i) =>
                            `- ${i.name}: ${i.status === 'check' ? 'Check amount' : formatQuantity(i.quantity, i.unit)}`,
                        )
                        .join('\n'),
                    )
                    .then(() => onToast('Shopping list copied.'))
                    .catch(() =>
                      setError('Clipboard unavailable. You can still use your list here.'),
                    );
                }}
              >
                <Clipboard size={16} />
                Copy shopping list
              </button>
            )}
          </section>
        </>
      )}
      {page === 'assistant' && (
        <section className="assistant-panel">
          <div className="assistant-intro">
            <Sparkles size={28} />
            <h2>What would you like to cook?</h2>
            <p>
              Gemini can use your inventory and kitchen tools, then answer questions as you cook.
            </p>
          </div>
          <div className="hub-actions prompt-actions">
            {[
              'Make something with what I have',
              'Suggest meals using ingredients expiring soon',
              'Help me plan three meals',
            ].map((prompt) => (
              <button
                className="button secondary"
                key={prompt}
                disabled={aiBusy}
                onClick={() => {
                  void ask(prompt);
                }}
              >
                {prompt}
              </button>
            ))}
          </div>
          <div className="hub-preferences">
            {selectedBatchIds.length > 0 && (
              <label>
                <input
                  type="checkbox"
                  checked={useSelection}
                  onChange={(e) => setUseSelection(e.target.checked)}
                />
                Use only selected inventory
              </label>
            )}
            {chatRecipe && (
              <span>
                Recipe context: {chatRecipe.title}
                <button
                  className="text-button"
                  onClick={() => {
                    setDetail(chatRecipe);
                    setDetailServings(chatRecipe.servings ? String(chatRecipe.servings) : '');
                  }}
                >
                  View recipe
                </button>
                <button className="text-button" onClick={() => setChatRecipe(null)}>
                  Clear
                </button>
              </span>
            )}
            <button className="text-button" onClick={onConfigure}>
              Connection settings
            </button>
            {history.length > 0 && (
              <button
                className="text-button"
                disabled={aiBusy}
                onClick={() => setClearChatOpen(true)}
              >
                Clear conversation
              </button>
            )}
          </div>
          <div className="chat-history" aria-label="Gemini conversation">
            {history.map((item) => (
              <div key={item.id} className={`chat-message ${item.role}`}>
                <small>{item.role === 'user' ? 'YOU' : 'GEMINI'}</small>
                <p>{item.text}</p>
              </div>
            ))}
            {aiBusy && (
              <p role="status" className="settings-note">
                Gemini is thinking…
              </p>
            )}
            <div ref={endRef} />
          </div>
          {candidates.length > 0 && (
            <div className="recipe-grid ai-recipes">
              {candidates.map((recipe) => (
                <RecipeCard
                  key={recipe.id}
                  recipe={recipe}
                  inventory={relevant}
                  saved={saved.some((r) => r.id === recipe.id)}
                  onOpen={() => {
                    setDetail(recipe);
                    setDetailServings(recipe.servings ? String(recipe.servings) : '');
                  }}
                  onSave={() => openEditor(recipe)}
                />
              ))}
            </div>
          )}
          <form
            className="chat-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void ask();
            }}
          >
            <textarea
              aria-label="Message Gemini"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              placeholder="e.g. Something quick with chicken—and can I use my air fryer?"
              maxLength={6000}
            />
            <button className="button primary" disabled={aiBusy || !message.trim()}>
              {aiBusy ? 'Thinking…' : 'Ask Gemini'}
            </button>
          </form>
          {!readGeminiConnection() && (
            <p className="settings-note">
              Connect your free Gemini backend in Settings. Copy for Gemini on the inventory screen
              remains available.
            </p>
          )}
        </section>
      )}
      {error && (
        <p className="form-error hub-error" role="alert">
          {error}
        </p>
      )}
      <Modal
        open={!!detail}
        onClose={() => {
          setDetail(null);
          setAwake(false);
        }}
        title={detail?.title ?? 'Recipe'}
        description={detail ? (detail.source.name ?? sourceLabels[detail.source.type]) : ''}
        className="recipe-detail"
      >
        {detail && detailMatch && (
          <>
            <div className="hub-actions">
              <span className={`match-badge ${detailMatch.status}`}>
                {labels[detailMatch.status]}
              </span>
              <button
                className="button secondary"
                onClick={() => {
                  setDetail(null);
                  openEditor(detail);
                }}
              >
                Edit & save
              </button>
              <button
                className="button primary"
                onClick={() => {
                  void addToPlan(detail).catch(() => {});
                }}
              >
                {plan.some((item) => item.recipeId === detail.id)
                  ? 'Update meal plan'
                  : 'Add to meal plan'}
              </button>
            </div>
            {detail.servings ? (
              <label className="recipe-servings">
                Cooking for
                <input
                  type="number"
                  min="0.1"
                  step="any"
                  value={detailServings}
                  onChange={(e) => setDetailServings(e.target.value)}
                />
                servings
              </label>
            ) : (
              <p className="field-note">
                Original recipe quantities shown. Record the original yield before scaling portions.
              </p>
            )}
            <h3>Ingredients</h3>
            <ul className="recipe-ingredient-list">
              {detailMatch.ingredients.map((item, index) => (
                <li key={index}>
                  <span>
                    {item.ingredient.name}
                    <small>
                      {item.required === null
                        ? (item.ingredient.original ?? 'Amount not specified')
                        : formatQuantity(item.required, item.ingredient.unit)}
                    </small>
                    {detail.source.type === 'wikibooks' &&
                      item.required !== null &&
                      item.ingredient.original && (
                        <small>Original: {item.ingredient.original}</small>
                      )}
                  </span>
                  <span className={`ingredient-status ${item.status}`}>
                    {item.status === 'available'
                      ? 'On hand'
                      : item.status === 'check'
                        ? 'Check amount'
                        : item.shortage === null
                          ? 'Missing'
                          : `Need ${formatQuantity(item.shortage, item.ingredient.unit)}`}
                  </span>
                  {item.reason && <small>{item.reason}</small>}
                </li>
              ))}
            </ul>
            <h3>Let’s cook</h3>
            <label className="hub-preferences">
              <input type="checkbox" checked={awake} onChange={(e) => setAwake(e.target.checked)} />
              Keep screen awake while cooking
            </label>
            <ol className="recipe-steps">
              {detail.steps.map((step, index) => {
                const key = detail.id + ':' + index;
                const remaining =
                  timers[key] === undefined
                    ? null
                    : Math.max(0, Math.ceil((timers[key] - now) / 1000));
                return (
                  <li key={key}>
                    <p>{step}</p>
                    <div className="step-timer">
                      <label>
                        Timer
                        <input
                          aria-label={`Minutes for step ${index + 1}`}
                          type="number"
                          min="0.1"
                          step="any"
                          value={minutes[key] ?? ''}
                          placeholder="Minutes"
                          onChange={(e) => setMinutes({ ...minutes, [key]: e.target.value })}
                        />
                      </label>
                      <button
                        className="button secondary small"
                        disabled={!Number(minutes[key]) || Number(minutes[key]) <= 0}
                        onClick={() => {
                          const time = Date.now();
                          setNow(time);
                          setTimers({ ...timers, [key]: time + Number(minutes[key]) * 60000 });
                        }}
                      >
                        Start
                      </button>
                      {remaining !== null && (
                        <>
                          <span role="timer" aria-live={remaining === 0 ? 'polite' : 'off'}>
                            {remaining === 0
                              ? 'Timer finished'
                              : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`}
                          </span>
                          <button
                            className="text-button"
                            onClick={() =>
                              setTimers((current) => {
                                const next = { ...current };
                                delete next[key];
                                return next;
                              })
                            }
                          >
                            Clear
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
            {detailMatch.warnings.map((warning) => (
              <p className="field-note" key={warning}>
                {warning}
              </p>
            ))}
            {safeLink(detail.source.url) && (
              <a className="text-button" href={detail.source.url} target="_blank" rel="noreferrer">
                Original recipe source
              </a>
            )}
            {detail.source.attribution && (
              <p className="field-note recipe-attribution">{detail.source.attribution}</p>
            )}
            {safeLink(detail.source.licenseUrl) && (
              <a
                className="text-button"
                href={detail.source.licenseUrl}
                target="_blank"
                rel="noreferrer"
              >
                {detail.source.license ?? 'Recipe license'}
              </a>
            )}
            <button
              className="button primary full-width"
              onClick={() => {
                const servings =
                  detail.servings && detailServings ? Number(detailServings) : undefined;
                if (servings !== undefined && (!Number.isFinite(servings) || servings <= 0)) {
                  setError('Enter a positive number of servings.');
                  return;
                }
                setFinishing({ recipe: detail, ...(servings !== undefined ? { servings } : {}) });
                setDetail(null);
              }}
            >
              Finished cooking · review inventory
            </button>
            <button
              className="button secondary full-width"
              onClick={() => {
                setChatRecipe(detail);
                setDetail(null);
                onNavigate('assistant');
                onToast('Recipe attached. Ask Gemini your cooking question.');
              }}
            >
              <Sparkles size={17} />
              Use this recipe in Gemini
            </button>
          </>
        )}
      </Modal>
      <Modal
        open={importOpen}
        onClose={() => {
          if (!aiBusy) setImportOpen(false);
        }}
        title="Bring a recipe into Mise"
        description="Paste a recipe, add a website link, or attach an image or short video."
        className="recipe-import"
      >
        <div className="item-form">
          <label>
            Recipe website <span className="optional">optional</span>
            <input
              type="url"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              placeholder="https://…"
            />
          </label>
          <label>
            Recipe text
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={8}
              placeholder={
                'Recipe title\nServings: 2\nIngredients\n2 eggs\n1 tbsp butter\nSteps\nMelt the butter.\nCook the eggs.'
              }
            />
          </label>
          <label className="upload-label">
            <Upload size={17} />
            Screenshot or short video
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,video/mp4,video/webm"
              onChange={(e) => setMedia(e.target.files?.[0] ?? null)}
            />
          </label>
          {media && <p className="field-note">{media.name} · Up to 1 MB</p>}
          <p className="field-note">
            Website import uses published recipe data when available. Gemini extraction flags
            unclear quantities for review.
          </p>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="form-footer">
            <button
              className="button secondary"
              disabled={aiBusy || !importText.trim()}
              onClick={() => {
                void importRecipe(false);
              }}
            >
              Review pasted recipe
            </button>
            <button
              className="button primary"
              disabled={aiBusy || (!importText.trim() && !importUrl.trim() && !media)}
              onClick={() => {
                void importRecipe(true);
              }}
            >
              {aiBusy
                ? 'Extracting…'
                : importUrl && !media && !importText
                  ? 'Import website'
                  : 'Extract with Gemini'}
            </button>
          </div>
        </div>
      </Modal>
      {finishing && (
        <FinishCooking
          key={finishing.recipe.id}
          recipe={finishing.recipe}
          inventory={inventory}
          servings={finishing.servings}
          update={update}
          onClose={() => setFinishing(null)}
          onToast={onToast}
        />
      )}
      <Modal
        open={clearChatOpen}
        onClose={() => setClearChatOpen(false)}
        title="Clear conversation?"
        description="Saved recipes and kitchen data remain available."
      >
        <p className="settings-note">
          This removes the conversation and unsaved suggestions from this device.
        </p>
        <div className="form-footer">
          <button className="button secondary" onClick={() => setClearChatOpen(false)}>
            Keep conversation
          </button>
          <button
            className="button primary"
            onClick={() => {
              void mutate((state) => ({ ...state, chatHistory: [] }))
                .then(() => {
                  setClearChatOpen(false);
                  setCandidates([]);
                  setChatRecipe(null);
                })
                .catch(() => {});
            }}
          >
            Clear conversation
          </button>
        </div>
      </Modal>
      {editing && (
        <RecipeEditor
          key={editing.id}
          initial={editing}
          notes={editingNotes}
          onClose={() => {
            setEditing(null);
            setEditingNotes([]);
          }}
          onSave={(recipe) => saveRecipe(recipe, true)}
        />
      )}
    </div>
  );
}
