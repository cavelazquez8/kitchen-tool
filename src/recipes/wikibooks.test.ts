import { describe, expect, it } from 'vitest';
import {
  cleanWikibooksText,
  parseWikibooksRecipe,
  parseWikibooksRecipeResult,
  type WikibooksRecipePage,
} from './wikibooks';

function page(wikitext: string): WikibooksRecipePage {
  return { pageid: 22971, title: 'Cookbook:Spaghetti alla Carbonara', revid: 4481456, wikitext };
}

const SOURCE = `{{recipesummary|category=Pasta recipes|servings=6|time=1 hour}}
{{recipe}}
==Ingredients==
*450 [[Cookbook:Gram|g]] (1 [[Cookbook:Pound|pound]]) [[Cookbook:Pasta|spaghetti]]
*225–500 g (½–1 pound) guanciale or [[Cookbook:Pancetta|pancetta]]
*178 ml (¾ cup) grated [[Cookbook:Parmesan Cheese|Parmigiano-Reggiano]] cheese
*{{frac|1|2}} tablespoon freshly-ground [[Cookbook:Pepper|pepper]]
*[[Cookbook:Salt|Salt]], to taste
==Equipment==
*Large pot
==Procedure==
#Cook the spaghetti until it is [[Cookbook:Al Dente|al dente]].
#Add the egg mixture off the heat.<ref name="note">Source note</ref>
==Notes==
*Optional variations are not required ingredients.
[[Category:Italian recipes]]`;

