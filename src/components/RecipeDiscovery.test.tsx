import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Recipe } from '../recipes/types';
import { RecipeDiscovery } from './RecipeDiscovery';

function dish(id: string, title: string): Recipe {
  return {
    id,
    title,
    servings: 2,
    ingredients: [{ name: 'Rice', quantity: 200, unit: 'g' }],
    steps: ['Follow the recorded instructions.'],
    source: { type: 'wikibooks', name: 'Wikibooks Cookbook' },
  };
}
const recipes = [
  dish('wikibooks:111890', 'Skillet Lasagna'),
  dish('wikibooks:462082', 'Thai Grilled Chicken'),
  dish('wikibooks:202116', 'Beans and Rice'),
  dish('test:outside-starters-1', 'Other cookbook dish'),
  dish('test:outside-starters-2', 'Another cookbook dish'),
];
const inventory = { products: [], batches: [], tools: [] };
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function props() {
  return { recipes, inventory, loading: false, error: '', onOpen: vi.fn(), onChoose: vi.fn() };
}
function cardTitles(container: HTMLElement) {
  return [...container.querySelectorAll('.starter-recipe strong')].map(
    (element) => element.textContent,
  );
}

describe('recipe discovery shuffling', () => {
  it('shuffles source starters on demand, keeps the order through rerenders, and opens the original recipe', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const user = userEvent.setup();
    const initial = props();
    const { container, rerender } = render(<RecipeDiscovery {...initial} />);
    const recommended = cardTitles(container);
    await user.click(screen.getByRole('button', { name: 'Shuffle suggestions' }));
    const shuffled = cardTitles(container);
    expect(shuffled).not.toEqual(recommended);
    expect(new Set(shuffled)).toEqual(new Set(recommended));
    expect(screen.getByRole('status')).toHaveTextContent('Random picks from 3 everyday recipes.');
    rerender(
      <RecipeDiscovery
        {...initial}
        inventory={{ ...inventory, tools: [{ id: 'pan', name: 'Pan' }] }}
      />,
    );
    expect(cardTitles(container)).toEqual(shuffled);
    const card = within(container.querySelector('.starter-grid') as HTMLElement).getAllByRole(
      'button',
    )[0];
    await user.click(card);
    expect(initial.onOpen.mock.calls[0][0]).toBe(
      recipes.find((recipe) => recipe.title === shuffled[0]),
    );
    await user.click(screen.getByRole('button', { name: 'Use inventory order' }));
    expect(cardTitles(container)).toEqual(recommended);
  });

  it('lets whole-cookbook discovery include recipes outside the curated starter set', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const user = userEvent.setup();
    const { container } = render(<RecipeDiscovery {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Whole cookbook' }));
    expect(screen.getByRole('status')).toHaveTextContent('Random picks from 5 cookbook recipes.');
    await user.click(screen.getByRole('button', { name: 'Show more suggestions' }));
    expect(cardTitles(container)).toContain('Other cookbook dish');
    expect(cardTitles(container)).toHaveLength(5);
    await user.click(screen.getByRole('button', { name: 'Everyday picks' }));
    expect(cardTitles(container)).toHaveLength(3);
    expect(cardTitles(container)).not.toContain('Other cookbook dish');
  });
});
