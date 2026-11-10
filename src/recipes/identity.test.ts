import { describe, expect, it } from 'vitest';
import {
  canonicalIngredientName,
  parsePackageQuantity,
  suggestIngredientIdentity,
} from './identity';

describe('ingredient identity', () => {
  it.each([
    ['2 unrelated words', '2 unrelated words'],
    ['Green_Onions', 'green onion'],
    ['Onions, finely chopped', 'onion'],
    ['diced red onions', 'red onion'],
    ['Organic carrots', 'carrot'],
    ['Fresh coriander', 'cilantro'],
    ['Confectioners’ sugar', 'powdered sugar'],
    ['Minced beef', 'ground beef'],
    ['Garbanzo beans', 'chickpea'],
    ['garlic cloves', 'garlic'],
    ['Corn starch', 'cornstarch'],
    ['white granulated sugar', 'sugar'],
    ['Eggs, beaten', 'egg'],
    ['Unsalted butter, melted', 'unsalted butter'],
    ['Lemons, juiced', 'lemon'],
    ['onion, diced small', 'onion'],
    ['red onion, sliced thin', 'red onion'],
    ['potatoes, peeled and cut into chunks', 'potato'],
    ['carrots, cut into 1 cm pieces', 'carrot'],
    ['eggs, separated', 'egg'],
    ['eggs, lightly beaten, at room temperature', 'egg'],
    ['butter, at room temperature', 'butter'],
    ['lemon, zested and juiced', 'lemon'],
    ['salt, as needed', 'salt'],
    ['large eggs', 'egg'],
    ['Extra-large eggs', 'egg'],
    ['medium onion', 'onion'],
    ['small red onion', 'red onion'],
    ['large organic carrots', 'carrot'],
  ])('normalizes %s without altering unknown wording', (source, expected) => {
    expect(canonicalIngredientName(source)).toBe(expected);
  });

  it.each([
    ['almond milk', 'milk'],
    ['rice flour', 'all-purpose flour'],
    ['chicken thigh', 'chicken breast'],
    ['chicken breast', 'chicken'],
    ['tomato paste', 'tomato sauce'],
    ['dried basil', 'fresh basil'],
    ['ground coriander', 'cilantro'],
    ['soy sauce', 'low sodium soy sauce'],
    ['cooked rice', 'rice'],
    ['crushed tomatoes', 'tomatoes'],
    ['egg whites', 'eggs'],
    ['large egg yolks', 'eggs'],
    ['green onions, sliced thin', 'onions'],
    ['red onion, diced', 'onion'],
    ['sweet potatoes, cubed', 'potatoes'],
    ['coconut milk', 'milk'],
    ['tomatoes, crushed', 'tomatoes'],
    ['rice, cooked', 'rice'],
    ['black pepper, ground', 'black pepper'],
    ['beans, or lentils', 'beans'],
    ['medium grain rice', 'rice'],
    ['mashed potatoes', 'potatoes'],
  ])('keeps %s distinct from %s', (first, second) => {
    expect(canonicalIngredientName(first)).not.toBe(canonicalIngredientName(second));
  });

  it('suggests an exact ingredient after removing the reported brand while retaining the product label', () => {
    const name = 'Example Organic Carrots';
    expect(suggestIngredientIdentity(name, { brand: 'Example' })).toEqual({
      candidates: ['Carrot'],
      confidence: 'clear',
    });
    expect(name).toBe('Example Organic Carrots');
  });

  it('asks for review when a flavor or label could conceal a different product', () => {
    expect(
      suggestIngredientIdentity('Example Chicken flavored soup', { brand: 'Example' }),
    ).toMatchObject({ confidence: 'review', candidates: ['Chicken'] });
    expect(suggestIngredientIdentity('Unsweetened vanilla almond milk')).toMatchObject({
      confidence: 'review',
      candidates: ['Almond milk'],
    });
    expect(suggestIngredientIdentity('Baby carrots')).toMatchObject({
      confidence: 'review',
      candidates: ['Carrot'],
    });
  });

  it('treats conflicting generic metadata as review rather than silently changing identity', () => {
    expect(suggestIngredientIdentity('Soy milk', { genericName: 'Milk' })).toMatchObject({
      confidence: 'review',
      candidates: ['Soy milk', 'Milk'],
    });
    expect(
      suggestIngredientIdentity('Mystery brand blend', { categories: ['en:tomato-sauces'] }),
    ).toMatchObject({ confidence: 'review', candidates: ['Tomato sauce'] });
    expect(suggestIngredientIdentity('Mystery brand blend')).toMatchObject({
      confidence: 'unknown',
      candidates: [],
    });
  });
});

describe('explicit package contents', () => {
  it.each([
    ['500g', 500, 'g'],
    ['1.5 L', 1.5, 'L'],
    ['16 ounces', 16, 'oz'],
    ['12 fl oz', 12, 'fl oz'],
    ['2 pounds', 2, 'lb'],
    ['2 lbs', 2, 'lb'],
    ['250 millilitres', 250, 'mL'],
  ])('reads the net contents of %s', (source, quantity, unit) => {
    expect(parsePackageQuantity(source)).toEqual({ quantity, unit });
  });

  it.each([
    '6 x 100 g',
    '100g / 3.5oz',
    '2 cans',
    '1 package',
    '0 g',
    '-500g',
    'about 500g',
    '500 g drained weight',
  ])('requires review for %s', (source) => {
    expect(parsePackageQuantity(source)).toBeNull();
  });
});
