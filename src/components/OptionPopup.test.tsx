import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Choice } from './Choice';
import { Autocomplete } from './Autocomplete';

afterEach(cleanup);
const options = ['Breakfast', 'Dinner', 'Soup'].map((label) => ({ value: label, label }));
function setup() {
  const change = vi.fn();
  render(
    <>
      <Choice value="Breakfast" options={options} onChange={change} label="Category" />
      <button>Outside</button>
    </>,
  );
  return change;
}

describe('searchable touch dropdowns', () => {
  it('filters options without changing the selected value, then commits a tap', async () => {
    const change = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.type(screen.getByLabelText('Search category'), 'sOu');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(change).not.toHaveBeenCalled();
    await user.click(screen.getByRole('option', { name: 'Soup' }));
    expect(change).toHaveBeenCalledExactlyOnceWith('Soup');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveFocus();
  });

  it('keeps the menu open on touch down and ignores selection after native scrolling/cancellation', async () => {
    const change = setup();
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }));
    const option = screen.getByRole('option', { name: 'Dinner' });
    fireEvent.pointerDown(option, { pointerType: 'touch' });
    expect(change).not.toHaveBeenCalled();
    fireEvent.scroll(screen.getByRole('listbox'));
    fireEvent.pointerCancel(option, { pointerType: 'touch' });
    fireEvent.click(option, { detail: 1 });
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.click(option);
    expect(change).toHaveBeenCalledExactlyOnceWith('Dinner');
  });

  it('handles no results, keyboard selection, and outside dismissal', async () => {
    const change = setup();
    const user = userEvent.setup();
    const trigger = screen.getByRole('combobox', { name: 'Category' });
    await user.click(trigger);
    const search = screen.getByLabelText('Search category');
    await user.type(search, 'unknown{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('No matching options');
    expect(change).not.toHaveBeenCalled();
    await user.clear(search);
    await user.type(search, 'din{Enter}');
    expect(change).toHaveBeenCalledExactlyOnceWith('Dinner');
    await user.click(trigger);
    expect(screen.getByLabelText('Search category')).toHaveValue('');
    await user.click(screen.getByText('Outside', { exact: true }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('allows focus to move into search and Escape to close only the menu', async () => {
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(screen.getByLabelText('Search category'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveFocus();
  });

  it('does not select autocomplete suggestions on touch down or after a swipe', async () => {
    const change = vi.fn();
    render(
      <Autocomplete value="" options={['Apple', 'Banana']} onChange={change} label="Ingredient" />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: 'Ingredient' }));
    const option = screen.getByRole('option', { name: 'Banana' });
    fireEvent.pointerDown(option, { pointerType: 'touch' });
    expect(change).not.toHaveBeenCalled();
    fireEvent.pointerCancel(option, { pointerType: 'touch' });
    fireEvent.click(option, { detail: 1 });
    expect(change).not.toHaveBeenCalled();
    await userEvent.click(option);
    expect(change).toHaveBeenCalledExactlyOnceWith('Banana');
  });
});
