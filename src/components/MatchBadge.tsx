import { readinessBadge, type RecipeMatch } from '../recipes/matching';

export function MatchBadge({ match }: { match: Pick<RecipeMatch, 'status' | 'missingCount'> }) {
  const badge = readinessBadge(match);
  return <span className={`match-badge ${badge.tone}`}>{badge.label}</span>;
}
