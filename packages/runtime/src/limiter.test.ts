import { describe, expect, it } from "vitest";
import { InMemoryRateLimiter, parseRetryAfter } from "./limiter.ts";

const limits = { requestsPerMinute: 2, maxConcurrent: 5 };

describe("InMemoryRateLimiter", () => {
  it("forgets idle, refilled buckets so memory stays bounded", () => {
    let now = 0;
    const l = new InMemoryRateLimiter({ nowMs: () => now });
    const busy = l.acquire([{ key: "busy", limits }]);
    for (let i = 0; i < 998; i++) {
      const slot = l.acquire([{ key: `tenant-${i}`, limits }]);
      if (slot.ok) slot.release();
    }
    expect(l.size).toBe(999);
    now += 60_000; // everything refills
    l.acquire([{ key: "next", limits }]); // the 1000th acquire sweeps first
    // Kept: "busy" (still in flight) and "next" (created after the sweep).
    expect(l.size).toBe(2);
    if (busy.ok) busy.release();
  });

  it("allows a burst up to the per-minute limit, then refills evenly", () => {
    let now = 0;
    const l = new InMemoryRateLimiter({ nowMs: () => now });
    const k = [{ key: "a", limits }];
    expect(l.acquire(k).ok).toBe(true);
    expect(l.acquire(k).ok).toBe(true);
    expect(l.acquire(k)).toMatchObject({ ok: false, reason: "rate", retryAfterSeconds: 30 });
    now += 30_000;
    expect(l.acquire(k).ok).toBe(true);
  });

  it("caps concurrency and frees the slot on release (once)", () => {
    const l = new InMemoryRateLimiter({ nowMs: () => 0 });
    const k = [{ key: "a", limits: { requestsPerMinute: 100, maxConcurrent: 1 } }];
    const first = l.acquire(k);
    expect(l.acquire(k)).toMatchObject({ ok: false, reason: "concurrency" });
    if (!first.ok) throw new Error();
    first.release();
    first.release();
    expect(l.acquire(k).ok).toBe(true);
    expect(l.acquire(k).ok).toBe(false);
  });

  it("takes from every key or none", () => {
    const l = new InMemoryRateLimiter({ nowMs: () => 0 });
    const tight = { key: "source", limits: { requestsPerMinute: 1, maxConcurrent: 5 } };
    expect(l.acquire([{ key: "tenant-a", limits }, tight]).ok).toBe(true);
    expect(l.acquire([{ key: "tenant-b", limits }, tight]).ok).toBe(false);
    // tenant-b was refused, so its own budget is untouched: two more fit once the source refills.
    expect(l.acquire([{ key: "tenant-b", limits }]).ok).toBe(true);
    expect(l.acquire([{ key: "tenant-b", limits }]).ok).toBe(true);
  });

  it("honors upstream cool-downs", () => {
    let now = 0;
    const l = new InMemoryRateLimiter({ nowMs: () => now });
    const k = [{ key: "a", limits }];
    expect(l.acquire(k).ok).toBe(true);
    l.coolDown("a", 10);
    expect(l.acquire(k)).toMatchObject({ ok: false, reason: "cooldown", retryAfterSeconds: 10 });
    now += 10_000;
    expect(l.acquire(k).ok).toBe(true);
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  it.each([
    ["30", 30],
    ["0", 1],
    ["Fri, 30 Oct 2026 12:01:00 GMT", 60],
    ["999999", 3600],
    ["soon", undefined],
    [null, undefined],
  ])("%s → %s", (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
});
