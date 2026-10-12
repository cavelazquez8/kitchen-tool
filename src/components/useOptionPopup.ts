import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

/** Native scrolling stays enabled. Dragged or cancelled pointers never commit an option. */
export function useOptionPopup(
  open: boolean,
  close: () => void,
  headerHeight = 0,
  dismissOutside = true,
) {
  const container = useRef<HTMLSpanElement>(null);
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [placement, setPlacement] = useState({
    above: false,
    maxHeight: 280,
    left: 16,
    top: 16,
    width: 320,
    viewportHeight: window.innerHeight,
    keyboardOffset: 0,
  });
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const position = () => {
      const bounds = container.current?.getBoundingClientRect();
      if (!bounds) return;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const below = top + height - bounds.bottom - 16;
      const above = bounds.top - top - 16;
      const useAbove = below < 280 + headerHeight && above > below;
      const maxHeight = Math.max(
        80,
        Math.min(320, Math.floor((useAbove ? above : below) - headerHeight - 16)),
      );
      const width = Math.min(Math.max(bounds.width, 320), window.innerWidth - 32);
      const next = {
        above: useAbove,
        maxHeight,
        width,
        viewportHeight: height,
        keyboardOffset: Math.max(0, window.innerHeight - height - top),
        left: Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16)),
        top: useAbove
          ? Math.max(top + 16, bounds.top - maxHeight - headerHeight - 16)
          : bounds.bottom + 8,
      };
      setPlacement((current) =>
        Object.keys(next).every(
          (key) => next[key as keyof typeof next] === current[key as keyof typeof current],
        )
          ? current
          : next,
      );
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    viewport?.addEventListener('resize', position);
    viewport?.addEventListener('scroll', position);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      viewport?.removeEventListener('resize', position);
      viewport?.removeEventListener('scroll', position);
    };
  }, [open, headerHeight]);
  useEffect(() => {
    if (!open || !dismissOutside) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, close, dismissOutside]);
  return {
    container,
    placement,
    blur(event: FocusEvent<HTMLSpanElement>) {
      // Dismissing a touch keyboard may blur without transferring focus.
      if (event.relatedTarget instanceof Node && !container.current?.contains(event.relatedTarget))
        close();
    },
    interaction: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        gesture.current = { x: event.clientX, y: event.clientY, moved: false };
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const start = gesture.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
          start.moved = true;
      },
      onPointerCancel() {
        if (gesture.current) gesture.current.moved = true;
      },
      onScroll() {
        if (gesture.current) gesture.current.moved = true;
      },
    },
    canSelect(event: MouseEvent<HTMLElement>) {
      return event.detail === 0 || !gesture.current?.moved;
    },
  };
}
