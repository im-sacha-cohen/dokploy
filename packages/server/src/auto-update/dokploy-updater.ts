import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { paths } from "../constants";
import { db } from "../db";
import { type UpdateRun, updateRun } from "../db/schema/auto-update";
import {
	sendUpdateNotifications,
	type UpdateNoticeOutcome,
} from "../utils/notifications/auto-update";
import { execAsync } from "../utils/process/execAsync";
import { spawnAsync } from "../utils/process/spawnAsync";
import { runOnce } from "./state";

/**
 * Panel side of scripts/dokploy-updater.sh: starts it in a container of its
 * own and turns its state.json into update_run rows and notifications.
 */

export const UPDATER_CONTAINER = "dokploy-updater";
const UPDATER_SCRIPT = "/app/dokploy-updater.sh";
const WATCH_INTERVAL_MS = 30_000;

export type UpdaterStatus =
	| "backing_up"
	| "updating"
	| "verifying"
	| "restoring"
	| "succeeded"
	| "rolled_back"
	| "aborted"
	| "failed";

export interface UpdaterState {
	runId: string;
	kind: "update" | "rollback";
	status: UpdaterStatus;
	changed: boolean;
	fromImage: string;
	toImage: string;
	runDir: string;
	sourceRun: string;
	startedAt: string;
	updatedAt: string;
	message: string;
}

const FINAL: UpdaterStatus[] = [
	"succeeded",
	"rolled_back",
	"aborted",
	"failed",
];
export const isFinalUpdaterStatus = (status: UpdaterStatus) =>
	FINAL.includes(status);

const updatesDir = () => path.join(paths().BASE_PATH, "updates");

