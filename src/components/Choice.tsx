import { useId, useState, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';
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
  const [active, setActive] = useState(
    Math.max(
      0,
      options.findIndex((option) => option.value === value),
    ),
  );
  function key(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive(
        (i) => (i + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length,
      );
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if ((event.key === 'Enter' || event.key === ' ') && open) {
      event.preventDefault();
      onChange(options[active].value);
      setOpen(false);
    }
  }
  return (
    <span className="autocomplete">
      <button
        type="button"
        className="choice-button"
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={id}
        aria-activedescendant={open ? id + '-' + active : undefined}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setOpen(false)}
        onKeyDown={key}
      >
        {options.find((o) => o.value === value)?.label ?? value}
        <ChevronDown size={16} />
      </button>
      {open && (
        <span className="autocomplete-options" id={id} role="listbox">
          {options.map((o, i) => (
            <span
              key={o.value}
              id={id + '-' + i}
              role="option"
              className={active === i ? 'active' : ''}
              aria-selected={value === o.value}
              onPointerDown={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
