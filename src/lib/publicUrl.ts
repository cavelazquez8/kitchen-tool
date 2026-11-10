/**
 * Resolves a file from `public/` against the deployed base path, so the app works at the
 * site root (local development) and under a project path such as `/kitchen-tool/`.
 */
export function publicUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`;
}
