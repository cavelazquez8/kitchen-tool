import { copyRecipeMetadata, type Recipe } from '../recipes/types';
import type { AiMessage, AiRecipeDraft } from './protocol';

const HISTORY_ENTRY_LIMIT = 6000;
const HISTORY_TOTAL_LIMIT = 24000;
const RECIPE_LIMIT = 12000;
const INVENTORY_LIMIT = 24000;

function shortened(value: string, limit: number, note: string): string {
  if (value.length <= limit) return value;
  let prefix = value.slice(0, Math.max(0, limit - note.length));
  // Avoid splitting a surrogate pair when shortening text containing emoji.
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return prefix.trimEnd() + note;
}

/** Remove empty optional metadata so validated AI drafts satisfy saved-recipe rules. */
export function normalizeAiRecipe(
  draft: AiRecipeDraft,
  id: string,
  source: Recipe['source'],
): Recipe {
  return {
    id,
    title: draft.title.trim(),
    servings: draft.servings,
    ingredients: draft.ingredients.map((ingredient) => ({
      name: ingredient.name.trim(),
      quantity: ingredient.quantity,
      unit: ingredient.unit.trim(),
      ...(ingredient.original?.trim() ? { original: ingredient.original.trim() } : {}),
      ...(ingredient.optional === undefined ? {} : { optional: ingredient.optional }),
    })),
    steps: draft.steps.map((step) => step.trim()),
    source: {
      ...(source.type === 'imported' && draft.source?.type === 'imported' ? draft.source : source),
    },
    ...copyRecipeMetadata(draft),
  };
}

/** Keep the most recent usable turns within both API history budgets. */
export function boundedChatHistory(history: readonly AiMessage[]): AiMessage[] {
  const valid = history
    .filter(
      (item) =>
        item &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.text === 'string' &&
        item.text.trim().length > 0,
    )
    .slice(-12);
  const result: AiMessage[] = [];
  let remaining = HISTORY_TOTAL_LIMIT;
  for (let index = valid.length - 1; index >= 0 && remaining > 0; index--) {
    const item = valid[index];
    const limit = Math.min(HISTORY_ENTRY_LIMIT, remaining);
    // Do not manufacture a history turn containing only a truncation notice.
    const note = '\n[Earlier message shortened.]';
    if (limit <= note.length && item.text.length > limit) break;
    const text = shortened(item.text.trim(), limit, note);
    if (!text.trim()) continue;
    result.unshift({ role: item.role, text });
    remaining -= text.length;
  }
  return result;
}

/** Bounded plain-text context keeps amounts explicit and never infers unknowns. */
export function recipeContext(recipe: Recipe): string {
  const metadata = [
    `Source: ${recipe.source.name ?? recipe.source.type}`,
    recipe.source.url ? `Original source URL: ${recipe.source.url}` : '',
    recipe.author ? `Author: ${recipe.author}` : '',
    recipe.totalMinutes !== undefined ? `Total time: ${recipe.totalMinutes} minutes` : '',
    recipe.prepMinutes !== undefined ? `Preparation time: ${recipe.prepMinutes} minutes` : '',
    recipe.cookMinutes !== undefined ? `Cooking time: ${recipe.cookMinutes} minutes` : '',
    recipe.publisherNutrition
      ? `Publisher-declared nutrition (preserve stated units; do not assume a serving basis): ${JSON.stringify(recipe.publisherNutrition)}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
  const header = `Recipe: ${shortened(recipe.title, 180, '…')}\nOriginal servings: ${recipe.servings === null ? 'Unknown' : recipe.servings}\n${shortened(metadata, 2800, '\n[Publisher metadata shortened; ask for the source before assuming omitted values.]')}\n`;
  const ingredients = recipe.ingredients
    .map((ingredient) => {
      const amount =
        ingredient.quantity === null ? 'Quantity unknown' : String(ingredient.quantity);
      const measure = [amount, ingredient.unit].filter(Boolean).join(' ');
      return `- ${measure}: ${ingredient.name}${ingredient.optional ? ' (optional)' : ''}${ingredient.original?.trim() ? `; original: ${ingredient.original.trim()}` : ''}`;
    })
    .join('\n');
  const ingredientSection =
    'Ingredients:\n' +
    shortened(
      ingredients,
      6000,
      '\n[Ingredients shortened; ask for omitted details instead of assuming them.]',
    ) +
    '\n';
  const steps = recipe.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
  const remaining = Math.max(
    0,
    RECIPE_LIMIT - header.length - ingredientSection.length - 'Steps:\n'.length,
  );
  return (
    header +
    ingredientSection +
    'Steps:\n' +
    shortened(
      steps,
      remaining,
      '\n[Steps shortened; ask for omitted instructions instead of inventing them.]',
    )
  );
}

/** Preserve whole inventory lines when possible and disclose omitted inventory. */
export function boundedInventoryContext(markdown: string): string {
  if (markdown.length <= INVENTORY_LIMIT) return markdown;
  const note =
    '\n\n[Inventory shortened to fit this request. Items not shown may still be in the kitchen; ask before assuming they are absent.]';
  const cutoff = INVENTORY_LIMIT - note.length;
  const newline = markdown.lastIndexOf('\n', cutoff);
  const content = newline >= cutoff - 1500 ? markdown.slice(0, newline) : markdown;
  return shortened(content, cutoff, '') + note;
}
