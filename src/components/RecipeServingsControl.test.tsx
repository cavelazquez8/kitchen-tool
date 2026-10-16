import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecipeServingsControl } from './RecipeServingsControl';
import { validRecipeServings } from '../recipes/servings';

afterEach(cleanup);

describe('recipe serving quantities', () => {
  it('explains the original yield and proportional ingredient change without changing source instructions', async () => {
    const onChange = vi.fn();
    render(<RecipeServingsControl originalServings={4} value="6" onChange={onChange} />);
    const input = screen.getByRole('spinbutton', { name: /Cooking for/ });
    expect(input).toHaveValue(6);
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByText('Original recipe: 4 servings')).toBeVisible();
    expect(screen.getByText('1.5× ingredients')).toBeVisible();
    expect(input).toHaveAccessibleDescription(/Cooking instructions remain as published/);
    await userEvent.setup().clear(input);
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('supports positive fractional portions and makes rounded multipliers explicit', () => {
    const { rerender } = render(
      <RecipeServingsControl originalServings={4} value="0.5" onChange={vi.fn()} />,
    );
    expect(screen.getByText('0.125× ingredients')).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(<RecipeServingsControl originalServings={3} value="2" onChange={vi.fn()} />);
    expect(screen.getByText('≈ 0.6667× ingredients')).toBeVisible();
  });

  it.each(['', '0', '-1', 'NaN', 'Infinity', '1e999'])(
    'keeps invalid target %j out of the scaling summary and describes its error',
    (value) => {
      render(<RecipeServingsControl originalServings={4} value={value} onChange={vi.fn()} />);
      const input = screen.getByRole('spinbutton', { name: /Cooking for/ });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription('Enter a serving count greater than zero.');
      expect(screen.getByRole('alert')).toBeVisible();
      expect(screen.queryByText(/× ingredients/)).not.toBeInTheDocument();
    },
  );

  it('keeps an unknown original yield explicit and offers no invented serving control or multiplier', () => {
    render(<RecipeServingsControl originalServings={null} value="6" onChange={vi.fn()} />);
    expect(screen.getByText('Original serving count not recorded')).toBeVisible();
    expect(screen.getByText(/Ingredient quantities stay as written/)).toBeVisible();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByText(/× ingredients/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('accepts ordinary finite positive numbers while rejecting blank, nonfinite and alternate numeric formats', () => {
    for (const value of ['1', '0.5', '.25', '1e2', ' 2 '])
      expect(validRecipeServings(value)).toBe(true);
    for (const value of ['', ' ', '0', '-2', 'NaN', 'Infinity', '1e999', '0x10', '1/2'])
      expect(validRecipeServings(value)).toBe(false);
  });
});
