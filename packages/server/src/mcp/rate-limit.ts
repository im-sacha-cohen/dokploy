/**
 * Fixed-window, in-process rate limiter. Dokploy runs as a single process, so
 * memory is enough; a multi-instance deployment would need a shared store.
 */
export class RateLimiter {
	private readonly windows = new Map<
		string,
		{ start: number; count: number }
	>();

	constructor(
		private readonly limit: number,
		private readonly windowMs: number,
	) {}

	/** Returns the seconds to wait, or 0 when the call is allowed. */
	hit(key: string, now = Date.now()): number {
		const current = this.windows.get(key);
		if (!current || now - current.start >= this.windowMs) {
			this.windows.set(key, { start: now, count: 1 });
			this.prune(now);
			return 0;
		}
		if (current.count >= this.limit) {
			return Math.ceil((current.start + this.windowMs - now) / 1000);
		}
		current.count++;
		return 0;
	}

	private prune(now: number) {
		if (this.windows.size < 10_000) return;
		for (const [key, value] of this.windows) {
			if (now - value.start >= this.windowMs) this.windows.delete(key);
		}
	}
}

/** All MCP requests per user+client. */
export const requestLimiter = new RateLimiter(120, 60_000);
/** Deploy/config mutations per user+client. */
export const mutationLimiter = new RateLimiter(10, 60_000);
/** Unauthenticated requests per IP (token probing). */
export const anonymousLimiter = new RateLimiter(30, 60_000);
