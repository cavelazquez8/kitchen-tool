import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';

/** Leave touch gestures native; commit a choice only after a completed tap. */
export function useOptionPopup(open: boolean, close: () => void, searchHeight = 0) {
  const container = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState({ above: false, maxHeight: 260 });
  const gesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const position = () => {
      const bounds = container.current?.getBoundingClientRect();
      if (!bounds) return;
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const margin = window.innerWidth <= 650 ? 76 : 16;
      const below = top + height - bounds.bottom - margin;
      const above = bounds.top - top - 16;
      const useAbove = below < 260 + searchHeight && above > below;
      const maxHeight = Math.max(
        80,
        Math.min(260, Math.floor((useAbove ? above : below) - searchHeight - 12)),
      );
      setPlacement((current) =>
        current.above === useAbove && current.maxHeight === maxHeight
          ? current
          : { above: useAbove, maxHeight },
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
  }, [open, searchHeight]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open, close]);
  return {
    container,
    placement,
    blur(event: FocusEvent<HTMLSpanElement>) {
      // Touch scrolling can blur the keyboard without moving focus to another control.
      if (event.relatedTarget instanceof Node && !container.current?.contains(event.relatedTarget))
        close();
    },
    interaction: {
      onPointerDown(event: PointerEvent<HTMLSpanElement>) {
        gesture.current = { x: event.clientX, y: event.clientY, moved: false };
      },
      onPointerMove(event: PointerEvent<HTMLSpanElement>) {
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
    canSelect(event: MouseEvent<HTMLSpanElement>) {
      return event.detail === 0 || !gesture.current?.moved;
    },
  };
}
