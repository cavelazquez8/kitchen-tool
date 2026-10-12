interface WorkerOutboundOptions extends RequestInit {
  cf: { cacheTtlByStatus: Record<string, number> };
}

export function workerOutboundOptions(
  headers: Record<string, string>,
  signal: AbortSignal,
): WorkerOutboundOptions {
  return {
    headers: {
      ...headers,
      'Cache-Control': 'no-cache, no-store',
      Pragma: 'no-cache',
    },
    // Request.cache requires a newer compatibility date than some dashboard Workers.
    // Explicit Cloudflare cache rules and origin headers also work on older dates.
    cf: { cacheTtlByStatus: { '200-599': -1 } },
    signal,
  };
}
