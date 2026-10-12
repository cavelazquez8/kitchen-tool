import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useOptionPopup } from './useOptionPopup';

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
  const list = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const popup = useOptionPopup(open, close, 70);
  const matches = options.filter((option) =>
    option.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const activeIndex = Math.min(active, matches.length - 1);
  const current = matches[activeIndex];
  useEffect(() => {
    if (open && activeIndex >= 0)
      list.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);
  function choose(option: (typeof options)[number]) {
    onChange(option.value);
    close();
    trigger.current?.focus();
  }
  function key(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setQuery('');
        setActive(
          Math.max(
            0,
            options.findIndex((option) => option.value === value),
          ),
        );
        setOpen(true);
        return;
      }
      setOpen(true);
      setActive((index) =>
        matches.length
          ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length
          : 0,
      );
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      trigger.current?.focus();
    } else if (event.key === 'Enter' && open && current) {
      event.preventDefault();
      choose(current);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
    }
  }
  return (
    <span className="autocomplete" ref={popup.container} onBlur={popup.blur}>
      <button
        type="button"
        className="choice-button"
        ref={trigger}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open && current ? `${id}-${activeIndex}` : undefined}
        onClick={() => {
          if (open) close();
          else {
            setQuery('');
            setActive(
              Math.max(
                0,
                options.findIndex((option) => option.value === value),
              ),
            );
            setOpen(true);
          }
        }}
        onKeyDown={key}
      >
        {options.find((option) => option.value === value)?.label ?? value}
        <ChevronDown size={16} />
      </button>
      {open && (
        <span className={`choice-popup ${popup.placement.above ? 'options-above' : ''}`}>
          <input
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-activedescendant={current ? `${id}-${activeIndex}` : undefined}
            aria-label={`Search ${label.toLowerCase()}`}
            value={query}
            placeholder="Search options…"
            autoComplete="off"
            aria-controls={id}
            onKeyDown={key}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          <span
            className="autocomplete-options choice-options"
            id={id}
            role="listbox"
            aria-label={`${label} options`}
            ref={list}
            style={{ maxHeight: popup.placement.maxHeight }}
            {...popup.interaction}
          >
            {matches.map((option, index) => (
              <span
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
                {option.label}
              </span>
            ))}
          </span>
          {!matches.length && (
            <span className="choice-empty" role="status">
              No matching options.
            </span>
          )}
        </span>
      )}
    </span>
  );
}
