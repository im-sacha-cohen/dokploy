import { and, eq, gte, inArray } from "drizzle-orm";
import { RecurrenceRule, scheduleJob } from "node-schedule";
import { db } from "../db";
import {
	type UpdatePolicy,
	type UpdateRun,
	updateRun,
} from "../db/schema/auto-update";
import { deployments } from "../db/schema/deployment";
import {
	findDokployUpdatePolicy,
	policyWindow,
} from "../services/update-policy";
import { sendUpdateNotifications } from "../utils/notifications/auto-update";
import { execAsync } from "../utils/process/execAsync";
import { checkDokployUpdate } from "./dokploy-check";
import {
	imageHasUpdater,
	isDokployUpdateBusy,
	notifyDokployRun,
	reconcileDokployUpdater,
	startDokployUpdater,
	watchDokployUpdater,
} from "./dokploy-updater";
import { autoUpdateState, replaceJob, runOnce } from "./state";
import { currentOrNextOccurrence, type WindowOccurrence } from "./window";

const JOB_NAME = "dokploy-auto-update";
const RETRY_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const IN_PROGRESS: UpdateRun["status"][] = [
	"backing_up",
	"updating",
	"verifying",
	"restoring",
];

export interface DokployAutoUpdateDeps {
	currentVersion: string;
	/** Jobs waiting or running in the deployment queue, which lives in the app. */
	pendingDeploymentJobs: () => Promise<number>;
}

const getDeps = () =>
	autoUpdateState().dokployDeps as DokployAutoUpdateDeps | null;

type Attempt = { wait: false } | { wait: true; reasons: string[] };
const DONE: Attempt = { wait: false };

const runsSince = (since: Date, toImage?: string) =>
	db.query.updateRun.findMany({
		where: and(
			eq(updateRun.targetType, "dokploy"),
			gte(updateRun.startedAt, since.toISOString()),
			...(toImage ? [eq(updateRun.toImage, toImage)] : []),
		),
	});

/** One row per window and reason, so that waiting does not flood the history. */
const recordOnce = async (
	policy: UpdatePolicy,
	occurrence: WindowOccurrence,
	status: "skipped" | "aborted",
	fromImage: string,
	toImage: string,
	reason: string,
) => {
	const existing = await runsSince(occurrence.start, toImage);
	if (existing.some((r) => r.status === status && r.reason === reason)) return;
	const now = new Date().toISOString();
	const [run] = await db
		.insert(updateRun)
		.values({
			updatePolicyId: policy.updatePolicyId,
			targetType: "dokploy",
			status,
			fromImage,
			toImage,
			reason,
			startedAt: now,
			finishedAt: now,
		})
		.returning();
	return run;
};

/** Why the update cannot start now; empty when it can. */
const blockers = async () => {
	const reasons: string[] = [];
	const deps = getDeps();
	if (!deps) return ["The scheduler is not initialised."];
	if ((await deps.pendingDeploymentJobs()) > 0) {
		reasons.push("deployments are queued or running");
	}
	const running = await db.query.deployments.findMany({
		where: and(
			eq(deployments.status, "running"),
			gte(
				deployments.createdAt,
				new Date(Date.now() - 6 * HOUR_MS).toISOString(),
			),
		),
		columns: { deploymentId: true },
	});
	if (running.length > 0) {
		reasons.push("a deployment, backup or scheduled job is running");
	}
	const appRuns = await db.query.updateRun.findMany({
		where: and(
			eq(updateRun.targetType, "application"),
			inArray(updateRun.status, IN_PROGRESS),
		),
		columns: { updateRunId: true },
	});
	if (appRuns.length > 0) reasons.push("an application update is running");
	try {
		await execAsync("docker service inspect dokploy --format '{{.ID}}'");
	} catch {
		reasons.push("Dokploy does not run as the Swarm service `dokploy`");
	}
	return reasons;
};

