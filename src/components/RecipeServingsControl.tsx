import { useId } from 'react';
import { validRecipeServings } from '../recipes/servings';
import './recipeServingsControl.css';

interface Props {
  originalServings: number | null;
  value: string;
  onChange: (value: string) => void;
}

const number = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 });
const originalNumber = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 21 });

/** Target portions scale recorded ingredients; the original recipe stays intact. */
export function RecipeServingsControl({ originalServings, value, onChange }: Props) {
  const id = useId();
  const known =
    originalServings !== null && Number.isFinite(originalServings) && originalServings > 0;
  const valid = validRecipeServings(value);
  const multiplier = known && valid ? Number(value) / originalServings : null;
  const rounded = multiplier !== null && Number(multiplier.toPrecision(4)) !== multiplier;
  return (
    <section className="recipe-servings-control" aria-label="Recipe portions">
      <div className="recipe-servings-heading">
        <p>
          {known
            ? `Original recipe: ${originalNumber.format(originalServings)} servings`
            : 'Original serving count not recorded'}
        </p>
        {multiplier !== null && (
          <span className="recipe-servings-multiplier">
            {rounded ? '≈ ' : ''}
            {number.format(multiplier)}× ingredients
          </span>
        )}
      </div>
      {known ? (
        <>
          <label className="recipe-servings-input" htmlFor={id}>
            <span>Cooking for</span>
            <input
              id={id}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              aria-invalid={!valid}
              aria-describedby={id + (valid ? '-hint' : '-error')}
            />
            <span>servings</span>
          </label>
          {!valid && (
            <p className="recipe-servings-error" id={id + '-error'} role="alert">
              Enter a serving count greater than zero.
            </p>
          )}
          <p className="recipe-servings-hint" id={id + '-hint'}>
            Ingredient amounts update below. Cooking instructions remain as published.
          </p>
        </>
      ) : (
        <p className="recipe-servings-hint" id={id + '-hint'}>
          Ingredient quantities stay as written. Set the original servings in Edit &amp; save before
          scaling this recipe.
        </p>
      )}
    </section>
  );
}
