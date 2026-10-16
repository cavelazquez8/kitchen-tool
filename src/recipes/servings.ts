/** Target portions must be a finite positive decimal, never an inferred source yield. */
export function validRecipeServings(value: string): boolean {
  const text = value.trim();
  return (
    /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) &&
    Number.isFinite(Number(text)) &&
    Number(text) > 0
  );
}
