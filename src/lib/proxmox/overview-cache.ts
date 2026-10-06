/**
 * In-memory cluster overview cache with singleflight.
 * Many dashboard polls + Alexa share one Proxmox fan-out per TTL window.
 */

const DEFAULT_TTL_MS = 4_000;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export function overviewCacheKey(serverId?: string | null): string {
  return serverId?.trim() || "__active__";
}

export async function getCachedOverview<T>(
  key: string,
  loader: () => Promise<T>,
  options?: { ttlMs?: number; force?: boolean },
): Promise<{ value: T; cached: boolean; fetchedAt: number; ageMs: number }> {
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const now = Date.now();

  if (!options?.force) {
    const hit = cache.get(key) as CacheEntry<T> | undefined;
    if (hit && hit.expiresAt > now) {
      return {
        value: hit.value,
        cached: true,
        fetchedAt: hit.fetchedAt,
        ageMs: now - hit.fetchedAt,
      };
    }
  }

  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing && !options?.force) {
    const value = await existing;
    const hit = cache.get(key) as CacheEntry<T> | undefined;
    return {
      value,
      cached: true,
      fetchedAt: hit?.fetchedAt ?? Date.now(),
      ageMs: hit ? Date.now() - hit.fetchedAt : 0,
    };
  }

  const pending = loader().then((value) => {
    const fetchedAt = Date.now();
    cache.set(key, {
      value,
      fetchedAt,
      expiresAt: fetchedAt + ttlMs,
    });
    return value;
  });

  inflight.set(key, pending);
  try {
    const value = await pending;
    const hit = cache.get(key) as CacheEntry<T> | undefined;
    return {
      value,
      cached: false,
      fetchedAt: hit?.fetchedAt ?? Date.now(),
      ageMs: 0,
    };
  } finally {
    inflight.delete(key);
  }
}

export function invalidateOverviewCache(serverId?: string | null): void {
  if (serverId) {
    cache.delete(overviewCacheKey(serverId));
    inflight.delete(overviewCacheKey(serverId));
  }
  // Active server key is always used by default callers.
  cache.delete("__active__");
  inflight.delete("__active__");
}

export function clearOverviewCache(): void {
  cache.clear();
  inflight.clear();
}
