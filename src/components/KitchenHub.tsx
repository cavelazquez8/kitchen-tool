import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
} from 'lucide-react';
import type { InventoryState, ShoppingItem } from '../domain/types';
import type { InventoryReducer } from '../lib/repository';
import { generateMarkdown } from '../domain/export';
import { formatQuantity } from '../domain/inventory';
import { matchRecipe, buildShoppingList } from '../recipes/matching';
import { canPersistProviderRecipe } from '../recipes/providers';
import { isRecipe, type Recipe } from '../recipes/types';
import { loadLocalRecipes } from '../recipes/localLibrary';
import { recommendRecipes } from '../recipes/recommendations';
import { reviewedRecipeEstimate } from '../nutrition/recipeEstimate';
import { recipeNutritionKey } from '../nutrition/estimate';
import { parseChatRequest, type AiRecipeCandidate } from '../ai/protocol';
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
import { RecipeBrowser } from './RecipeBrowser';
import { RecipeDiscovery } from './RecipeDiscovery';
import { NutritionTargetsEditor } from './NutritionTargetsEditor';
import { RecipeNutrition } from './RecipeNutrition';
import './recipeProviders.css';
import './kitchenPolish.css';
import './recipeGuidance.css';

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
  const [error, setError] = useState('');
  const [useSelection, setUseSelection] = useState(false);
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [editingNotes, setEditingNotes] = useState<readonly string[]>([]);
  const [clearChatOpen, setClearChatOpen] = useState(false);
  const [detail, setDetail] = useState<Recipe | null>(null);
  const [recipeToDelete, setRecipeToDelete] = useState<Recipe | null>(null);
  const [deletingRecipe, setDeletingRecipe] = useState(false);
  const [recipeDeleteError, setRecipeDeleteError] = useState('');
  const deletionPending = useRef(false);
  const [detailServings, setDetailServings] = useState('');
  const [finishing, setFinishing] = useState<{ recipe: Recipe; servings?: number } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [media, setMedia] = useState<File | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [candidates, setCandidates] = useState<Recipe[]>([]);
  const [chatRecipes, setChatRecipes] = useState<Recipe[]>([]);
  const [library, setLibrary] = useState<Recipe[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState('');
  const [grounded, setGrounded] = useState(true);
  const [nutritionOpen, setNutritionOpen] = useState(false);
  const [clearShoppingOpen, setClearShoppingOpen] = useState(false);
  const [clearingShopping, setClearingShopping] = useState(false);
  const [clearShoppingError, setClearShoppingError] = useState('');
  const [shoppingName, setShoppingName] = useState('');
  const [manualShoppingName, setManualShoppingName] = useState('');
  const [timers, setTimers] = useState<Record<string, number>>({});
  const [minutes, setMinutes] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [awake, setAwake] = useState(false);
  const [savedReveal, setSavedReveal] = useState<Recipe | null>(null);
  const savedRevealHandled = useCallback(() => setSavedReveal(null), []);
  const endRef = useRef<HTMLDivElement>(null);
  const saved = useMemo(() => inventory.recipes ?? [], [inventory.recipes]);
  const plan = inventory.mealPlan ?? [];
  const shopping = inventory.shoppingList ?? [];
  const history = inventory.chatHistory ?? [];
  const relevant = useMemo(
    () =>
      useSelection && selectedBatchIds.length > 0
        ? {
            ...inventory,
            batches: inventory.batches.filter((batch) => selectedBatchIds.includes(batch.id)),
          }
        : inventory,
    [inventory, useSelection, selectedBatchIds],
  );
  useEffect(() => {
    let active = true;
    void loadLocalRecipes()
      .then((recipes) => {
        if (active) {
          setLibrary(recipes);
          setLibraryError('');
        }
      })
      .catch(() => {
        if (active)
          setLibraryError('The cookbook could not load. Saved recipes are still available.');
      })
      .finally(() => {
        if (active) setLibraryLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
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
    if (reveal) setSavedReveal(recipe);
  }

  async function deleteRecipe(recipe: Recipe) {
    if (deletionPending.current) return;
    deletionPending.current = true;
    setDeletingRecipe(true);
    setRecipeDeleteError('');
    setError('');
    try {
      await mutate((state) => {
        const savedRecipe = state.recipes?.find((item) => item.id === recipe.id);
        if (
          !savedRecipe ||
          savedRecipe.source.type !== recipe.source.type ||
          savedRecipe.title !== recipe.title ||
          !canPersistProviderRecipe(savedRecipe)
        )
          throw new Error(
            recipe.source.type === 'imported'
              ? 'This recipe is no longer a saved import. Close this review and try again.'
              : 'This saved recipe changed. Close this review and try again.',
          );
        return {
          ...state,
          recipes: (state.recipes ?? []).filter((item) => item.id !== recipe.id),
          ...(state.mealPlan
            ? { mealPlan: state.mealPlan.filter((item) => item.recipeId !== recipe.id) }
            : {}),
        };
      }, 'Recipe deleted.');
      setDetail((current) => (current?.id === recipe.id ? null : current));
      setSavedReveal((current) => (current?.id === recipe.id ? null : current));
      setChatRecipes((current) => current.filter((item) => item.id !== recipe.id));
      setCandidates((current) => current.filter((item) => item.id !== recipe.id));
      setAwake(false);
      setTimers((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.startsWith(`${recipe.id}:`)),
        ),
      );
      setMinutes((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([key]) => !key.startsWith(`${recipe.id}:`)),
        ),
      );
      setRecipeToDelete(null);
    } catch (error) {
      setRecipeDeleteError(
        error instanceof Error ? error.message : 'Could not delete this recipe.',
      );
    } finally {
      deletionPending.current = false;
      setDeletingRecipe(false);
    }
  }

  function openEditor(recipe: Recipe, notes: readonly string[] = []) {
    setEditingNotes(notes);
    setEditing(recipe);
  }
  function addToGemini(recipe: Recipe): boolean {
    if (!canPersistProviderRecipe(recipe)) {
      setError('Open the original website to use this temporary discovery recipe.');
      return false;
    }
    if (chatRecipes.some((item) => item.id === recipe.id)) return true;
    const next = [...chatRecipes, recipe];
    if (next.map(recipeContext).join('\n\n').length > 12000) {
      setError(
        'These recipes are too long to send together. Remove a recipe from Gemini context first.',
      );
      onToast('Gemini context is full. Remove a recipe to add another.');
      return false;
    }
    setChatRecipes(next);
    onToast('Recipe added to Gemini context.');
    return true;
  }
  function reviewReply(reply: AiReply) {
    const recipes = reply.recipes.map((draft) =>
      normalizeAiRecipe(draft, crypto.randomUUID(), { type: 'ai', name: 'Gemini' }),
    );
    if (recipes.length) {
      setCandidates(recipes);
      setChatRecipes((current) => (current.length ? current : [recipes[0]]));
    }
    return recipes;
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
      const availableLibrary =
        grounded && !chatRecipes.length && libraryLoading ? await loadLocalRecipes() : library;
      const retrieved =
        grounded && !chatRecipes.length
          ? recommendRecipes(
              [...saved, ...availableLibrary].filter(canPersistProviderRecipe),
              relevant,
              {
                query: `${history
                  .filter((item) => item.role === 'user')
                  .slice(-2)
                  .map((item) => item.text)
                  .join(' ')} ${prompt}`,
                limit: 12,
                fallbackToStarters: true,
              },
            )
          : [];
      const sourceRecipes = retrieved;
      const recipeCandidates: AiRecipeCandidate[] = [];
      for (const recipe of sourceRecipes) {
        if (recipe.ingredients.length > 60) continue;
        const match = matchRecipe(recipe, relevant);
        const mapping = inventory.recipeNutrition?.find((item) => item.recipeId === recipe.id);
        const nutrition = reviewedRecipeEstimate(recipe, mapping);
        const candidate: AiRecipeCandidate = {
          id: recipe.id,
          title: recipe.title,
          servings: recipe.servings,
          ingredients: recipe.ingredients.map((item) =>
            (item.original ?? `${item.quantity ?? 'Unspecified'} ${item.unit} ${item.name}`).slice(
              0,
              400,
            ),
          ),
          missingIngredients: match.ingredients
            .filter((item) => item.status !== 'available')
            .map(
              (item) =>
                `${item.ingredient.name}${item.status === 'check' ? ' (check amount)' : ''}`,
            ),
          source: (recipe.source.name ?? sourceLabels[recipe.source.type]).slice(0, 300),
          ...(nutrition?.perServing
            ? { nutrition: { perServing: nutrition.perServing, complete: nutrition.complete } }
            : {}),
        };
        if (
          parseChatRequest({
            message: 'Recipe recommendation',
            inventory: '',
            candidates: [candidate],
          }) &&
          JSON.stringify([...recipeCandidates, candidate]).length <= 24000
        )
          recipeCandidates.push(candidate);
      }
      if (grounded && !chatRecipes.length && !recipeCandidates.length) {
        throw new Error(
          libraryLoading
            ? 'The cookbook is still opening. Try again in a moment.'
            : 'No cookbook recipes are available for this request. Try a simpler description, browse recipes, or choose Create with my inventory.',
        );
      }
      let attachedContext = chatRecipes.map(recipeContext).join('\n\n');
      if (attachedContext.length > 12000)
        throw new Error(
          'Remove a recipe from Gemini context before sending these recipes together.',
        );
      for (const recipe of chatRecipes) {
        const estimate = reviewedRecipeEstimate(
          recipe,
          inventory.recipeNutrition?.find((item) => item.recipeId === recipe.id),
        );
        const note = `\n${recipe.title} · Reviewed nutrition: ${JSON.stringify(estimate ? { perServing: estimate.perServing, complete: estimate.complete } : { recorded: false })}`;
        if (attachedContext.length + note.length <= 12000) attachedContext += note;
      }
      await mutate((state) => ({
        ...state,
        chatHistory: [...(state.chatHistory ?? []), user].slice(-80),
      }));
      setMessage('');
      const reply = await sendGeminiChat(connection, {
        message: prompt.trim(),
        inventory: boundedInventoryContext(generateMarkdown(relevant, { includeTools: true })),
        ...(attachedContext ? { recipe: attachedContext } : {}),
        ...(recipeCandidates.length ? { candidates: recipeCandidates } : {}),
        ...(inventory.nutritionTargets ? { nutritionTargets: inventory.nutritionTargets } : {}),
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
      if (reply.recommendedRecipeIds) {
        setCandidates(
          reply.recommendedRecipeIds.flatMap((id) => {
            const recipe = sourceRecipes.find((item) => item.id === id);
            return recipe ? [recipe] : [];
          }),
        );
      }
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
  return (
    <div className="kitchen-hub">
      {page === 'recipes' && (
        <>
          <RecipeDiscovery
            recipes={library}
            inventory={relevant}
            loading={libraryLoading}
            error={libraryError}
            onOpen={(recipe) => {
              setDetail(recipe);
              setDetailServings(recipe.servings ? String(recipe.servings) : '');
            }}
            onChoose={() => {
              setGrounded(true);
              onNavigate('assistant');
            }}
          />
          <RecipeBrowser
            inventory={inventory}
            relevant={relevant}
            selectedBatchIds={selectedBatchIds}
            useSelection={useSelection}
            onUseSelectionChange={setUseSelection}
            onOpen={(recipe) => {
              setDetail(recipe);
              setDetailServings(recipe.servings ? String(recipe.servings) : '');
            }}
            onSave={(recipe) => openEditor(recipe)}
            onRemoveSaved={(recipe) => {
              setRecipeDeleteError('');
              setRecipeToDelete(recipe);
            }}
            onAddToGemini={addToGemini}
            geminiRecipeIds={chatRecipes.map((recipe) => recipe.id)}
            onImport={() => {
              setImportText('');
              setImportUrl('');
              setMedia(null);
              setImportOpen(true);
            }}
            onNew={() => openEditor(blankRecipe())}
            onConfigure={onConfigure}
            savedReveal={savedReveal}
            onSavedRevealHandled={savedRevealHandled}
          />
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
            . Source links and attribution stay with saved recipes. Unknown amounts and yields stay
            flagged.
          </p>
        </>
      )}
      {page === 'shopping' && (
        <>
          <section className="quick-shopping">
            <div className="hub-section-title">
              <div>
                <h2>Quick add while you shop</h2>
                <p>Scan packaged foods or search for an ingredient.</p>
              </div>
              <button className="button secondary" onClick={onScan}>
                <ScanLine size={18} />
                Scan
              </button>
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
              <div className="shopping-list-actions">
                <span>{shopping.filter((item) => !item.checked).length} remaining</span>
                {shopping.length > 0 && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setClearShoppingError('');
                      setClearShoppingOpen(true);
                    }}
                  >
                    Clear all
                  </button>
                )}
              </div>
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
            <p>Choose an established recipe, see what to buy, and ask questions as you cook.</p>
          </div>
          <div className="hub-actions prompt-actions">
            {[
              {
                label: 'Help me choose dinner',
                prompt: 'Help me choose a familiar dinner. Ask me a question if you need to.',
              },
              {
                label: 'Use ingredients expiring soon',
                prompt: 'Find cookbook meals that use ingredients expiring soon',
              },
              { label: 'Plan three meals', prompt: 'Help me choose three meals to prep' },
            ].map(({ label, prompt }) => (
              <button
                className="button secondary"
                key={prompt}
                disabled={aiBusy}
                onClick={() => {
                  void ask(prompt);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="guided-options">
            <label>
              <input
                type="radio"
                name="recipe-guidance-mode"
                checked={grounded}
                onChange={() => setGrounded(true)}
              />{' '}
              Choose from the cookbook
            </label>
            <label>
              <input
                type="radio"
                name="recipe-guidance-mode"
                checked={!grounded}
                onChange={() => setGrounded(false)}
              />{' '}
              Create with my inventory
            </label>
            <button className="text-button" onClick={() => setNutritionOpen(true)}>
              {inventory.nutritionTargets ? 'Edit nutrition targets' : 'Add nutrition targets'}
            </button>
          </div>
          {inventory.nutritionTargets && (
            <p className="nutrition-summary">
              Daily targets ·{' '}
              {[
                inventory.nutritionTargets.caloriesKcal !== null
                  ? `${inventory.nutritionTargets.caloriesKcal} kcal`
                  : '',
                inventory.nutritionTargets.proteinGrams !== null
                  ? `${inventory.nutritionTargets.proteinGrams} g protein`
                  : '',
                inventory.nutritionTargets.carbsGrams !== null
                  ? `${inventory.nutritionTargets.carbsGrams} g carbs`
                  : '',
                inventory.nutritionTargets.fatGrams !== null
                  ? `${inventory.nutritionTargets.fatGrams} g fat`
                  : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'No values entered'}
            </p>
          )}
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
          {chatRecipes.length > 0 && (
            <section className="gemini-recipe-context" aria-label="Gemini recipe context">
              <div className="hub-section-title">
                <h3>Recipes in context · {chatRecipes.length}</h3>
                <button className="text-button" onClick={() => setChatRecipes([])}>
                  Clear recipes
                </button>
              </div>
              {chatRecipes.map((recipe) => (
                <div className="gemini-context-row" key={recipe.id}>
                  <button
                    className="text-button"
                    onClick={() => {
                      setDetail(recipe);
                      setDetailServings(recipe.servings ? String(recipe.servings) : '');
                    }}
                  >
                    {recipe.title}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Remove ${recipe.title} from Gemini context`}
                    onClick={() =>
                      setChatRecipes((current) => current.filter((item) => item.id !== recipe.id))
                    }
                  >
                    <X size={17} />
                  </button>
                </div>
              ))}
            </section>
          )}
          <div className="chat-history" aria-label="Gemini conversation">
            {history.map((item) => (
              <div key={item.id} className={`chat-message ${item.role}`}>
                <small>{item.role === 'user' ? 'YOU' : 'GEMINI'}</small>
                <p>{item.text}</p>
              </div>
            ))}
            {aiBusy && (
              <p role="status" className="settings-note">
                {libraryLoading && grounded && !chatRecipes.length
                  ? 'Opening the cookbook…'
                  : 'Gemini is thinking…'}
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
                  onSave={() => {
                    if (recipe.source.type === 'ai') openEditor(recipe);
                    else void saveRecipe(recipe).catch(() => {});
                  }}
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
          {grounded && !chatRecipes.length && (
            <p className="field-note">
              Mise searches the cookbook on your device and sends Gemini a shortlist.
              Recommendations keep the source recipe intact; you can buy what’s missing. Nutrition
              is used only when it has been reviewed.
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
              <button
                className="button secondary"
                disabled={chatRecipes.some((recipe) => recipe.id === detail.id)}
                onClick={() => addToGemini(detail)}
              >
                <Sparkles size={17} />
                {chatRecipes.some((recipe) => recipe.id === detail.id)
                  ? 'Added to Gemini'
                  : 'Add to Gemini'}
              </button>
            </div>
            {canPersistProviderRecipe(detail) &&
              saved.some((recipe) => recipe.id === detail.id) && (
                <button
                  className="button destructive full-width"
                  onClick={() => {
                    setRecipeDeleteError('');
                    setRecipeToDelete(detail);
                  }}
                >
                  <Trash2 size={17} />
                  {detail.source.type === 'imported' ? 'Delete recipe' : 'Remove saved recipe'}
                </button>
              )}
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
            <RecipeNutrition
              key={detail.id + recipeNutritionKey(detail)}
              recipe={detail}
              mapping={inventory.recipeNutrition?.find((item) => item.recipeId === detail.id)}
              onSave={async (mapping) => {
                await mutate(
                  (state) => ({
                    ...state,
                    recipeNutrition: [
                      ...(state.recipeNutrition ?? []).filter(
                        (item) => item.recipeId !== detail.id,
                      ),
                      { recipeId: detail.id, ...mapping },
                    ],
                  }),
                  'Nutrition estimate saved.',
                );
              }}
              onConfigure={onConfigure}
            />
            <button
              className="text-button"
              onClick={() => {
                if (!addToGemini(detail)) return;
                setMessage(
                  'Help me choose servings of this recipe using my reviewed nutrition targets and recipe nutrition. Ask what share of my daily targets I want for this meal if needed. Keep the original recipe intact and tell me if information is missing.',
                );
                setDetail(null);
                onNavigate('assistant');
              }}
            >
              <Sparkles size={16} /> Ask Gemini about portions
            </button>
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
                if (!addToGemini(detail)) return;
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
      {nutritionOpen && (
        <NutritionTargetsEditor
          targets={inventory.nutritionTargets}
          onClose={() => setNutritionOpen(false)}
          onConfigure={onConfigure}
          onSave={async (nutritionTargets) => {
            await mutate(
              (state) => ({ ...state, nutritionTargets }),
              'Daily nutrition targets saved.',
            );
          }}
        />
      )}
      <Modal
        open={!!recipeToDelete}
        onClose={() => {
          if (!deletionPending.current) setRecipeToDelete(null);
        }}
        title={
          recipeToDelete
            ? recipeToDelete.source.type === 'imported'
              ? `Delete “${recipeToDelete.title}”?`
              : `Remove “${recipeToDelete.title}” from saved recipes?`
            : 'Remove recipe?'
        }
        description={
          recipeToDelete && plan.some((item) => item.recipeId === recipeToDelete.id)
            ? 'This removes the saved recipe from your library and meal plan.'
            : 'This removes the saved recipe from your library.'
        }
      >
        {recipeDeleteError && (
          <p className="form-error" role="alert">
            {recipeDeleteError}
          </p>
        )}
        <div className="form-footer">
          <button
            className="button secondary"
            disabled={deletingRecipe}
            onClick={() => setRecipeToDelete(null)}
          >
            Keep recipe
          </button>
          <button
            className="button destructive"
            disabled={deletingRecipe}
            onClick={() => {
              if (recipeToDelete) void deleteRecipe(recipeToDelete);
            }}
          >
            {deletingRecipe
              ? 'Removing…'
              : recipeToDelete?.source.type === 'imported'
                ? 'Delete recipe'
                : 'Remove recipe'}
          </button>
        </div>
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
                  setChatRecipes([]);
                })
                .catch(() => {});
            }}
          >
            Clear conversation
          </button>
        </div>
      </Modal>
      <Modal
        open={clearShoppingOpen}
        onClose={() => {
          if (!clearingShopping) setClearShoppingOpen(false);
        }}
        title="Clear shopping list?"
        description={`Remove all ${shopping.length} items, including checked items, from What to buy.`}
      >
        {clearShoppingError && (
          <p className="form-error" role="alert">
            {clearShoppingError}
          </p>
        )}
        <div className="form-footer">
          <button
            className="button secondary"
            disabled={clearingShopping}
            onClick={() => setClearShoppingOpen(false)}
          >
            Keep list
          </button>
          <button
            className="button destructive"
            disabled={clearingShopping}
            onClick={() => {
              setClearingShopping(true);
              void mutate((state) => ({ ...state, shoppingList: [] }), 'Shopping list cleared.')
                .then(() => setClearShoppingOpen(false))
                .catch((error) =>
                  setClearShoppingError(
                    error instanceof Error ? error.message : 'Could not clear the list.',
                  ),
                )
                .finally(() => setClearingShopping(false));
            }}
          >
            {clearingShopping ? 'Clearing…' : 'Clear all items'}
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
