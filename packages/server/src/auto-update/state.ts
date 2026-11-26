import type { Job } from "node-schedule";

/**
 * State the scheduled updates share in the process. Kept on globalThis
 * because this package is bundled twice (esbuild for server.ts, Next.js for
 * the API routes): module-level variables would give each copy its own, and
 * the routes would never see what startup set up (see db/index.ts).
 */
interface AutoUpdateState {
	dokployDeps: unknown;
	appDeps: unknown;
	jobs: Map<string, Job>;
	running: Set<string>;
}

const globalForAutoUpdate = globalThis as unknown as {
	__dokployAutoUpdate?: AutoUpdateState;
};

export const autoUpdateState = (): AutoUpdateState => {
	globalForAutoUpdate.__dokployAutoUpdate ??= {
		dokployDeps: null,
		appDeps: null,
		jobs: new Map(),
		running: new Set(),
	};
	return globalForAutoUpdate.__dokployAutoUpdate;
};

/** Runs `task` unless one with the same key is already running in the process. */
export const runOnce = async (key: string, task: () => Promise<void>) => {
	const { running } = autoUpdateState();
	if (running.has(key)) return;
	running.add(key);
	try {
		await task();
	} finally {
		running.delete(key);
	}
};

/** Replaces the job named `name`; `create` returns null to only cancel it. */
export const replaceJob = (name: string, create: () => Job | null) => {
	const { jobs } = autoUpdateState();
	jobs.get(name)?.cancel();
	jobs.delete(name);
	const job = create();
	if (job) jobs.set(name, job);
};
