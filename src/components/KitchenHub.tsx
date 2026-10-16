import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
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
  ArrowUp,
  ChefHat,
  Clock3,
  SlidersHorizontal,
  PackageCheck,
  ChevronDown,
  Globe,
  BookOpen,
} from 'lucide-react';
import type { InventoryState, ShoppingItem } from '../domain/types';
import type { InventoryReducer } from '../lib/repository';
import { formatQuantity } from '../domain/inventory';
import { matchRecipe, buildShoppingList } from '../recipes/matching';
import { canPersistProviderRecipe } from '../recipes/providers';
import { isRecipe, type Recipe } from '../recipes/types';
import { loadLocalRecipes } from '../recipes/localLibrary';
import { recommendRecipes } from '../recipes/recommendations';
import { reviewedRecipeEstimate } from '../nutrition/recipeEstimate';
import { recipeNutritionKey } from '../nutrition/estimate';
import { parseChatRequest, type AiRecipeCandidate } from '../ai/protocol';
import { bodyScanContext } from '../profile/context';
import {
  ASSISTANT_RECIPE_MODES,
  assistantRecipePool,
  assistantRequestRecipeSources,
} from '../ai/conversationSources';
import {
  assistantInventory,
  assistantInventoryContextForSession,
  assistantInventoryMarkdown,
} from '../ai/inventoryContext';
import {
  emptyAssistantSession,
  conversationRecipes,
  updateAssistantSession,
  beginAssistantRequest,
  getAssistantActivity,
  subscribeAssistantActivity,
} from '../ai/conversation';
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
import { ConversationText } from './ConversationText';
import { InventoryContextPicker } from './InventoryContextPicker';
import { RecipeServingsControl } from './RecipeServingsControl';
import { validRecipeServings } from '../recipes/servings';
import './recipeProviders.css';
import './kitchenPolish.css';
import './recipeGuidance.css';
import './assistantExperience.css';

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
  onProfile?: () => void;
  attachedBodyScanIds?: string[];
  onBodyScanAttachmentsChange?: (ids: string[]) => void;
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
function NutritionDisclosure({ publisher, children }: { publisher: boolean; children: ReactNode }) {
  return publisher ? (
    <>{children}</>
  ) : (
    <details className="recipe-nutrition-review">
      <summary>Review nutrition and portion estimates</summary>
      {children}
    </details>
  );
}
function RecipeCard({
  recipe,
  inventory,
  onOpen,
  onSave,
  saved,
  onDiscuss,
}: {
  recipe: Recipe;
  inventory: InventoryState;
  onOpen: () => void;
  onSave: () => void;
  saved: boolean;
  onDiscuss?: () => void;
}) {
  const match = matchRecipe(recipe, inventory);
  const [imageFailed, setImageFailed] = useState(false);
  const duration =
    recipe.totalMinutes ??
    (recipe.prepMinutes !== undefined && recipe.cookMinutes !== undefined
      ? recipe.prepMinutes + recipe.cookMinutes
      : undefined);
  return (
    <article className="recipe-card">
      {recipe.imageUrl && safeLink(recipe.imageUrl) && !imageFailed && (
        <img src={recipe.imageUrl} alt="" loading="lazy" onError={() => setImageFailed(true)} />
      )}
      {(!safeLink(recipe.imageUrl) || imageFailed) && (
        <div className="recipe-art" aria-hidden="true">
          <Utensils size={30} strokeWidth={1.3} />
          <span>{recipe.category ?? recipe.source.name ?? 'Your recipe'}</span>
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
        {duration !== undefined && (
          <small className="assistant-recipe-time">
            <Clock3 size={14} /> {duration} minutes
          </small>
        )}
        {recipe.author && <small>By {recipe.author}</small>}
        <div className="hub-actions">
          <button className="button secondary" onClick={onOpen}>
            Choose recipe
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
        {onDiscuss && (
          <button className="text-button assistant-recipe-question" onClick={onDiscuss}>
            Ask about this recipe
          </button>
        )}
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
  onProfile,
  attachedBodyScanIds = [],
  onBodyScanAttachmentsChange,
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
  const [operationBusy, setAiBusy] = useState(false);
  const activity = useSyncExternalStore(subscribeAssistantActivity, getAssistantActivity);
  const aiBusy = operationBusy || activity.busy;
  const previousActivity = useRef(activity);
  const [message, setMessage] = useState(inventory.assistantSession?.draft ?? '');
  const candidates = useMemo(
    () => inventory.assistantSession?.recipes ?? [],
    [inventory.assistantSession?.recipes],
  );
  const [chatRecipes, setChatRecipes] = useState<Recipe[]>(
    inventory.assistantSession?.attachedRecipes ?? [],
  );
  const [library, setLibrary] = useState<Recipe[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState('');
  const conversationMode = inventory.assistantSession?.mode ?? 'discover';
  const [modeSaving, setModeSaving] = useState(false);
  const recipeMode = ASSISTANT_RECIPE_MODES.find((mode) => mode.value === conversationMode)!;
  const RecipeSourceIcon =
    conversationMode === 'discover' ? Globe : conversationMode === 'library' ? BookOpen : Sparkles;
  const [conversationOptionsOpen, setConversationOptionsOpen] = useState(false);
  const [inventoryContextOpen, setInventoryContextOpen] = useState(false);
  const grounded = conversationMode === 'library';
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
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const saved = useMemo(() => inventory.recipes ?? [], [inventory.recipes]);
  const plan = inventory.mealPlan ?? [];
  const shopping = inventory.shoppingList ?? [];
  const history = inventory.chatHistory ?? [];
  const inventoryContext = useMemo(
    () => assistantInventoryContextForSession(inventory.assistantSession),
    [inventory.assistantSession],
  );
  const chatInventory = useMemo(
    () => assistantInventory(inventory, inventoryContext),
    [inventory, inventoryContext],
  );
  const selectedIngredientCount = useMemo(
    () => new Set(chatInventory.batches.map((batch) => batch.productId)).size,
    [chatInventory.batches],
  );
  const inventoryContextLabel =
    inventoryContext.mode === 'all'
      ? 'All inventory'
      : inventoryContext.mode === 'none'
        ? 'No inventory'
        : `${selectedIngredientCount} ingredient${selectedIngredientCount === 1 ? '' : 's'}`;
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
    const previous = previousActivity.current;
    if (previous.busy && !activity.busy) {
      if (!message || message.trim() === previous.prompt)
        setMessage(inventory.assistantSession?.draft ?? '');
      setChatRecipes(inventory.assistantSession?.attachedRecipes ?? []);
      if (activity.error) setError(activity.error);
    }
    previousActivity.current = activity;
  }, [activity, message, inventory.assistantSession]);
  useEffect(() => {
    if (aiBusy || message === (inventory.assistantSession?.draft ?? '')) return;
    const timer = window.setTimeout(() => {
      void update((state) => updateAssistantSession(state, { draft: message })).catch(() => {
        setError(
          'Your message could not be saved on this device. Keep this screen open and try again.',
        );
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [message, inventory.assistantSession?.draft, update, aiBusy]);
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
    endRef.current?.scrollIntoView?.({ block: 'nearest' });
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
  function setMode(mode: 'discover' | 'create' | 'library') {
    if (mode === conversationMode || aiBusy || modeSaving) return;
    setModeSaving(true);
    void mutate((state) => updateAssistantSession(state, { mode, recipes: [], recipesMode: mode }))
      .then(() => {
        setConversationOptionsOpen(false);
      })
      .catch(() => {})
      .finally(() => setModeSaving(false));
  }
  function setAttachedRecipes(recipes: Recipe[]) {
    const next = conversationRecipes(recipes);
    setChatRecipes(next);
    void mutate((state) => updateAssistantSession(state, { attachedRecipes: next })).catch(
      () => {},
    );
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
        const next = {
          ...state,
          recipes: (state.recipes ?? []).filter((item) => item.id !== recipe.id),
          ...(state.mealPlan
            ? { mealPlan: state.mealPlan.filter((item) => item.recipeId !== recipe.id) }
            : {}),
        };
        return state.assistantSession
          ? updateAssistantSession(next, {
              recipes: (state.assistantSession?.recipes ?? []).filter(
                (item) => item.id !== recipe.id,
              ),
              attachedRecipes: (state.assistantSession?.attachedRecipes ?? []).filter(
                (item) => item.id !== recipe.id,
              ),
            })
          : next;
      }, 'Recipe deleted.');
      setDetail((current) => (current?.id === recipe.id ? null : current));
      setSavedReveal((current) => (current?.id === recipe.id ? null : current));
      setChatRecipes((current) => current.filter((item) => item.id !== recipe.id));
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
    setAttachedRecipes(next);
    onToast('Recipe added to Gemini context.');
    return true;
  }
  function reviewReply(reply: AiReply) {
    const recipes = reply.recipes.map((draft) =>
      normalizeAiRecipe(draft, crypto.randomUUID(), { type: 'ai', name: 'Gemini' }),
    );
    return recipes;
  }
  async function ask(prompt = message) {
    if (!prompt.trim() || aiBusy || modeSaving) return;
    const connection = readGeminiConnection();
    if (!connection) {
      onConfigure();
      return;
    }
    const finishRequest = beginAssistantRequest(prompt.trim());
    if (!finishRequest) return;
    let requestError: string | undefined;
    setAiBusy(true);
    setError('');
    setMessage('');
    const previousTurn = history.at(-1);
    const user = {
      id:
        previousTurn?.role === 'user' && previousTurn.text === prompt.trim()
          ? previousTurn.id
          : crypto.randomUUID(),
      role: 'user' as const,
      text: prompt.trim(),
    };
    try {
      await mutate((state) => ({
        ...updateAssistantSession(state, { draft: '' }),
        chatHistory: (state.chatHistory?.at(-1)?.role === 'user' &&
        state.chatHistory.at(-1)?.text === user.text
          ? state.chatHistory
          : [...(state.chatHistory ?? []), user]
        ).slice(-80),
      }));
      const availableLibrary =
        grounded && libraryLoading
          ? await loadLocalRecipes().catch((reason) => {
              if (!saved.length && !chatRecipes.length && !candidates.length) throw reason;
              setError(
                'The built-in cookbook could not load. Using your saved and attached recipes.',
              );
              return library;
            })
          : library;
      const retrieved = grounded
        ? recommendRecipes(
            assistantRecipePool(conversationMode, saved, availableLibrary),
            chatInventory,
            {
              query: `${history
                .filter((item) => item.role === 'user')
                .slice(-2)
                .map((item) => item.text)
                .join(' ')} ${prompt}`,
              limit: 12,
              fallbackToStarters: grounded,
              includeAiRecipes: true,
            },
          )
        : [];
      const sources = assistantRequestRecipeSources(conversationMode, {
        retrievedRecipes: retrieved,
        previousRecipes:
          inventory.assistantSession?.recipesMode === conversationMode ? candidates : [],
        attachedRecipes: chatRecipes,
      });
      const sourceRecipes = sources.candidateRecipes;
      const recipeCandidates: AiRecipeCandidate[] = [];
      for (const recipe of sourceRecipes) {
        if (recipe.ingredients.length > 60) continue;
        const match = matchRecipe(recipe, chatInventory);
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
          missingIngredients:
            inventoryContext.mode === 'all'
              ? match.ingredients
                  .filter((item) => item.status !== 'available')
                  .map(
                    (item) =>
                      `${item.ingredient.name}${item.status === 'check' ? ' (check amount)' : ''}`,
                  )
              : [],
          source: ((recipe.source.url?.length ?? 301) <= 300
            ? recipe.source.url!
            : (recipe.source.name ?? sourceLabels[recipe.source.type])
          ).slice(0, 300),
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
      if (grounded && !recipeCandidates.length) {
        throw new Error(
          libraryLoading
            ? 'The cookbook is still opening. Try again in a moment.'
            : 'No cookbook recipes are available for this request. Try a simpler description, browse recipes, or choose Search the web.',
        );
      }
      let attachedContext = chatRecipes.map(recipeContext).join('\n\n');
      if (!chatRecipes.length && sources.contextRecipes.length) {
        for (const recipe of sources.contextRecipes.slice(0, 3)) {
          const context = recipeContext(recipe);
          if (attachedContext.length + context.length + 2 <= 12000)
            attachedContext += (attachedContext ? '\n\n' : '') + context;
        }
      }
      const profile = bodyScanContext(inventory.bodyScans ?? [], attachedBodyScanIds);
      if (attachedContext.length > 12000)
        throw new Error(
          'Remove a recipe from Gemini context before sending these recipes together.',
        );
      for (const recipe of chatRecipes) {
        const estimate = reviewedRecipeEstimate(
          recipe,
          inventory.recipeNutrition?.find((item) => item.recipeId === recipe.id),
        );
        const note = `\n${recipe.title} · Reviewed nutrition: ${JSON.stringify(estimate ? { totals: estimate.totals, perServing: estimate.perServing, complete: estimate.complete } : { recorded: false })}`;
        if (attachedContext.length + note.length <= 12000) attachedContext += note;
      }
      const request = parseChatRequest({
        message: prompt.trim(),
        inventory: boundedInventoryContext(assistantInventoryMarkdown(inventory, inventoryContext)),
        ...(attachedContext ? { recipe: attachedContext } : {}),
        ...(recipeCandidates.length ? { candidates: recipeCandidates } : {}),
        ...(sources.discover ? { discover: true } : {}),
        ...(inventory.nutritionTargets ? { nutritionTargets: inventory.nutritionTargets } : {}),
        ...(profile ? { profile } : {}),
        ...(connection.model ? { model: connection.model } : {}),
        ...(connection.modelReviewed ? { modelReviewed: true } : {}),
        history: boundedChatHistory(
          history.at(-1)?.role === 'user' && history.at(-1)?.text === prompt.trim()
            ? history.slice(0, -1)
            : history,
        ),
      });
      if (!request)
        throw new Error(
          'This conversation has too much context. Remove a recipe or body scan, or shorten your message.',
        );
      const reply = await sendGeminiChat(connection, request);
      const assistant = {
        id: crypto.randomUUID(),
        role: 'assistant' as const,
        text:
          reply.message.trim() ||
          (reply.recipes.length
            ? 'Here are recipes to review below.'
            : 'No answer was returned. Try a shorter question.'),
      };
      const originals = conversationRecipes([...(reply.sourceRecipes ?? []), ...sourceRecipes]);
      const recommendations = reply.recommendedRecipeIds?.length
        ? reply.recommendedRecipeIds.flatMap((id) => originals.find((item) => item.id === id) ?? [])
        : (reply.sourceRecipes ?? []);
      const proposed = conversationRecipes([...recommendations, ...reviewReply(reply)]);
      await mutate((state) => {
        if (!state.chatHistory?.some((turn) => turn.id === user.id))
          throw new Error(
            'This conversation changed while Gemini was replying. Your current kitchen has been kept.',
          );
        return {
          ...updateAssistantSession(state, {
            ...(proposed.length && (state.assistantSession?.mode ?? 'discover') === conversationMode
              ? { recipes: proposed, recipesMode: conversationMode }
              : {}),
          }),
          chatHistory: [...(state.chatHistory ?? []), assistant].slice(-80),
        };
      });
      if (reply.warnings.length) setError(reply.warnings.join(' '));
    } catch (e) {
      requestError =
        e instanceof Error
          ? e.message
          : 'Gemini is unavailable. Copy your inventory to continue externally.';
      setError(requestError);
      setMessage((current) => current || prompt.trim());
      await update((state) =>
        state.assistantSession?.draft
          ? state
          : updateAssistantSession(state, { draft: prompt.trim() }),
      ).catch(() => {});
    } finally {
      setAiBusy(false);
      finishRequest(requestError);
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
  async function chooseAndShop(recipe: Recipe) {
    if (!canPersistProviderRecipe(recipe))
      throw new Error('Open the original source to use this recipe.');
    const servings = recipe.servings
      ? detailServings.trim()
        ? Number(detailServings)
        : recipe.servings
      : null;
    if (servings !== null && (!Number.isFinite(servings) || servings <= 0)) {
      setError('Enter a positive number of servings.');
      return;
    }
    const requestId = crypto.randomUUID();
    await mutate((state) => {
      const recipes = [...(state.recipes ?? []).filter((item) => item.id !== recipe.id), recipe];
      const mealPlan = [
        ...(state.mealPlan ?? []).filter((item) => item.recipeId !== recipe.id),
        { recipeId: recipe.id, servings },
      ];
      const result = buildShoppingList(
        mealPlan.flatMap((item) => {
          const planned = recipes.find((entry) => entry.id === item.recipeId);
          return planned
            ? [{ recipe: planned, ...(item.servings !== null ? { servings: item.servings } : {}) }]
            : [];
        }),
        state,
      );
      return {
        ...state,
        recipes,
        mealPlan,
        shoppingList: [
          ...(state.shoppingList ?? []).filter(
            (item) => !item.checked && !item.id.startsWith('recipe:'),
          ),
          ...result.items.map((item, index) => ({
            id: `recipe:${requestId}:${index}`,
            name: item.name,
            quantity: item.quantity,
            unit: item.unit,
            status: item.status,
            checked: false,
            ...(item.reason ? { note: item.reason } : {}),
          })),
        ],
      };
    }, 'Recipe chosen. Your shopping list is ready.');
    setError('');
    setDetail(null);
    setAwake(false);
    onNavigate('shopping');
  }
  const detailMatch = detail
    ? matchRecipe(detail, relevant, {
        ...(detail.servings ? { servings: Number(detailServings) } : {}),
      })
    : null;
  const invalidDetailServings = !!detail?.servings && !validRecipeServings(detailServings);
  return (
    <div className="kitchen-hub">
      {page === 'recipes' && (
        <>
          <section className="recipe-assistant-entry">
            <div>
              <span className="eyebrow">FIND YOUR NEXT MEAL</span>
              <h2>Cook something you’ll enjoy.</h2>
              <p>Ask Gemini for real recipes, discuss your options, and make a shopping list.</p>
            </div>
            <button
              className="button primary"
              onClick={() => {
                onNavigate('assistant');
              }}
            >
              <Sparkles size={18} />
              Help me choose
            </button>
          </section>
          <details className="community-cookbook">
            <summary>Explore the community cookbook</summary>
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
                onNavigate('assistant');
              }}
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
              . Source links and attribution stay with saved recipes. Unknown amounts and yields
              stay flagged.
            </p>
          </details>
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
              <div className="empty-meal-plan">
                <p className="settings-note">
                  Not sure what to make? Start with a few appealing options.
                </p>
                <button
                  className="button secondary"
                  onClick={() => {
                    onNavigate('assistant');
                  }}
                >
                  <Sparkles size={17} />
                  Help me choose
                </button>
              </div>
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
        <section className="assistant-panel mise-conversation">
          <div className="conversation-heading">
            <div className="assistant-brand">
              <Sparkles size={20} />
              <span>YOUR KITCHEN ASSISTANT</span>
            </div>
            <button
              className="icon-button conversation-options-button"
              aria-label="Conversation options"
              aria-expanded={conversationOptionsOpen}
              aria-controls="assistant-conversation-options"
              onClick={() => setConversationOptionsOpen((current) => !current)}
            >
              <SlidersHorizontal size={19} />
            </button>
          </div>
          <button
            className="assistant-source-control"
            aria-label="Recipe source"
            aria-expanded={conversationOptionsOpen}
            aria-controls="assistant-conversation-options"
            onClick={() => setConversationOptionsOpen((current) => !current)}
          >
            <RecipeSourceIcon size={19} aria-hidden="true" />
            <span>
              <small>Recipe source</small>
              <strong>{recipeMode.label}</strong>
            </span>
            <span className="assistant-source-change">Change</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {conversationOptionsOpen && (
            <section
              className="conversation-options"
              aria-label="Assistant preferences"
              id="assistant-conversation-options"
            >
              <h3>Conversation options</h3>
              <fieldset className="assistant-mode-options" disabled={aiBusy || modeSaving}>
                <legend>Where should recipe suggestions come from?</legend>
                {ASSISTANT_RECIPE_MODES.map((mode) => (
                  <label
                    key={mode.value}
                    className={conversationMode === mode.value ? 'active' : ''}
                  >
                    <input
                      type="radio"
                      name="recipe-guidance-mode"
                      aria-label={mode.label}
                      checked={conversationMode === mode.value}
                      onChange={() => setMode(mode.value)}
                    />
                    <span>
                      <strong>{mode.label}</strong>
                      <small>{mode.note}</small>
                    </span>
                    {conversationMode === mode.value && <Check size={17} aria-hidden="true" />}
                  </label>
                ))}
              </fieldset>
              <p className="assistant-mode-note">
                You can discuss attached recipes in any mode. This choice applies to new messages;
                switching sources clears the previous suggestion cards.
              </p>
              {conversationMode === 'library' && (
                <p className="assistant-mode-note">
                  Other recipe services are available in Recipes. Saved imports from supported
                  sources are included here.
                </p>
              )}
              {modeSaving && (
                <p className="assistant-mode-note" role="status">
                  Saving your choice…
                </p>
              )}
              <div className="hub-actions">
                <button className="text-button" onClick={onConfigure}>
                  Connection settings
                </button>
                {!!chatRecipes.length && (
                  <button className="text-button" onClick={() => setAttachedRecipes([])}>
                    Clear recipes
                  </button>
                )}
                {!!attachedBodyScanIds.length && (
                  <button className="text-button" onClick={() => onBodyScanAttachmentsChange?.([])}>
                    Clear body scans
                  </button>
                )}
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
            </section>
          )}
          {!history.length && (
            <div className="assistant-intro">
              <h2>Let’s make dinner easier.</h2>
              <p>
                Find something you’ll enjoy, figure out what to buy, and ask anything along the way.
              </p>
              <div className="assistant-starters">
                {[
                  {
                    label: 'Help me choose dinner',
                    description: 'A few good options to start with',
                    icon: ChefHat,
                    prompt:
                      'Help me choose dinner using real recipes. I am happy to shop for ingredients. Ask a brief question if it would help narrow down appealing options.',
                    createPrompt:
                      'Help me choose dinner and create a recipe for it. I am happy to shop for ingredients. Ask a brief question if it would help narrow down appealing options.',
                  },
                  {
                    label: 'Find meals to prep',
                    description: 'Cook once, make the week easier',
                    icon: Utensils,
                    prompt:
                      'Help me find real recipes that work well for meal prep. I am happy to buy missing ingredients. Help me decide what to make and ask about portions or effort when needed.',
                    createPrompt:
                      'Help me create a recipe that works well for meal prep. I am happy to buy missing ingredients. Ask about portions or effort when needed.',
                  },
                  {
                    label: 'Use what I have',
                    description: 'Put your groceries to good use',
                    icon: PackageCheck,
                    prompt:
                      'Help me find real recipes using what I have, prioritizing items expiring soon. Explain what is missing and keep the original recipe intact unless I ask for substitutions.',
                    createPrompt:
                      'Help me create a recipe using the inventory I have shared, prioritizing items expiring soon. Ask if you need to know quantities or preferences.',
                  },
                ].map(({ label, description, icon: Icon, prompt, createPrompt }) => (
                  <button
                    className="assistant-starter"
                    aria-label={label}
                    key={label}
                    disabled={aiBusy || modeSaving}
                    onClick={() => {
                      if (
                        label === 'Use what I have' &&
                        (inventoryContext.mode === 'none' || selectedIngredientCount === 0)
                      ) {
                        setInventoryContextOpen(true);
                        return;
                      }
                      void ask(conversationMode === 'create' ? createPrompt : prompt);
                    }}
                  >
                    <Icon size={21} />
                    <strong>{label}</strong>
                    <span>{description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="assistant-context" aria-label="Gemini context">
            <button
              className="context-chip inventory-context"
              aria-label="Inventory context"
              aria-haspopup="dialog"
              aria-expanded={inventoryContextOpen}
              disabled={aiBusy}
              onClick={() => setInventoryContextOpen(true)}
            >
              <PackageCheck size={15} />
              {inventoryContextLabel}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            <button
              className="context-chip"
              aria-label="Your profile"
              onClick={onProfile ?? (() => setNutritionOpen(true))}
            >
              <Plus size={15} />
              {inventory.nutritionTargets ? 'Nutrition profile' : 'Add profile'}
            </button>
            {(inventory.bodyScans ?? [])
              .filter((scan) => attachedBodyScanIds.includes(scan.id))
              .map((scan) => (
                <span className="context-chip attached" key={scan.id}>
                  <button className="context-chip-title" onClick={onProfile}>
                    {scan.name}
                  </button>
                  <button
                    className="context-chip-remove"
                    aria-label={'Remove ' + scan.name + ' from Gemini context'}
                    onClick={() =>
                      onBodyScanAttachmentsChange?.(
                        attachedBodyScanIds.filter((id) => id !== scan.id),
                      )
                    }
                  >
                    <X size={14} />
                  </button>
                </span>
              ))}
            {chatRecipes.map((recipe) => (
              <span className="context-chip attached" key={recipe.id}>
                <button
                  className="context-chip-title"
                  onClick={() => {
                    setDetail(recipe);
                    setDetailServings(recipe.servings ? String(recipe.servings) : '');
                  }}
                >
                  {recipe.title}
                </button>
                <button
                  className="context-chip-remove"
                  aria-label={'Remove ' + recipe.title + ' from Gemini context'}
                  onClick={() =>
                    setAttachedRecipes(chatRecipes.filter((item) => item.id !== recipe.id))
                  }
                >
                  <X size={14} />
                </button>
              </span>
            ))}
          </div>
          <p className="assistant-context-note">
            {inventoryContext.mode === 'all'
              ? 'Buy what you need. Mise remembers what you already have.'
              : inventoryContext.mode === 'none'
                ? 'Inventory is not attached to new messages.'
                : selectedIngredientCount
                  ? 'Only your selected ingredients are attached to new messages.'
                  : 'No ingredients selected. Inventory is not attached to new messages.'}
          </p>
          {inventory.nutritionTargets && (
            <p className="nutrition-summary">
              Daily targets ·{' '}
              {[
                inventory.nutritionTargets.caloriesKcal !== null
                  ? inventory.nutritionTargets.caloriesKcal + ' kcal'
                  : '',
                inventory.nutritionTargets.proteinGrams !== null
                  ? inventory.nutritionTargets.proteinGrams + ' g protein'
                  : '',
                inventory.nutritionTargets.carbsGrams !== null
                  ? inventory.nutritionTargets.carbsGrams + ' g carbs'
                  : '',
                inventory.nutritionTargets.fatGrams !== null
                  ? inventory.nutritionTargets.fatGrams + ' g fat'
                  : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'No values entered'}
            </p>
          )}
          <div className="chat-history" aria-label="Gemini conversation">
            {history.map((item) => (
              <div key={item.id} className={'chat-message ' + item.role}>
                <small>{item.role === 'user' ? 'YOU' : 'GEMINI'}</small>
                <ConversationText text={item.text} />
              </div>
            ))}
            {aiBusy && (
              <div role="status" className="assistant-thinking">
                <span />
                <span />
                <span />
                Gemini is thinking…
              </div>
            )}
            <div ref={endRef} />
          </div>
          {error && (
            <p role="alert" className="assistant-feedback">
              {error}
            </p>
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
              ref={composerRef}
              disabled={aiBusy}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onBlur={() => {
                if (message !== (inventory.assistantSession?.draft ?? ''))
                  void mutate((state) => updateAssistantSession(state, { draft: message })).catch(
                    () => {},
                  );
              }}
              rows={2}
              placeholder={
                conversationMode === 'discover'
                  ? 'What sounds good? Find a recipe or ask anything…'
                  : conversationMode === 'library'
                    ? 'What would you like to find in your cookbook?'
                    : 'What would you like to make?'
              }
              maxLength={6000}
            />
            <button
              className="button primary"
              aria-label={aiBusy ? 'Gemini is thinking' : 'Ask Gemini'}
              disabled={aiBusy || modeSaving || !message.trim()}
            >
              <ArrowUp size={20} />
              <span>{aiBusy ? 'Thinking…' : 'Send'}</span>
            </button>
          </form>
          {candidates.length > 0 && (
            <section className="assistant-suggestions" aria-label="Recipe suggestions">
              <div className="assistant-suggestions-heading">
                <div>
                  <span className="eyebrow">YOUR OPTIONS</span>
                  <h3>Something worth cooking</h3>
                </div>
                <button className="text-button" onClick={() => onNavigate('recipes')}>
                  Your recipes
                </button>
              </div>
              <div className="recipe-grid ai-recipes">
                {candidates.map((recipe) => (
                  <RecipeCard
                    key={recipe.id}
                    recipe={recipe}
                    inventory={inventory}
                    saved={saved.some((r) => r.id === recipe.id)}
                    onOpen={() => {
                      setDetail(recipe);
                      setDetailServings(recipe.servings ? String(recipe.servings) : '');
                    }}
                    onSave={() => {
                      if (recipe.source.type === 'ai') openEditor(recipe);
                      else void saveRecipe(recipe).catch(() => {});
                    }}
                    onDiscuss={() => {
                      if (addToGemini(recipe)) {
                        setMessage(
                          'Tell me about ' +
                            recipe.title +
                            '. Would it be a good choice for what we discussed?',
                        );
                        composerRef.current?.focus();
                        composerRef.current?.scrollIntoView?.({ block: 'center' });
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          )}
          {!readGeminiConnection() && (
            <div className="assistant-connection-note">
              <p>
                Connect Gemini to have the conversation here. You can also copy your kitchen
                context.
              </p>
              <button className="button secondary" onClick={onConfigure}>
                Connect Gemini
              </button>
            </div>
          )}
          <button
            className="text-button assistant-copy-context"
            onClick={() => {
              const text = [
                assistantInventoryMarkdown(inventory, inventoryContext),
                ...chatRecipes.map(recipeContext),
              ].join('\n\n');
              void navigator.clipboard
                .writeText(text)
                .then(() => onToast('Kitchen context copied.'))
                .catch(() =>
                  setError(
                    'Clipboard unavailable. Copy for Gemini is also available on your inventory screen.',
                  ),
                );
            }}
          >
            <Clipboard size={15} />
            Copy kitchen context
          </button>
        </section>
      )}
      {error && page !== 'assistant' && (
        <p className="form-error hub-error" role="alert">
          {error}
        </p>
      )}
      {inventoryContextOpen && (
        <InventoryContextPicker
          inventory={inventory}
          value={inventoryContext}
          onClose={() => setInventoryContextOpen(false)}
          onSave={async (next) => {
            await update((state) => updateAssistantSession(state, { inventoryContext: next }));
            setInventoryContextOpen(false);
            onToast('Chat inventory updated.');
          }}
        />
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
            {detail.imageUrl && safeLink(detail.imageUrl) && (
              <img className="recipe-detail-photo" src={detail.imageUrl} alt={detail.title} />
            )}
            {(detail.author || detail.totalMinutes !== undefined) && (
              <p className="recipe-detail-byline">
                {detail.author ? 'By ' + detail.author : ''}
                {detail.author && detail.totalMinutes !== undefined ? ' · ' : ''}
                {detail.totalMinutes !== undefined ? detail.totalMinutes + ' minutes' : ''}
              </p>
            )}
            <RecipeServingsControl
              originalServings={detail.servings}
              value={detailServings}
              onChange={setDetailServings}
            />
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
                className="button secondary"
                disabled={invalidDetailServings}
                onClick={() => {
                  void addToPlan(detail).catch(() => {});
                }}
              >
                {plan.some((item) => item.recipeId === detail.id)
                  ? 'Update meal plan'
                  : 'Add to meal plan'}
              </button>
              <button
                className="button primary"
                disabled={invalidDetailServings}
                onClick={() => {
                  void chooseAndShop(detail).catch(() => {});
                }}
              >
                <ShoppingCart size={17} />
                Make shopping list
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
            <NutritionDisclosure publisher={!!detail.publisherNutrition}>
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
                onEditRecipe={() => openEditor(detail)}
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
            </NutritionDisclosure>
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
              disabled={invalidDetailServings}
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
              void mutate((state) => ({
                ...state,
                chatHistory: [],
                assistantSession: {
                  ...emptyAssistantSession(),
                  mode: state.assistantSession?.mode ?? 'discover',
                  inventoryContext: assistantInventoryContextForSession(state.assistantSession),
                },
              }))
                .then(() => {
                  setClearChatOpen(false);
                  setChatRecipes([]);
                  setMessage('');
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
