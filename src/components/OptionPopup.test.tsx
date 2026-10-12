import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Choice } from './Choice';
import { Autocomplete } from './Autocomplete';
import { Modal } from './Modal';

afterEach(cleanup);
const options = ['Breakfast', 'Dinner', 'Soup'].map((label) => ({ value: label, label }));
function setup() {
  const change = vi.fn();
  render(<Choice value="Breakfast" options={options} onChange={change} label="Category" />);
  return change;
}

describe('polished searchable selectors', () => {
  it('opens a labeled picker, preserves the current choice during search, and restores focus on selection', async () => {
    const change = setup();
    const user = userEvent.setup();
    const trigger = screen.getByRole('combobox', { name: 'Category' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Category' })).toBeInTheDocument();
    expect(screen.getByText('Selected: Breakfast')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search category'), 'sOu');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(change).not.toHaveBeenCalled();
    await user.click(screen.getByRole('option', { name: 'Soup' }));
    expect(change).toHaveBeenCalledExactlyOnceWith('Soup');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('ignores a touch swipe/cancellation and selects only a subsequent tap', async () => {
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

  it('supports empty searches, arrow navigation and keyboard selection', async () => {
    const change = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    const search = screen.getByLabelText('Search category');
    await user.type(search, 'unknown{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('No matching options');
    expect(change).not.toHaveBeenCalled();
    await user.clear(search);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(change).toHaveBeenCalledExactlyOnceWith('Dinner');
  });

  it('closes a nested picker with Escape while retaining the item editor and unfinished inputs', async () => {
    const close = vi.fn();
    render(
      <Modal open onClose={close} title="Edit item" description="Details">
        <input aria-label="Unfinished name" defaultValue="Milk" />
        <Choice value="Breakfast" options={options} onChange={vi.fn()} label="Category" />
      </Modal>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(screen.getByLabelText('Search category'));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Category' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Edit item' })).toBeInTheDocument();
    expect(screen.getByLabelText('Unfinished name')).toHaveValue('Milk');
    expect(close).not.toHaveBeenCalled();
  });

  it('allows autocomplete scrolling without choosing an item or dismissing on keyboard blur', async () => {
    const change = vi.fn();
    render(
      <Autocomplete value="" options={['Apple', 'Banana']} onChange={change} label="Ingredient" />,
    );
    const input = screen.getByRole('combobox', { name: 'Ingredient' });
    await userEvent.click(input);
    const option = screen.getByRole('option', { name: 'Banana' });
    fireEvent.pointerDown(option, { pointerType: 'touch' });
    fireEvent.pointerCancel(option, { pointerType: 'touch' });
    fireEvent.click(option, { detail: 1 });
    fireEvent.blur(input, { relatedTarget: null });
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.click(option);
    expect(change).toHaveBeenCalledExactlyOnceWith('Banana');
  });
});
