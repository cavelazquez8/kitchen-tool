import { useEffect, useRef, useState } from 'react';
import { convertQuantity } from '../domain/inventory';
import { readGeminiConnection } from '../ai/client';
import { getNutritionFood, nutritionStatus, searchNutritionFoods } from '../nutrition/client';
import { recipeNutritionKey } from '../nutrition/estimate';
import { reviewedRecipeEstimate } from '../nutrition/recipeEstimate';
import type { FoodNutrition, RecipeNutritionMapping } from '../nutrition/types';
import type { Recipe } from '../recipes/types';
import { Choice } from './Choice';

function sourceGrams(recipe: Recipe, index: number) {
  const ingredient = recipe.ingredients[index];
  if (ingredient.quantity === null) return '';
  try {
    return String(convertQuantity(ingredient.quantity, ingredient.unit, 'g'));
  } catch {
    return '';
  }
}

export function RecipeNutrition({
  recipe,
  mapping,
  onSave,
  onConfigure,
}: {
  recipe: Recipe;
  mapping?: RecipeNutritionMapping;
  onSave: (mapping: RecipeNutritionMapping) => Promise<void>;
  onConfigure: () => void;
}) {
  const currentKey = recipeNutritionKey(recipe);
  const [draft, setDraft] = useState<RecipeNutritionMapping>(() =>
    mapping?.recipeKey === currentKey
      ? { recipeKey: mapping.recipeKey, ingredients: mapping.ingredients }
      : { recipeKey: currentKey, ingredients: [] },
  );
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [foods, setFoods] = useState<FoodNutrition[]>([]);
  const [chosen, setChosen] = useState<FoodNutrition | null>(null);
  const [grams, setGrams] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const attempt = useRef(0);
  useEffect(
    () => () => {
      attempt.current++;
      controller.current?.abort();
    },
    [],
  );
  const estimate = reviewedRecipeEstimate(recipe, draft);
  async function begin() {
    setOpen((value) => !value);
    if (open || configured !== null) return;
    const connection = readGeminiConnection();
    if (!connection) return;
    const id = ++attempt.current;
    controller.current?.abort();
    controller.current = new AbortController();
    try {
      const result = await nutritionStatus(connection, controller.current.signal);
      if (id === attempt.current) setConfigured(result.configured);
    } catch (e) {
      if (id === attempt.current)
        setError(e instanceof Error ? e.message : 'Could not check nutrition lookup.');
    }
  }
  function edit(index: number) {
    attempt.current++;
    controller.current?.abort();
    setBusy(false);
    setError('');
    setNotice('');
    const previous = draft.ingredients.find((item) => item.ingredientIndex === index);
    setActive(index);
    setQuery(recipe.ingredients[index].name.slice(0, 120));
    setFoods([]);
    setChosen(previous?.food ?? null);
    setGrams(previous ? String(previous.grams) : sourceGrams(recipe, index));
  }
  async function lookup(foodId?: number) {
    const connection = readGeminiConnection();
    if (!connection) {
      onConfigure();
      return;
    }
    const id = ++attempt.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (foodId !== undefined) {
        const food = await getNutritionFood(connection, foodId, controller.current.signal);
        if (id === attempt.current) setChosen(food);
      } else {
        const result = await searchNutritionFoods(connection, query, controller.current.signal);
        if (id === attempt.current) {
          setFoods(result.foods);
          setChosen(null);
          setNotice(
            result.foods.length
              ? 'Choose the food and preparation that match your recipe.'
              : 'No matching foods found. Try a simpler food name.',
          );
        }
      }
    } catch (e) {
      if (id === attempt.current) setError(e instanceof Error ? e.message : 'Food lookup failed.');
    } finally {
      if (id === attempt.current) setBusy(false);
    }
  }
  async function confirm() {
    if (
      active === null ||
      !chosen ||
      !grams.trim() ||
      !Number.isFinite(Number(grams)) ||
      Number(grams) < 0 ||
      Number(grams) > 1000000
    ) {
      setError('Enter the total edible grams used in the original recipe.');
      return;
    }
    const next: RecipeNutritionMapping = {
      recipeKey: currentKey,
      ingredients: [
        ...draft.ingredients.filter((item) => item.ingredientIndex !== active),
        { ingredientIndex: active, food: chosen, grams: Number(grams), confirmed: true },
      ],
    };
    setBusy(true);
    setError('');
    try {
      await onSave(next);
      setDraft(next);
      setActive(null);
      setChosen(null);
      setNotice('Food and amount confirmed.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this food match.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="recipe-nutrition" aria-label="Recipe nutrition">
      <div className="hub-section-title">
        <h3>Nutrition</h3>
        <button className="text-button" onClick={() => void begin()}>
          {open
            ? 'Close nutrition review'
            : estimate?.complete
              ? 'Review food matches'
              : 'Estimate with USDA'}
        </button>
      </div>
      {estimate && (
        <div className="nutrition-macros">
          {(
            [
              ['caloriesKcal', 'Calories', 'kcal'],
              ['proteinGrams', 'Protein', 'g'],
              ['carbsGrams', 'Carbs', 'g'],
              ['fatGrams', 'Fat', 'g'],
            ] as const
          ).map(([key, label, unit]) => (
            <span key={key}>
              {label}
              <strong>
                {estimate.perServing?.[key] !== null && estimate.perServing?.[key] !== undefined
                  ? `${Math.round(estimate.perServing[key]!)} ${unit}`
                  : '—'}
              </strong>
            </span>
          ))}
        </div>
      )}
      <p className="field-note">
        {estimate?.complete && estimate.perServing
          ? 'Estimated per original recipe serving, using your reviewed USDA foods and edible weights.'
          : `${estimate?.mappedIngredientCount ?? 0} of ${recipe.ingredients.length} ingredients reviewed. Complete nutrition needs every ingredient and a recorded serving yield.`}
      </p>
      {mapping && mapping.recipeKey !== currentKey && (
        <p className="field-note">This recipe changed. Review the food matches again.</p>
      )}
      {open && (
        <>
          {!readGeminiConnection() && (
            <button className="button secondary" onClick={onConfigure}>
              Connect nutrition lookup
            </button>
          )}
          {configured === false && (
            <p className="field-note">
              Add the free USDA key as <code>USDA_API_KEY</code> in your Cloudflare Worker.{' '}
              <a href="https://fdc.nal.usda.gov/api-key-signup/" target="_blank" rel="noreferrer">
                Get a free key
              </a>
              . Your reviewed matches remain available locally.
            </p>
          )}
          <p className="field-note">
            Choose the exact food, including raw or cooked, and confirm grams for the whole original
            recipe. Cups and counts need a verified weight. These estimates do not include cooking
            losses.
          </p>
          <div className="nutrition-ingredient-list">
            {recipe.ingredients.map((ingredient, index) => {
              const confirmed = draft.ingredients.find((item) => item.ingredientIndex === index);
              return (
                <div className="nutrition-ingredient" key={index}>
                  <div className="hub-actions">
                    <strong>{ingredient.name}</strong>
                    <button className="text-button" disabled={busy} onClick={() => edit(index)}>
                      {confirmed ? 'Review match' : 'Match food'}
                    </button>
                  </div>
                  <small>
                    {ingredient.original ??
                      `${ingredient.quantity ?? 'Unspecified'} ${ingredient.unit}`}{' '}
                    {confirmed ? `· ${confirmed.grams} g · ${confirmed.food.description}` : ''}
                  </small>
                  {active === index && (
                    <div className="nutrition-source">
                      <form
                        className="hub-search"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void lookup();
                        }}
                      >
                        <input
                          aria-label={`Find nutrition food for ${ingredient.name}`}
                          value={query}
                          onChange={(e) => {
                            attempt.current++;
                            controller.current?.abort();
                            setBusy(false);
                            setQuery(e.target.value);
                            setFoods([]);
                            setChosen(null);
                          }}
                          maxLength={120}
                        />
                        <button
                          className="button secondary"
                          disabled={busy || query.trim().length < 2}
                        >
                          Search USDA
                        </button>
                      </form>
                      {!chosen && (
                        <div className="nutrition-food-options">
                          {foods.map((food) => (
                            <button
                              key={food.fdcId}
                              disabled={busy}
                              onClick={() => void lookup(food.fdcId)}
                            >
                              {food.description}
                              {food.brand ? ` · ${food.brand}` : ''}
                              <br />
                              <small>{food.dataType}</small>
                            </button>
                          ))}
                        </div>
                      )}
                      {chosen && (
                        <>
                          <a
                            className="text-button"
                            href={chosen.sourceUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {chosen.description} · USDA source
                          </a>
                          <label>
                            Total edible grams in the original recipe
                            <input
                              aria-label={`Grams of ${ingredient.name}`}
                              type="number"
                              min="0"
                              max="1000000"
                              step="any"
                              value={grams}
                              onChange={(e) => setGrams(e.target.value)}
                            />
                          </label>
                          {chosen.portions.length > 0 && (
                            <Choice
                              label="Use a USDA portion weight"
                              value=""
                              options={[
                                { value: '', label: 'Choose a source portion' },
                                ...chosen.portions.map((portion, i) => ({
                                  value: String(i),
                                  label: `${portion.label} · ${portion.gramWeight} g`,
                                })),
                              ]}
                              onChange={(value) => {
                                if (value !== '')
                                  setGrams(String(chosen.portions[Number(value)].gramWeight));
                              }}
                            />
                          )}
                          <small>
                            Verify that this food and weight describe the amount used. Enter 0 only
                            if you intentionally omit it.
                          </small>
                          <button
                            className="button primary"
                            disabled={busy || !grams.trim()}
                            onClick={() => void confirm()}
                          >
                            Confirm food and amount
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {notice && (
            <p className="field-note" role="status">
              {notice}
            </p>
          )}
          {busy && (
            <p className="field-note" role="status">
              Looking up nutrition…
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <small>Food data: USDA FoodData Central · CC0. No guessed food weights.</small>
        </>
      )}
    </section>
  );
}
