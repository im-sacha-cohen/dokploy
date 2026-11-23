// Two domains created at once would each write back the route list they read,
// and the second would drop the first one's route.
const locks = new Map<string, Promise<unknown>>();

export const withTunnelLock = <T>(tunnelId: string, task: () => Promise<T>) => {
	const previous = locks.get(tunnelId) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(task);
	locks.set(tunnelId, next);
	void next
		.catch(() => undefined)
		.finally(() => {
			if (locks.get(tunnelId) === next) locks.delete(tunnelId);
		});
	return next;
};