const attempt = async (
	policy: UpdatePolicy,
	occurrence: WindowOccurrence,
): Promise<Attempt> => {
	const deps = getDeps();
	if (!deps || (await isDokployUpdateBusy())) return DONE;

	let check: Awaited<ReturnType<typeof checkDokployUpdate>>;
	try {
		check = await checkDokployUpdate(deps.currentVersion, policy.versionRule);
	} catch (error) {
		return { wait: true, reasons: [`the update check failed: ${error}`] };
	}
	if (!check.available) return DONE;
	const { currentImage, targetImage, label } = check;
	const skip = (reason: string) =>
		recordOnce(
			policy,
			occurrence,
			"skipped",
			currentImage,
			targetImage,
			reason,
		);

	if (!check.allowed) {
		await skip(`${label} is beyond the "${policy.versionRule}" version rule.`);
		return DONE;
	}

	const sameTarget = await db.query.updateRun.findMany({
		where: and(
			eq(updateRun.targetType, "dokploy"),
			eq(updateRun.toImage, targetImage),
		),
	});
	if (
		sameTarget.some((r) => r.status === "rolled_back" || r.status === "failed")
	) {
		await skip(`${label} failed before; waiting for a newer build.`);
		return DONE;
	}

	const firstSeen = sameTarget
		.map((r) => new Date(r.startedAt))
		.sort((a, b) => a.getTime() - b.getTime())[0];
	const publishedAt = check.createdAt ?? firstSeen ?? new Date();
	const ageHours = (Date.now() - publishedAt.getTime()) / HOUR_MS;
	if (ageHours < policy.minAgeHours) {
		await skip(
			`${label} is ${Math.floor(ageHours)} h old; updates wait ${policy.minAgeHours} h after a release.`,
		);
		return DONE;
	}

	if (policy.mode === "notify") {
		if (!sameTarget.some((r) => r.status === "notified")) {
			const now = new Date().toISOString();
			await db.insert(updateRun).values({
				updatePolicyId: policy.updatePolicyId,
				targetType: "dokploy",
				status: "notified",
				fromImage: currentImage,
				toImage: targetImage,
				reason: `${label} is available.`,
				startedAt: now,
				finishedAt: now,
			});
			await sendUpdateNotifications({
				event: "dokployUpdate",
				title: "Dokploy update available",
				outcome: "info",
				facts: [
					{ name: "Version", value: label },
					{ name: "Image", value: targetImage },
				],
			});
		}
		return DONE;
	}

	const attempted = (await runsSince(occurrence.start)).some(
		(r) => r.status !== "skipped" && r.status !== "notified",
	);
	if (attempted) return DONE;

	const reasons = await blockers();
	if (reasons.length > 0) return { wait: true, reasons };

	if (!(await imageHasUpdater(currentImage))) {
		const run = await recordOnce(
			policy,
			occurrence,
			"aborted",
			currentImage,
			targetImage,
			"The running image has no /app/dokploy-updater.sh: update by hand once (docs/UPDATING.md).",
		);
		if (run) await notifyDokployRun(run);
		return DONE;
	}

	await startDokployUpdater({
		currentImage,
		args: ["--target", targetImage],
		kind: "update",
		toImage: targetImage,
		updatePolicyId: policy.updatePolicyId,
		verifyMinutes: policy.verifyMinutes,
	}).catch((error) => {
		console.error("[auto-update] The Dokploy updater did not start:", error);
	});
	return DONE;
};

/** Works through the window open now, retrying while something blocks. */
export const runDokployWindow = () =>
	runOnce("dokploy-window", async () => {
		try {
			for (;;) {
				const policy = await findDokployUpdatePolicy();
				if (!policy?.enabled) return;
				const occurrence = currentOrNextOccurrence(policyWindow(policy));
				if (!occurrence || occurrence.start.getTime() > Date.now()) return;

				const result = await attempt(policy, occurrence);
				if (!result.wait) return;
				if (Date.now() + RETRY_MS >= occurrence.end.getTime()) {
					const check = await checkDokployUpdate(
						getDeps()?.currentVersion ?? "",
						policy.versionRule,
					).catch(() => null);
					await recordOnce(
						policy,
						occurrence,
						"skipped",
						check?.currentImage ?? "",
						check?.available ? check.targetImage : "",
						`The window closed before the update could start: ${result.reasons.join("; ")}.`,
					);
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
			}
		} catch (error) {
			console.error("[auto-update] Dokploy update window failed:", error);
		}
	});

/** (Re)plans the job that opens each window; none when the rule is off. */
export const scheduleDokployAutoUpdate = (policy: UpdatePolicy | null) => {
	if (!getDeps() || !policy?.enabled) {
		replaceJob(JOB_NAME, () => null);
		return;
	}
	const [hour = 0, minute = 0] = policy.windowStart.split(":").map(Number);
	const rule = new RecurrenceRule();
	rule.dayOfWeek = policy.windowDays;
	rule.hour = hour;
	rule.minute = minute;
	rule.second = 0;
	rule.tz = policy.timezone;
	replaceJob(JOB_NAME, () =>
		scheduleJob(JOB_NAME, rule, () => void runDokployWindow()),
	);
};

export const initDokployAutoUpdate = async (
	dependencies: DokployAutoUpdateDeps,
) => {
	autoUpdateState().dokployDeps = dependencies;
	try {
		if ((await reconcileDokployUpdater()) === "running") {
			void watchDokployUpdater();
		}
		scheduleDokployAutoUpdate(await findDokployUpdatePolicy());
		// Startup inside an open window (after an update, or a reboot) picks it up.
		void runDokployWindow();
	} catch (error) {
		console.error("[auto-update] Initialising Dokploy updates failed:", error);
	}
};