export const readUpdaterState = async (): Promise<UpdaterState | null> => {
	try {
		return JSON.parse(
			await readFile(path.join(updatesDir(), "state.json"), "utf8"),
		) as UpdaterState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
};

export const isUpdaterRunning = async () => {
	const { stdout } = await execAsync(
		`docker ps -q --filter name=^${UPDATER_CONTAINER}$`,
	);
	return stdout.trim().length > 0;
};

/** True while a run is unfinished, even when its updater has stopped. */
export const isDokployUpdateBusy = async () => {
	const state = await readUpdaterState();
	if (state && !isFinalUpdaterStatus(state.status)) return true;
	return isUpdaterRunning();
};

export const imageHasUpdater = async (image: string) => {
	try {
		await spawnAsync("docker", [
			"run",
			"--rm",
			"--entrypoint",
			"test",
			image,
			"-f",
			UPDATER_SCRIPT,
		]);
		return true;
	} catch {
		return false;
	}
};

/** Same shape as the script's own run ids: sortable by start time. */
const newUpdaterRunId = () =>
	`${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${nanoid(6)}`;

/**
 * Starts the updater from `image`, which must be one that works now.
 * `verifyMinutes`: how long the new version must stay healthy (the script's
 * default when omitted).
 */
export const launchUpdater = async (
	image: string,
	args: string[],
	verifyMinutes?: number,
) => {
	const base = paths().BASE_PATH;
	await spawnAsync("docker", [
		"run",
		"-d",
		"--rm",
		// The image's own healthcheck probes the panel, which does not run here.
		"--no-healthcheck",
		"--name",
		UPDATER_CONTAINER,
		...(verifyMinutes
			? ["-e", `UPDATER_VERIFY_SECONDS=${Math.round(verifyMinutes * 60)}`]
			: []),
		"-v",
		"/var/run/docker.sock:/var/run/docker.sock",
		"-v",
		`${base}:${base}`,
		image,
		"bash",
		UPDATER_SCRIPT,
		...args,
	]);
};

const NOTICE: Record<
	UpdaterStatus | "interrupted",
	{ title: string; outcome: UpdateNoticeOutcome }
> = {
	backing_up: { title: "Dokploy update started", outcome: "info" },
	updating: { title: "Dokploy update started", outcome: "info" },
	verifying: { title: "Dokploy update started", outcome: "info" },
	restoring: { title: "Dokploy update being put back", outcome: "failure" },
	succeeded: { title: "Dokploy updated", outcome: "success" },
	rolled_back: {
		title: "Dokploy update failed: the previous version runs again",
		outcome: "failure",
	},
	aborted: { title: "Dokploy update not started", outcome: "failure" },
	failed: {
		title: "Dokploy update failed and could not be put back",
		outcome: "failure",
	},
	interrupted: { title: "Dokploy update interrupted", outcome: "failure" },
};

export const notifyDokployRun = async (
	run: Pick<UpdateRun, "status" | "kind" | "fromImage" | "toImage" | "reason">,
) => {
	const notice = NOTICE[run.status as UpdaterStatus | "interrupted"] ?? {
		title: `Dokploy update: ${run.status}`,
		outcome: "info" as const,
	};
	const title =
		run.kind === "rollback" && run.status === "succeeded"
			? "Dokploy rolled back"
			: notice.title;
	await sendUpdateNotifications({
		event: "dokployUpdate",
		title,
		outcome: notice.outcome,
		facts: [
			{ name: "From", value: run.fromImage || "unknown" },
			{ name: "To", value: run.toImage || "unknown" },
			...(run.reason ? [{ name: "Details", value: run.reason }] : []),
		],
	});
};

const findRun = (updaterRunId: string) =>
	db.query.updateRun.findFirst({
		where: eq(updateRun.updaterRunId, updaterRunId),
	});

/**
 * Brings the run of the last updater state up to date. Called at startup,
 * where the database may have just been restored to before the run, and
 * while an updater works. Manual runs (from the shell) get a row too.
 */
export const reconcileDokployUpdater = async (): Promise<
	"idle" | "running" | "interrupted"
> => {
	const state = await readUpdaterState();
	if (!state) return "idle";

	let run = await findRun(state.runId);
	if (!run) {
		[run] = await db
			.insert(updateRun)
			.values({
				targetType: "dokploy",
				kind: state.kind,
				status: state.status,
				fromImage: state.fromImage,
				toImage: state.toImage,
				reason: state.message || null,
				updaterRunId: state.runId,
				startedAt: state.startedAt,
			})
			.returning();
	}
	if (!run) return "idle";

	if (isFinalUpdaterStatus(state.status)) {
		if (!run.finishedAt) {
			const [updated] = await db
				.update(updateRun)
				.set({
					status: state.status,
					reason: state.message || null,
					fromImage: state.fromImage,
					toImage: state.toImage,
					finishedAt: state.updatedAt,
				})
				.where(eq(updateRun.updateRunId, run.updateRunId))
				.returning();
			if (updated) await notifyDokployRun(updated);
		}
		return "idle";
	}

	if (await isUpdaterRunning()) {
		if (run.status !== state.status) {
			await db
				.update(updateRun)
				.set({ status: state.status })
				.where(eq(updateRun.updateRunId, run.updateRunId));
		}
		return "running";
	}

	if (run.status !== "interrupted") {
		const [updated] = await db
			.update(updateRun)
			.set({
				status: "interrupted",
				reason: `The updater stopped while ${state.status.replace("_", " ")}. Resume it to put back the version that ran before.`,
			})
			.where(eq(updateRun.updateRunId, run.updateRunId))
			.returning();
		if (updated) await notifyDokployRun(updated);
	}
	return "interrupted";
};

/** Follows a running updater until its run is finished or interrupted. */
export const watchDokployUpdater = () =>
	runOnce("dokploy-updater-watch", async () => {
		for (;;) {
			const status = await reconcileDokployUpdater().catch((error) => {
				console.error("[auto-update] Reading the updater state failed:", error);
				return "running" as const;
			});
			if (status !== "running") return;
			await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
		}
	});

/**
 * Restarts an interrupted run in --resume mode, from the image that ran
 * before it: that one is known to work, the current one may not.
 */
export const resumeDokployUpdate = async (currentImage: string) => {
	const state = await readUpdaterState();
	if (!state || isFinalUpdaterStatus(state.status)) {
		throw new Error("No interrupted Dokploy update to resume.");
	}
	if (await isUpdaterRunning()) {
		throw new Error("The updater is still running.");
	}
	const image = (await imageHasUpdater(state.fromImage))
		? state.fromImage
		: currentImage;
	await launchUpdater(image, ["--resume"]);
	const run = await findRun(state.runId);
	if (run) {
		await db
			.update(updateRun)
			.set({ status: "restoring" })
			.where(eq(updateRun.updateRunId, run.updateRunId));
	}
	void watchDokployUpdater();
};

/**
 * Records a run, then starts the updater for it from `currentImage`. The
 * row is written first so that the updater's database backup holds it:
 * after a restore, startup finds it and records the outcome there.
 */
export const startDokployUpdater = async ({
	currentImage,
	args,
	kind,
	toImage,
	updatePolicyId = null,
	verifyMinutes,
}: {
	currentImage: string;
	args: string[];
	kind: UpdateRun["kind"];
	toImage: string;
	updatePolicyId?: string | null;
	verifyMinutes?: number;
}) => {
	const updaterRunId = newUpdaterRunId();
	const [run] = await db
		.insert(updateRun)
		.values({
			updatePolicyId,
			targetType: "dokploy",
			kind,
			status: "backing_up",
			fromImage: currentImage,
			toImage,
			updaterRunId,
		})
		.returning();
	try {
		await launchUpdater(
			currentImage,
			[...args, "--run-id", updaterRunId],
			verifyMinutes,
		);
	} catch (error) {
		if (run) {
			const [updated] = await db
				.update(updateRun)
				.set({
					status: "aborted",
					reason: `The updater did not start: ${error}`,
					finishedAt: new Date().toISOString(),
				})
				.where(eq(updateRun.updateRunId, run.updateRunId))
				.returning();
			if (updated) await notifyDokployRun(updated);
		}
		throw error;
	}
	void watchDokployUpdater();
	return run;
};

const hasBackup = async (updaterRunId: string) => {
	try {
		await access(path.join(updatesDir(), "runs", updaterRunId, "dokploy.sql"));
		return true;
	} catch {
		return false;
	}
};

/** Successful updates whose saved state is still on disk (the last runs). */
export const findRollbackableRuns = async () => {
	const runs = await db.query.updateRun.findMany({
		where: and(
			eq(updateRun.targetType, "dokploy"),
			eq(updateRun.kind, "update"),
			eq(updateRun.status, "succeeded"),
		),
		orderBy: desc(updateRun.startedAt),
		limit: 10,
	});
	const kept = await Promise.all(
		runs.map(async (run) =>
			run.updaterRunId && (await hasBackup(run.updaterRunId)) ? run : null,
		),
	);
	return kept.filter((run): run is UpdateRun => run !== null);
};

/**
 * Puts back Dokploy as it was before a successful update: its image, its
 * configuration and its database, so changes made in the panel since that
 * update are lost. The updater saves the current state first.
 */
export const rollbackDokployTo = async (
	updaterRunId: string,
	currentImage: string,
) => {
	if (await isDokployUpdateBusy()) {
		throw new Error("A Dokploy update is running or waits to be resumed.");
	}
	const run = (await findRollbackableRuns()).find(
		(r) => r.updaterRunId === updaterRunId,
	);
	if (!run) {
		throw new Error("This update cannot be rolled back: its backup is gone.");
	}
	if (!(await imageHasUpdater(currentImage))) {
		throw new Error("The running image has no updater.");
	}
	return startDokployUpdater({
		currentImage,
		args: ["--rollback", updaterRunId],
		kind: "rollback",
		toImage: run.fromImage ?? "",
	});
};
