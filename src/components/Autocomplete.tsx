import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useOptionPopup } from './useOptionPopup';
import { searchFoodNames } from '../food/catalog';
import './selectors.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  placeholder?: string;
  required?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  label?: string;
}
export function Autocomplete({
  value,
  onChange,
  options,
  placeholder,
  required,
  autoFocus,
  maxLength = 120,
  label,
}: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);
  const popup = useOptionPopup(open, close);
  const matches = searchFoodNames(value, options, 12);
  const activeIndex = Math.min(active, matches.length - 1);
  useEffect(() => {
    if (open && activeIndex >= 0)
      list.current?.children[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex]);
  function choose(option: string) {
    onChange(option);
    close();
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        if (!matches.length) return -1;
        if (current < 0) return event.key === 'ArrowDown' ? 0 : matches.length - 1;
        return (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      });
    } else if (event.key === 'Enter' && open && activeIndex >= 0 && matches[activeIndex]) {
      event.preventDefault();
      choose(matches[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }
  return (
    <span className="mise-selector autocomplete" ref={popup.container} onBlur={popup.blur}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open && matches.length > 0}
        aria-controls={id}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        required={required}
        maxLength={maxLength}
        value={value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={key}
      />
      {open && matches.length > 0 && (
        <span
          id={id}
          role="listbox"
          ref={list}
          className={`autocomplete-options suggestion-options ${popup.placement.above ? 'options-above' : ''}`}
          style={{ maxHeight: popup.placement.maxHeight }}
          {...popup.interaction}
        >
          {matches.map((option, index) => (
            <span
              key={option}
              id={`${id}-${index}`}
              role="option"
              aria-selected={activeIndex === index}
              className={activeIndex === index ? 'active' : ''}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                if (popup.canSelect(event)) choose(option);
              }}
            >
              {option}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
