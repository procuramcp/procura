/** Throughput settings for one limiter key. */
export type LimitSettings = {
  /** Sustained rate. Bursts up to this many requests are allowed, then it refills evenly. */
  requestsPerMinute: number;
  /** Requests in flight at once. */
  maxConcurrent: number;
};

export type Acquired = { ok: true; release: () => void } | { ok: false; retryAfterSeconds: number; reason: "rate" | "concurrency" | "cooldown" };

/**
 * Admission control in front of upstream calls. The in-memory version works
 * for one process; a Redis version (milestone 2) shares state across
 * instances. Never the source of truth for anything else.
 */
export interface RateLimiter {
  /** Take a slot under every key, or none of them. */
  acquire(keys: Array<{ key: string; limits: LimitSettings }>): Acquired;
  /** Upstream asked us to back off (429/503 with Retry-After): block the key until then. */
  coolDown(key: string, seconds: number): void;
}

type Bucket = { tokens: number; updatedMs: number; inFlight: number; cooldownUntilMs: number };

export class InMemoryRateLimiter implements RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #nowMs: () => number;

  constructor(options: { nowMs?: () => number } = {}) {
    this.#nowMs = options.nowMs ?? Date.now;
  }

  acquire(keys: Array<{ key: string; limits: LimitSettings }>): Acquired {
    const now = this.#nowMs();
    // Check everything first so a refusal takes nothing.
    for (const { key, limits } of keys) {
      const b = this.#bucket(key, limits, now);
      if (b.cooldownUntilMs > now) return { ok: false, reason: "cooldown", retryAfterSeconds: Math.ceil((b.cooldownUntilMs - now) / 1000) };
      if (b.inFlight >= limits.maxConcurrent) return { ok: false, reason: "concurrency", retryAfterSeconds: 1 };
      if (b.tokens < 1) {
        const perMs = limits.requestsPerMinute / 60_000;
        return { ok: false, reason: "rate", retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)) };
      }
    }
    const taken = keys.map(({ key }) => this.#buckets.get(key)!);
    for (const b of taken) {
      b.tokens -= 1;
      b.inFlight += 1;
    }
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        for (const b of taken) b.inFlight -= 1;
      },
    };
  }

  coolDown(key: string, seconds: number): void {
    const b = this.#buckets.get(key);
    if (!b) return;
    b.cooldownUntilMs = Math.max(b.cooldownUntilMs, this.#nowMs() + seconds * 1000);
  }

  #bucket(key: string, limits: LimitSettings, now: number): Bucket {
    let b = this.#buckets.get(key);
    if (!b) {
      b = { tokens: limits.requestsPerMinute, updatedMs: now, inFlight: 0, cooldownUntilMs: 0 };
      this.#buckets.set(key, b);
    }
    const refill = ((now - b.updatedMs) * limits.requestsPerMinute) / 60_000;
    b.tokens = Math.min(limits.requestsPerMinute, b.tokens + refill);
    b.updatedMs = now;
    return b;
  }
}

/**
 * Seconds to wait from a `Retry-After` header (delta-seconds or HTTP date).
 * Capped so a hostile upstream cannot lock a source for days.
 */
export function parseRetryAfter(value: string | null, nowMs: number, capSeconds = 3600): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const trimmed = value.trim();
  const seconds = /^\d+$/.test(trimmed) ? Number(trimmed) : (Date.parse(trimmed) - nowMs) / 1000;
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(capSeconds, Math.max(1, Math.ceil(seconds)));
}
