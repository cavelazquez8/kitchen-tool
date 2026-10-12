import { useEffect, useMemo, useState } from 'react';
import { combineFoodNames, loadFoodNames } from './catalog';
const EMPTY: readonly string[] = [];

export function useFoodCatalog(recent: readonly string[] = EMPTY, enabled = true) {
  const [extra, setExtra] = useState<readonly string[]>(EMPTY);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setLoading(true);
    void loadFoodNames()
      .then((names) => {
        if (alive) setExtra(names);
      })
      .catch(() => {
        // The local common catalog and arbitrary typed names always remain usable.
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  const names = useMemo(() => combineFoodNames(extra, recent), [extra, recent]);
  return { names, expanded: extra.length > 0, loading };
}
