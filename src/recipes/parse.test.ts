import { describe, expect, it } from 'vitest';
import { parseIngredientLine, parseMeasure, parseRecipeText } from './parse';
import { isRecipe } from './types';

describe('recipe measurement parsing', () => {
  it('handles Unicode, mixed, fractional, decimal, and joined measures', () => {
    expect(parseMeasure('1½ cups')).toMatchObject({ quantity: 1.5, unit: 'cup' });
    expect(parseMeasure('2 1/4 tbsp')).toMatchObject({ quantity: 2.25, unit: 'tbsp' });
    expect(parseMeasure('⅓ teaspoon')).toMatchObject({ quantity: 1 / 3, unit: 'tsp' });
    expect(parseMeasure('400g')).toMatchObject({ quantity: 400, unit: 'g' });
    expect(parseMeasure('0.5 L')).toMatchObject({ quantity: 0.5, unit: 'L' });
    expect(parseMeasure('2 tblsp')).toMatchObject({ quantity: 2, unit: 'tbsp' });
    expect(parseMeasure('5 thinly sliced')).toMatchObject({ quantity: 5, unit: 'each' });
    expect(parseMeasure('8 cloves chopped')).toMatchObject({ quantity: 8, unit: 'clove' });
  });
  it('keeps ranges, vague amounts, zero denominators, and package weights unknown', () => {
    expect(parseMeasure('2-3 tbsp')).toMatchObject({ quantity: null, unit: 'tbsp' });
    expect(parseMeasure('1 to 2 cups')).toMatchObject({ quantity: null, unit: 'cup' });
    expect(parseMeasure('to taste').quantity).toBeNull();
    expect(parseMeasure('1/0 cup').quantity).toBeNull();
    expect(parseMeasure('1 (400g) can').quantity).toBeNull();
    expect(parseMeasure('2 large').quantity).toBeNull();
  });
  it('preserves original ingredient wording while extracting precise amounts', () => {
    expect(parseIngredientLine('- 2 tbsp olive oil')).toEqual({
      name: 'olive oil',
      quantity: 2,
      unit: 'tbsp',
      original: '2 tbsp olive oil',
    });
    expect(parseIngredientLine('1 onion, finely chopped')).toMatchObject({
      name: 'onion',
      quantity: 1,
      unit: 'each',
    });
    expect(parseIngredientLine('3 eggs')).toMatchObject({
      name: 'eggs',
      quantity: 3,
      unit: 'each',
    });
    expect(parseIngredientLine('1-2 cups rice')).toMatchObject({
      name: 'rice',
      quantity: null,
      unit: 'cup',
    });
    expect(parseIngredientLine('2 (14 oz) cans tomatoes, drained')).toMatchObject({
      name: 'tomatoes',
      quantity: null,
      unit: 'can',
      original: '2 (14 oz) cans tomatoes, drained',
    });
    expect(parseIngredientLine('1 large onion')).toMatchObject({
      name: 'onion',
      quantity: null,
      unit: 'each',
    });
    expect(parseIngredientLine('Salt to taste')).toMatchObject({
      name: 'Salt',
      quantity: null,
    });
  });

  it('reads common abbreviated, decimal, and equivalent measures without inventing conversions', () => {
    expect(parseIngredientLine('.5 c. milk')).toMatchObject({
      quantity: 0.5,
      unit: 'cup',
      name: 'milk',
    });
    expect(parseIngredientLine('1 T. of olive oil')).toMatchObject({
      quantity: 1,
      unit: 'tbsp',
      name: 'olive oil',
    });
    expect(parseIngredientLine('1 t. salt')).toMatchObject({
      quantity: 1,
      unit: 'tsp',
      name: 'salt',
    });
    expect(parseIngredientLine('1 cup (120g) flour')).toMatchObject({
      quantity: 1,
      unit: 'cup',
      name: 'flour',
    });
    expect(parseMeasure('1,000 g')).toMatchObject({ quantity: 1000, unit: 'g' });
    expect(parseMeasure('0,5 L')).toMatchObject({ quantity: 0.5, unit: 'L' });
    expect(parseIngredientLine('1 / 2 cup milk')).toMatchObject({
      quantity: 0.5,
      unit: 'cup',
      name: 'milk',
    });
    expect(parseIngredientLine('⅕ cup sugar')).toMatchObject({
      quantity: 0.2,
      unit: 'cup',
      name: 'sugar',
    });
  });

  it('adds explicit compatible composite measures and leaves incompatible ones for review', () => {
    expect(parseIngredientLine('1 cup plus 2 tbsp milk')).toMatchObject({
      quantity: 1.125,
      unit: 'cup',
      name: 'milk',
    });
    expect(parseIngredientLine('1 cup plus 50 g flour')).toMatchObject({
      quantity: null,
      unit: 'cup',
      name: 'flour',
    });
    expect(parseIngredientLine('about 200 g carrots')).toMatchObject({
      quantity: null,
      unit: 'g',
      name: 'carrots',
    });
    expect(parseIngredientLine('1 heaped tsp sugar')).toMatchObject({
      quantity: null,
      unit: 'tsp',
      name: 'sugar',
    });
    expect(parseIngredientLine('1 cup milk or cream').quantity).toBeNull();
    expect(parseIngredientLine('-1 cup milk').quantity).toBeNull();
  });
});

describe('editable recipe import', () => {
  it('extracts title, servings, ingredients, steps, and original source', () => {
    const parsed = parseRecipeText(
      '# Egg toast\nServes: 2\nIngredients\n- 2 eggs\n- 2 slices bread\nInstructions\n1. Fry the eggs.\n2. Toast the bread.',
      'own:1',
      'https://example.com/recipe',
    );
    expect(parsed).toMatchObject({
      title: 'Egg toast',
      servings: 2,
      source: { type: 'imported', url: 'https://example.com/recipe' },
      steps: ['Fry the eggs.', 'Toast the bread.'],
    });
    expect(isRecipe(parsed)).toBe(true);
  });
  it('rejects incomplete, infinite, negative, and zero-yield external recipes', () => {
    const valid = parseRecipeText(
      'Toast\nServes: 1\nIngredients\n1 slice bread\nSteps\nToast it.',
      'toast',
    );
    expect(isRecipe({ ...valid, servings: 0 })).toBe(false);
    expect(isRecipe({ ...valid, steps: [] })).toBe(false);
    expect(
      isRecipe({
        ...valid,
        ingredients: [{ name: 'bread', unit: 'each', quantity: Number.POSITIVE_INFINITY }],
      }),
    ).toBe(false);
    expect(
      isRecipe({ ...valid, ingredients: [{ name: 'bread', unit: 'each', quantity: -1 }] }),
    ).toBe(false);
    expect(isRecipe(parseRecipeText('An incomplete caption', 'caption'))).toBe(false);
  });
});
