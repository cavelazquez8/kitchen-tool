import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import { useOptionPopup } from './useOptionPopup';
import './selectors.css';

export function Choice({
  value,
  options,
  onChange,
  label,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  label: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const popup = useOptionPopup(open, () => setOpen(false), 150, false);
  const term = query.trim().toLocaleLowerCase();
  const matches = options.filter((option) => option.label.toLocaleLowerCase().includes(term));
  const activeIndex = Math.min(active, matches.length - 1);
  const current = matches[activeIndex];
  const selected = options.find((option) => option.value === value);
  useEffect(() => {
    if (open && activeIndex >= 0)
      list.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, query]);
  function changeOpen(next: boolean) {
    if (next) {
      setQuery('');
      setActive(
        Math.max(
          0,
          options.findIndex((option) => option.value === value),
        ),
      );
    }
    setOpen(next);
  }
  function choose(option: (typeof options)[number]) {
    onChange(option.value);
    setOpen(false);
  }
  function key(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) =>
        matches.length
          ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
          : 0,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current) choose(current);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }
  return (
    <span className="mise-selector" ref={popup.container}>
      <Dialog.Root open={open} onOpenChange={changeOpen}>
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="choice-button"
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={id}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                changeOpen(true);
              }
            }}
          >
            <span>{selected?.label ?? value}</span>
            <ChevronDown size={17} aria-hidden="true" />
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="selector-backdrop" />
          <Dialog.Content
            className="selector-panel"
            style={
              {
                '--selector-left': `${popup.placement.left}px`,
                '--selector-top': `${popup.placement.top}px`,
                '--selector-width': `${popup.placement.width}px`,
                '--selector-list-height': `${popup.placement.maxHeight}px`,
                '--selector-viewport-height': `${popup.placement.viewportHeight}px`,
                '--selector-keyboard-offset': `${popup.placement.keyboardOffset}px`,
              } as CSSProperties
            }
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              // Show phone options before asking for the software keyboard.
              if (window.matchMedia?.('(max-width: 650px)').matches) heading.current?.focus();
              else search.current?.focus();
            }}
          >
            <div className="selector-heading">
              <div>
                <Dialog.Title asChild>
                  <h3 ref={heading} tabIndex={-1} onKeyDown={key}>
                    {label}
                  </h3>
                </Dialog.Title>
                <Dialog.Description>
                  {selected?.label ? `Selected: ${selected.label}` : 'Choose an option'}
                </Dialog.Description>
              </div>
              <Dialog.Close
                className="selector-close"
                aria-label={`Close ${label.toLowerCase()} options`}
              >
                <X size={19} />
              </Dialog.Close>
            </div>
            <div className="selector-search">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                ref={search}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={true}
                aria-activedescendant={current ? `${id}-${activeIndex}` : undefined}
                aria-label={`Search ${label.toLowerCase()}`}
                value={query}
                placeholder="Search options"
                autoComplete="off"
                aria-controls={id}
                onKeyDown={key}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
              />
            </div>
            <div
              className="selector-options"
              id={id}
              role="listbox"
              aria-label={`${label} options`}
              ref={list}
              {...popup.interaction}
            >
              {matches.map((option, index) => (
                <div
                  key={option.value}
                  id={`${id}-${index}`}
                  role="option"
                  className={activeIndex === index ? 'active' : ''}
                  aria-selected={value === option.value}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    if (popup.canSelect(event)) choose(option);
                  }}
                >
                  <span>{option.label}</span>
                  {value === option.value && <Check size={18} aria-hidden="true" />}
                </div>
              ))}
            </div>
            {!matches.length && (
              <p className="selector-empty" role="status">
                No matching options. Try a different search.
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </span>
  );
}
