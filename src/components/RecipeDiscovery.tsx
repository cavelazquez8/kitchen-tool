import { useMemo, useState } from 'react';
import { ArrowRight, BookOpen, Shuffle } from 'lucide-react';
import type { InventoryState } from '../domain/types';
import type { Recipe } from '../recipes/types';
import {
  discoveryRecipePool,
  getStarterRecipes,
  recommendRecipes,
  shuffleRecipeOrder,
} from '../recipes/recommendations';
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
  const [scope, setScope] = useState<'starter' | 'cookbook'>('starter');
  const [shuffledIds, setShuffledIds] = useState<string[] | null>(null);
  const starters = useMemo(() => getStarterRecipes(recipes), [recipes]);
  const cookbook = useMemo(() => discoveryRecipePool(recipes), [recipes]);
  const pool = scope === 'starter' ? starters : cookbook;
  const choices = useMemo(() => {
    if (!shuffledIds) return recommendRecipes(pool, inventory, { limit: expanded ? 24 : 3 });
    const byId = new Map(pool.map((recipe) => [recipe.id, recipe]));
    return shuffledIds
      .flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
      .slice(0, expanded ? 24 : 3);
  }, [pool, inventory, expanded, shuffledIds]);
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
      <div className="discovery-controls">
        <div className="discovery-pool" role="group" aria-label="Recipe suggestion pool">
          <button
            type="button"
            aria-pressed={scope === 'starter'}
            onClick={() => {
              setScope('starter');
              setShuffledIds(null);
              setExpanded(false);
            }}
          >
            Everyday picks
          </button>
          <button
            type="button"
            aria-pressed={scope === 'cookbook'}
            disabled={loading || !cookbook.length}
            onClick={() => {
              setScope('cookbook');
              setShuffledIds(shuffleRecipeOrder(cookbook).map((recipe) => recipe.id));
              setExpanded(false);
            }}
          >
            Whole cookbook
          </button>
        </div>
        <button
          className="button secondary discovery-shuffle"
          disabled={loading || pool.length < 2}
          onClick={() => {
            setShuffledIds(shuffleRecipeOrder(pool).map((recipe) => recipe.id));
          }}
        >
          <Shuffle size={16} /> Shuffle suggestions
        </button>
      </div>
      <div className="discovery-order" role="status">
        <small>
          {shuffledIds
            ? `Random picks from ${pool.length.toLocaleString()} ${scope === 'starter' ? 'everyday recipes' : 'cookbook recipes'}.`
            : `${scope === 'starter' ? `${starters.length} curated` : `${cookbook.length.toLocaleString()} cookbook`} recipes, ordered using your inventory.`}
        </small>
        {shuffledIds && (
          <button className="text-button" onClick={() => setShuffledIds(null)}>
            Use inventory order
          </button>
        )}
      </div>
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
      {pool.length > 3 && (
        <button className="text-button" onClick={() => setExpanded((value) => !value)}>
          {expanded
            ? 'Show fewer'
            : scope === 'starter'
              ? 'More everyday recipes'
              : 'Show more suggestions'}
        </button>
      )}
    </section>
  );
}
