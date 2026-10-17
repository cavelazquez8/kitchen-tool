import { useState, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { Autocomplete } from './Autocomplete';
import { FOOD_CATALOG } from '../recipes/catalog';
import { isRecipe, type Recipe } from '../recipes/types';
import './recipeBrowser.css';
export function RecipeEditor({
  initial,
  onClose,
  onSave,
  notes = [],
}: {
  initial: Recipe;
  onClose: () => void;
  onSave: (recipe: Recipe) => Promise<void>;
  notes?: readonly string[];
}) {
  const [draft, setDraft] = useState(initial);
  const [category, setCategory] = useState(initial.category ?? '');
  const [cuisine, setCuisine] = useState(initial.cuisine ?? '');
  const [steps, setSteps] = useState(initial.steps.join('\n'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  function ingredient(index: number, patch: Partial<Recipe['ingredients'][number]>) {
    setDraft((current) => ({
      ...current,
      ingredients: current.ingredients.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const recipe = {
      ...draft,
      category: category.trim() || undefined,
      cuisine: cuisine.trim() || undefined,
      title: draft.title.trim(),
      ingredients: draft.ingredients.map((i) => ({ ...i, name: i.name.trim() })),
      steps: steps
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (!isRecipe(recipe)) {
      setError(
        'Add a title, at least one ingredient, and a cooking step. Check quantities and servings.',
      );
      return;
    }
    setBusy(true);
    setError('');
    try {
      await onSave(recipe);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save this recipe.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Review your recipe"
      description="Check ingredients and quantities once. You can edit them any time."
      className="recipe-editor"
    >
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        className="item-form"
      >
        <label>
          Recipe name
          <input
            value={draft.title}
            required
            maxLength={160}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </label>
        <fieldset className="recipe-label-editor">
          <legend>
            Category &amp; cuisine <span className="optional">optional</span>
          </legend>
          <p className="field-note">Use your own labels. They appear in recipe filters.</p>
          <div className="recipe-label-fields">
            <label>
              Category
              <input
                value={category}
                maxLength={100}
                placeholder="e.g. Meal prep"
                onChange={(event) => setCategory(event.target.value)}
              />
            </label>
            <label>
              Cuisine
              <input
                value={cuisine}
                maxLength={100}
                placeholder="e.g. Mexican"
                onChange={(event) => setCuisine(event.target.value)}
              />
            </label>
          </div>
        </fieldset>
        <label>
          Original recipe servings <span className="optional">optional</span>
          <input
            type="number"
            min="0.1"
            step="any"
            placeholder="Unknown"
            value={draft.servings ?? ''}
            onChange={(e) =>
              setDraft({
                ...draft,
                servings: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          />
        </label>
        <p className="field-note">
          Keep unknown amounts blank. Setting the original yield lets Mise scale the recipe for meal
          prep.
        </p>
        {notes.length > 0 && (
          <div className="recipe-review-notes" role="note">
            <strong>Check before cooking</strong>
            {notes.map((note, index) => (
              <p className="field-note" key={index}>
                {note}
              </p>
            ))}
          </div>
        )}
        <div className="recipe-ingredients-editor">
          {draft.ingredients.map((item, index) => (
            <div className="ingredient-editor-row" key={index}>
              <label>
                Ingredient
                <Autocomplete
                  label="Ingredient"
                  value={item.name}
                  onChange={(name) => ingredient(index, { name })}
                  options={FOOD_CATALOG}
                  required
                />
              </label>
              <label>
                Amount
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={item.quantity ?? ''}
                  placeholder="Unknown"
                  onChange={(e) =>
                    ingredient(index, {
                      quantity: e.target.value === '' ? null : Number(e.target.value),
                    })
                  }
                />
              </label>
              <label>
                Unit
                <Autocomplete
                  label="Unit"
                  value={item.unit}
                  onChange={(unit) => ingredient(index, { unit })}
                  options={[
                    'each',
                    'g',
                    'kg',
                    'oz',
                    'lb',
                    'cup',
                    'tbsp',
                    'tsp',
                    'mL',
                    'L',
                    'package',
                  ]}
                />
              </label>
              <button
                className="icon-button"
                type="button"
                aria-label={`Remove ingredient ${index + 1}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    ingredients: draft.ingredients.filter((_, i) => i !== index),
                  })
                }
              >
                <Trash2 size={16} />
              </button>
              {item.original && (
                <small className="ingredient-original">Original: {item.original}</small>
              )}
              <label className="optional-ingredient">
                <input
                  type="checkbox"
                  checked={item.optional ?? false}
                  onChange={(e) => ingredient(index, { optional: e.target.checked })}
                />
                Optional ingredient
              </label>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="button secondary"
          onClick={() =>
            setDraft({
              ...draft,
              ingredients: [...draft.ingredients, { name: '', quantity: null, unit: '' }],
            })
          }
        >
          <Plus size={16} />
          Add ingredient
        </button>
        <label>
          Cooking steps
          <textarea
            value={steps}
            required
            rows={7}
            onChange={(e) => setSteps(e.target.value)}
            placeholder="One step per line"
          />
        </label>
        {draft.source.url && <p className="field-note">Source: {draft.source.url}</p>}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-footer">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save recipe'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