describe('Wikibooks recipe ingestion', () => {
  it('preserves quantities and original text while removing alternative measures from names', () => {
    const recipe = parseWikibooksRecipe(page(SOURCE));
    expect(recipe).toMatchObject({
      id: 'wikibooks:22971',
      title: 'Spaghetti alla Carbonara',
      servings: 6,
      category: 'Pasta',
      cuisine: 'Italian',
      steps: ['Cook the spaghetti until it is al dente.', 'Add the egg mixture off the heat.'],
    });
    expect(recipe?.ingredients[0]).toEqual({
      name: 'spaghetti',
      quantity: 450,
      unit: 'g',
      original: '450 g (1 pound) spaghetti',
    });
    expect(recipe?.ingredients[1]).toEqual({
      name: 'guanciale or pancetta',
      quantity: null,
      unit: 'g',
      original: '225–500 g (½–1 pound) guanciale or pancetta',
    });
    expect(recipe?.ingredients[2]).toEqual({
      name: 'Parmigiano-Reggiano cheese',
      quantity: 178,
      unit: 'mL',
      original: '178 ml (¾ cup) grated Parmigiano-Reggiano cheese',
    });
    expect(recipe?.ingredients[3]).toMatchObject({ quantity: 0.5, unit: 'tbsp' });
    expect(recipe?.ingredients[4]).toMatchObject({ name: 'Salt', quantity: null, unit: '' });
  });

  it('retains revision-specific attribution and license without importing images', () => {
    const recipe = parseWikibooksRecipe(page(SOURCE));
    expect(recipe?.source).toEqual({
      type: 'wikibooks',
      name: 'Wikibooks Cookbook',
      url: 'https://en.wikibooks.org/w/index.php?oldid=4481456',
      attribution: 'Wikibooks contributors · CC BY-SA 4.0; adapted for Mise.',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    });
    expect(recipe?.imageUrl).toBeUndefined();
  });

  it.each(['', '4–6', '2 loaves', 'about 4', '{{unknown-yield|4}}'])(
    'leaves unclear yield %j unknown',
    (yieldText) => {
      expect(
        parseWikibooksRecipe(page(SOURCE.replace('servings=6', `servings=${yieldText}`)))?.servings,
      ).toBeNull();
    },
  );

  it.each(['recipesummary', 'Recipe summary', 'recipe_summary'])(
    'reads exact yields from %s aliases',
    (template) => {
      expect(parseWikibooksRecipe(page(SOURCE.replace('recipesummary', template)))?.servings).toBe(
        6,
      );
    },
  );

  it.each(['Procedures', 'Process', 'Preparation', 'Method', 'Directions', 'Instructions'])(
    'recognizes the source instruction heading %s',
    (heading) => {
      expect(
        parseWikibooksRecipe(page(SOURCE.replace('==Procedure==', `==${heading}==`)))?.steps,
      ).toHaveLength(2);
    },
  );

  it('expands explicit fraction and convert templates without manufacturing conversions', () => {
    expect(cleanWikibooksText('{{frac|1|1|2}} cups flour')).toBe('1 1/2 cups flour');
    expect(cleanWikibooksText('{{frac|3}} cup oil')).toBe('1/3 cup oil');
    expect(cleanWikibooksText('{{convert|450|g|lb|2}} flour')).toBe('450 g flour');
    expect(cleanWikibooksText('Heat to {{convert|180|C|F}}.')).toBe('Heat to 180 °C.');
    expect(cleanWikibooksText('{{convert|2|to|3|tbsp|ml}} oil')).toBe('2–3 tbsp oil');
    expect(cleanWikibooksText('{{nowrap|{{frac|1|2}} cup}} oil')).toBe('1/2 cup oil');
    expect(cleanWikibooksText('{{frac|1|0}} cup oil')).toBeNull();
  });

  it('rejects the whole recipe when ingredient or instruction templates are unsupported', () => {
    expect(parseWikibooksRecipeResult(page(SOURCE.replace('*450 ', '*{{unknown|450}} ')))).toEqual({
      recipe: null,
      reason: 'unsupported ingredient markup',
    });
    expect(
      parseWikibooksRecipeResult(page(SOURCE.replace('#Cook ', '#{{unknown|Cook}} '))),
    ).toEqual({ recipe: null, reason: 'unsupported instruction markup' });
  });

  it('does not use a quantity for either side of an ingredient alternative', () => {
    const recipe = parseWikibooksRecipe(
      page(SOURCE.replace('*450 ', '*450 ').replace('spaghetti]]', 'spaghetti]] or rice')),
    );
    expect(recipe?.ingredients[0]).toMatchObject({
      name: 'spaghetti or rice',
      quantity: null,
      unit: 'g',
    });
  });

  it('normalizes compound alternative measures and measured preparation text for matching', () => {
    const recipe = parseWikibooksRecipe(
      page(`{{recipe summary|category=Recipes for dessert}}
==Ingredients==
*1 cup (275 g / 10 oz) of brown sugar
*1 tablespoon of freshly-ground black pepper
*1 cup freshly-grated Parmesan cheese
*½ tsp salt (or to taste)
*1 cup warm water
*8 cloves
==Procedure (brief)==
#Mix.`),
    );
    expect(recipe?.category).toBe('Dessert');
    expect(recipe?.ingredients).toMatchObject([
      {
        name: 'brown sugar',
        quantity: 1,
        unit: 'cup',
        original: '1 cup (275 g / 10 oz) of brown sugar',
      },
      { name: 'black pepper', quantity: 1, unit: 'tbsp' },
      { name: 'Parmesan cheese', quantity: 1, unit: 'cup' },
      { name: 'salt', quantity: null, unit: 'tsp' },
      { name: 'water', quantity: 1, unit: 'cup' },
      { name: 'cloves', quantity: 8, unit: 'each' },
    ]);
  });

  it.each([
    '1 scant tablespoon flour',
    '1 heaped cup flour',
    'About 1 cup flour',
    '20 g + 20 g flour',
    '2 x 400 g flour',
    '3 cooking spoons flour',
  ])('keeps ambiguous measure %j unknown', (ingredient) => {
    const recipe = parseWikibooksRecipe(
      page(`==Ingredients==\n*${ingredient}\n==Procedure==\n#Mix.`),
    );
    expect(recipe?.ingredients[0].quantity).toBeNull();
    expect(recipe?.ingredients[0].original).toBe(ingredient);
  });

  it('does not collect a nested instruction section as ingredients', () => {
    const recipe = parseWikibooksRecipe(
      page('==Ingredients==\n*1 egg\n===Procedure===\n*Beat the egg.\n*Cook it.'),
    );
    expect(recipe?.ingredients).toHaveLength(1);
    expect(recipe?.steps).toEqual(['Beat the egg.', 'Cook it.']);
  });

  it('marks explicitly optional ingredient groups as optional', () => {
    const recipe = parseWikibooksRecipe(
      page(
        '==Ingredients==\n*1 egg\n===Optional toppings===\n*1 tsp pepper\n==Procedure==\n#Cook.',
      ),
    );
    expect(recipe?.ingredients[0].optional).toBeUndefined();
    expect(recipe?.ingredients[1].optional).toBe(true);
  });

  it('rejects tables, separate ingredient sections, and unparsed required prose', () => {
    expect(
      parseWikibooksRecipeResult(
        page('==Ingredients==\n*1 egg\n{|\n|Other ingredients\n|}\n==Procedure==\n#Cook.'),
      ),
    ).toMatchObject({ recipe: null, reason: 'ingredient table requires manual review' });
    expect(
      parseWikibooksRecipeResult(
        page('==Ingredients==\n*1 egg\n==Procedure==\n#Cook.\n==Ingredients==\n*1 cup rice'),
      ),
    ).toMatchObject({ recipe: null, reason: 'multiple ingredient sections require manual review' });
    expect(
      parseWikibooksRecipeResult(
        page('==Ingredients==\nYou need a leg of mutton.\n*1 tsp salt\n==Procedure==\n#Cook.'),
      ),
    ).toMatchObject({ recipe: null, reason: 'non-list ingredient content requires manual review' });
  });

  it('keeps instruction groups and continuation text in their original order', () => {
    const recipe = parseWikibooksRecipe(
      page(`==Ingredients==
*1 cup rice
==Preparation==
===Rice===
#Wash the rice.
Use cold water.
===Cooking===
#Cook for 20 minutes.
==Notes==
Do not turn this note into a step.`),
    );
    expect(recipe?.steps).toEqual([
      'Rice: Wash the rice. Use cold water.',
      'Cooking: Cook for 20 minutes.',
    ]);
  });

  it('rejects unfinished and incomplete pages rather than publishing partial recipes', () => {
    expect(parseWikibooksRecipe(page('{{cookwork}}\n' + SOURCE))).toBeNull();
    expect(parseWikibooksRecipe(page('==Ingredients==\n*1 egg'))).toBeNull();
    expect(parseWikibooksRecipe({ ...page(SOURCE), revid: 0 })).toBeNull();
  });

  it('cleans common entities and references without executable HTML', () => {
    expect(cleanWikibooksText('&frac12;&nbsp;cup [[Cookbook:Oil|oil]]<ref/>')).toBe('½ cup oil');
    expect(cleanWikibooksText('<script>alert(1)</script>')).toBeNull();
    expect(cleanWikibooksText('[[Cookbook:Butter|butter')).toBeNull();
  });
});
