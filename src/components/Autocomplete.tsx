import { useCallback, useId, useState, type KeyboardEvent } from 'react';
import { useOptionPopup } from './useOptionPopup';

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
  const close = useCallback(() => {
    setOpen(false);
    setActive(-1);
  }, []);
  const popup = useOptionPopup(open, close);
  const matches = [...new Set(options)]
    .filter((option) => option.toLowerCase().includes(value.trim().toLowerCase()))
    .slice(0, 8);
  function choose(option: string) {
    onChange(option);
    setOpen(false);
    setActive(-1);
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive(
        (current) =>
          (current + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) %
          Math.max(1, matches.length),
      );
    } else if (event.key === 'Enter' && open && active >= 0 && matches[active]) {
      event.preventDefault();
      choose(matches[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }
  return (
    <span className="autocomplete" ref={popup.container} onBlur={popup.blur}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open && matches.length > 0}
        aria-controls={id}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? id + '-' + active : undefined}
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
          className={`autocomplete-options ${popup.placement.above ? 'options-above' : ''}`}
          style={{ maxHeight: popup.placement.maxHeight }}
          {...popup.interaction}
        >
          {matches.map((option, index) => (
            <span
              key={option}
              id={id + '-' + index}
              role="option"
              aria-selected={active === index}
              className={active === index ? 'active' : ''}
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
