import { useMemo, useState } from 'react';
import { ArrowRight, BookOpen } from 'lucide-react';
import type { InventoryState } from '../domain/types';
import type { Recipe } from '../recipes/types';
import { getStarterRecipes, recommendRecipes } from '../recipes/recommendations';
import { matchRecipe } from '../recipes/matching';

export function RecipeDiscovery({
  recipes,
  inventory,
  loading,
  error,
  onOpen,
  onChoose,
}: {
  recipes: readonly Recipe[];
  inventory: InventoryState;
  loading: boolean;
  error: string;
  onOpen: (recipe: Recipe) => void;
  onChoose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const starters = useMemo(() => getStarterRecipes(recipes), [recipes]);
  const choices = useMemo(
    () => recommendRecipes(starters, inventory, { limit: expanded ? 24 : 3 }),
    [starters, inventory, expanded],
  );
  return (
    <section className="recipe-discovery" aria-label="Recipe starting points">
      <div className="discovery-heading">
        <div>
          <span className="eyebrow">
            <BookOpen size={15} /> EVERYDAY COOKING
          </span>
          <h2>A good place to start</h2>
          <p>Familiar recipes, with a clear path from your kitchen to your shopping list.</p>
        </div>
        <button className="button primary" onClick={onChoose}>
          Help me choose <ArrowRight size={17} />
        </button>
      </div>
      {loading && (
        <p className="field-note" role="status">
          Opening the cookbook…
        </p>
      )}
      {error && <p className="field-note">{error}</p>}
      <div className="starter-grid">
        {choices.map((recipe) => {
          const match = matchRecipe(recipe, inventory);
          return (
            <button className="starter-recipe" key={recipe.id} onClick={() => onOpen(recipe)}>
              <span>{recipe.cuisine ?? recipe.category ?? 'Cookbook classic'}</span>
              <strong>{recipe.title}</strong>
              <small>
                {match.matchedCount ? `${match.matchedCount} ingredients on hand · ` : ''}
                {match.missingCount
                  ? `${match.missingCount} to buy`
                  : match.uncertainCount
                    ? 'Check amounts'
                    : 'Ready to cook'}
                {recipe.servings ? ` · Serves ${recipe.servings}` : ''}
              </small>
            </button>
          );
        })}
      </div>
      {starters.length > 3 && (
        <button className="text-button" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show fewer' : 'More everyday recipes'}
        </button>
      )}
    </section>
  );
}
