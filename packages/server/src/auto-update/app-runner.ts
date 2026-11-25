import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { RecurrenceRule, scheduledJobs, scheduleJob } from "node-schedule";
import { db } from "../db";
import { applications } from "../db/schema/application";
import {
	type UpdatePolicy,
	type UpdateRun,
	updatePolicy,
	updateRun,
} from "../db/schema/auto-update";
import { deployments } from "../db/schema/deployment";
import { findBackupById } from "../services/backup";
import {
	findDokployUpdatePolicy,
	policyWindow,
} from "../services/update-policy";
import { runComposeBackup } from "../utils/backups/compose";
import { runLibsqlBackup } from "../utils/backups/libsql";
import { runMariadbBackup } from "../utils/backups/mariadb";
import { runMongoBackup } from "../utils/backups/mongo";
import { runMySqlBackup } from "../utils/backups/mysql";
import { runPostgresBackup } from "../utils/backups/postgres";
import { sendUpdateNotifications } from "../utils/notifications/auto-update";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";
import {
	type ApplicationUpdateCheck,
	checkApplicationUpdate,
} from "./app-check";
import { isDokployUpdateBusy } from "./dokploy-updater";
import {
	currentOrNextOccurrence,
	DOKPLOY_UPDATE_MARGIN_MINUTES,
	type WindowOccurrence,
	windowOccurrences,
} from "./window";

const RETRY_MS = 5 * 60_000;
const POLL_MS = 5_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DEPLOY_TIMEOUT_MS = 30 * MINUTE_MS;
const VERDICT_TIMEOUT_MS = 15 * MINUTE_MS;
const IN_PROGRESS: UpdateRun["status"][] = [
	"backing_up",
	"updating",
	"verifying",
	"restoring",
];

export interface AppAutoUpdateDeps {
	/** Adds a deployment job to the app's queue, which lives in the app. */
	enqueueDeploy: (
		application: { applicationId: string; serverId: string | null },
		title: string,
	) => Promise<void>;
	pendingJobs: (applicationId: string) => Promise<number>;
}

let deps: AppAutoUpdateDeps | null = null;

type CheckedUpdate = Extract<ApplicationUpdateCheck, { available: true }>;
type Attempt = { wait: false } | { wait: true; reasons: string[] };
const DONE: Attempt = { wait: false };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const findPolicy = (updatePolicyId: string) =>
	db.query.updatePolicy.findFirst({
		where: eq(updatePolicy.updatePolicyId, updatePolicyId),
	});

const findApplication = (applicationId: string) =>
	db.query.applications.findFirst({
		where: eq(applications.applicationId, applicationId),
	});

type App = NonNullable<Awaited<ReturnType<typeof findApplication>>>;

const appRuns = (applicationId: string, since?: Date) =>
	db.query.updateRun.findMany({
		where: and(
			eq(updateRun.applicationId, applicationId),
			...(since ? [gte(updateRun.startedAt, since.toISOString())] : []),
		),
	});

const notify = (
	policy: UpdatePolicy,
	app: App,
	title: string,
	outcome: "success" | "failure" | "info",
	facts: { name: string; value: string }[],
) =>
	sendUpdateNotifications({
		event: "appUpdate",
		organizationId: policy.organizationId,
		title: `${app.name}: ${title}`,
		outcome,
		facts,
	}).catch((error) =>
		console.error("[auto-update] App notification failed:", error),
	);

const recordOnce = async (
	policy: UpdatePolicy,
	occurrence: WindowOccurrence,
	values: {
		status: "skipped" | "aborted";
		fromImage: string;
		toImage: string;
		reason: string;
	},
) => {
	const existing = await appRuns(
		policy.applicationId as string,
		occurrence.start,
	);
	if (
		existing.some(
			(r) =>
				r.status === values.status &&
				r.reason === values.reason &&
				r.toImage === values.toImage,
		)
	) {
		return null;
	}
	const now = new Date().toISOString();
	const [run] = await db
		.insert(updateRun)
		.values({
			updatePolicyId: policy.updatePolicyId,
			targetType: "application",
			applicationId: policy.applicationId,
			...values,
			startedAt: now,
			finishedAt: now,
		})
		.returning();
	return run ?? null;
};

/** Inside the Dokploy window or its margin: a restore there would lose this update. */
const nearDokployWindow = async () => {
	const dokploy = await findDokployUpdatePolicy();
	if (!dokploy?.enabled) return false;
	const margin = DOKPLOY_UPDATE_MARGIN_MINUTES * MINUTE_MS;
	const now = Date.now();
	return windowOccurrences(
		policyWindow(dokploy),
		new Date(now - margin - 24 * HOUR_MS),
		new Date(now + margin),
	).some(
		(o) => o.start.getTime() - margin <= now && now < o.end.getTime() + margin,
	);
};

const blockers = async (app: App) => {
	const reasons: string[] = [];
	if (!deps) return ["The scheduler is not initialised."];
	if (await isDokployUpdateBusy()) {
		reasons.push("a Dokploy update is running or waits to be resumed");
	}
	if (await nearDokployWindow()) {
		reasons.push("the Dokploy update window is open or about to open");
	}
	const dokployRuns = await db.query.updateRun.findMany({
		where: and(
			eq(updateRun.targetType, "dokploy"),
			inArray(updateRun.status, IN_PROGRESS),
		),
		columns: { updateRunId: true },
	});
	if (dokployRuns.length > 0) reasons.push("a Dokploy update is running");
	if ((await deps.pendingJobs(app.applicationId)) > 0) {
		reasons.push("a deployment of this application is queued or running");
	}
	return reasons;
};

/** Runs one backup now and tells whether it succeeded. */
const runBackupNow = async (backupId: string) => {
	const backup = await findBackupById(backupId);
	const since = new Date().toISOString();
	const { databaseType, postgres, mysql, mongo, mariadb, libsql, compose } =
		backup;
	if (backup.backupType === "compose" && compose) {
		await runComposeBackup(compose, backup);
	} else if (databaseType === "postgres" && postgres) {
		await runPostgresBackup(postgres, backup);
	} else if (databaseType === "mysql" && mysql) {
		await runMySqlBackup(mysql, backup);
	} else if (databaseType === "mongo" && mongo) {
		await runMongoBackup(mongo, backup);
	} else if (databaseType === "mariadb" && mariadb) {
		await runMariadbBackup(mariadb, backup);
	} else if (databaseType === "libsql" && libsql) {
		await runLibsqlBackup(libsql, backup);
	} else {
		return false;
	}
	// The backup functions report through a deployment row instead of throwing.
	const [row] = await db
		.select({ status: deployments.status })
		.from(deployments)
		.where(
			and(
				eq(deployments.backupId, backupId),
				gte(deployments.createdAt, since),
			),
		)
		.orderBy(desc(deployments.createdAt))
		.limit(1);
	return row?.status === "done";
};

/** The deployment started after `since`, once finished and verified. */
const waitForDeployment = async (applicationId: string, since: string) => {
	const deadline = Date.now() + DEPLOY_TIMEOUT_MS;
	let finishedAt = 0;
	while (Date.now() < deadline) {
		const [row] = await db
			.select()
			.from(deployments)
			.where(
				and(
					eq(deployments.applicationId, applicationId),
					gte(deployments.createdAt, since),
				),
			)
			.orderBy(desc(deployments.createdAt))
			.limit(1);
		if (row?.status === "error") return row;
		if (row?.status === "done") {
			if (row.verificationStatus) return row;
			finishedAt ||= Date.now();
			if (Date.now() - finishedAt > VERDICT_TIMEOUT_MS) return row;
		}
		await sleep(POLL_MS);
	}
	return null;
};

const runningContainers = async (app: App) => {
	const command = `docker ps -q --no-trunc --filter label=com.docker.swarm.service.name=${app.appName} --filter status=running`;
	const { stdout } = app.serverId
		? await execAsyncRemote(app.serverId, command)
		: await execAsync(command);
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
};

/**
 * Deploys `image` and tells why it is not good, or null when it is: Smart
 * Deploy's verdict (running, healthy, reachable), then the same container
 * still running after `verifyMinutes`.
 */
const deployAndVerify = async (
	app: App,
	image: string,
	verifyMinutes: number,
	title: string,
) => {
	if (!deps) return "The scheduler is not initialised.";
	await db
		.update(applications)
		.set({ dockerImage: image })
		.where(eq(applications.applicationId, app.applicationId));
	const since = new Date().toISOString();
	await deps.enqueueDeploy(app, title);
	const deployment = await waitForDeployment(app.applicationId, since);
	if (!deployment) return "The deployment did not finish in 30 minutes.";
	if (deployment.status === "error") return "The deployment failed.";
	const verdict = deployment.verificationStatus;
	if (verdict !== "healthy" && verdict !== "running") {
		return `Smart Deploy found the new version ${verdict ?? "unverified"}.`;
	}
	await sleep(verifyMinutes * MINUTE_MS);
	const containers = await runningContainers(app).catch(() => null);
	if (containers === null) return "The containers could not be listed.";
	if (containers.length === 0) return "The application stopped running.";
	if (
		deployment.containerId &&
		!containers.some((id) => id.startsWith(deployment.containerId as string))
	) {
		return "The container restarted after the deployment.";
	}
	return null;
};

const setRun = async (updateRunId: string, values: Partial<UpdateRun>) => {
	await db
		.update(updateRun)
		.set(values)
		.where(eq(updateRun.updateRunId, updateRunId));
};

const applyUpdate = async (
	policy: UpdatePolicy,
	app: App,
	check: CheckedUpdate,
) => {
	const facts = [
		{ name: "From", value: check.currentPinned },
		{ name: "To", value: check.targetPinned },
	];
	const [run] = await db
		.insert(updateRun)
		.values({
			updatePolicyId: policy.updatePolicyId,
			targetType: "application",
			applicationId: app.applicationId,
			status: policy.backupIds.length > 0 ? "backing_up" : "updating",
			fromImage: check.currentPinned,
			toImage: check.targetPinned,
		})
		.returning();
	if (!run) return;
	const finish = async (
		status: UpdateRun["status"],
		reason: string,
		title: string,
		outcome: "success" | "failure",
	) => {
		await setRun(run.updateRunId, {
			status,
			reason,
			finishedAt: new Date().toISOString(),
		});
		await notify(policy, app, title, outcome, [
			...facts,
			{ name: "Details", value: reason },
		]);
	};

	for (const backupId of policy.backupIds) {
		const ok = await runBackupNow(backupId).catch(() => false);
		if (!ok) {
			await finish(
				"aborted",
				`Backup ${backupId} failed: nothing was changed.`,
				"update not started",
				"failure",
			);
			return;
		}
	}

	await setRun(run.updateRunId, { status: "updating" });
	const problem = await deployAndVerify(
		app,
		check.targetImage,
		policy.verifyMinutes,
		`Scheduled update to ${check.label}`,
	).catch((error) => `The update stopped: ${error}`);
	if (!problem) {
		await finish(
			"succeeded",
			`Updated to ${check.label}.`,
			`updated to ${check.label}`,
			"success",
		);
		return;
	}

	await setRun(run.updateRunId, { status: "restoring", reason: problem });
	const putBack = await deployAndVerify(
		app,
		check.currentPinned,
		policy.verifyMinutes,
		"Scheduled update put back",
	).catch((error) => `Putting back stopped: ${error}`);
	if (!putBack) {
		await finish(
			"rolled_back",
			`${problem} The previous image runs again.`,
			"update failed, previous version restored",
			"failure",
		);
	} else {
		await finish(
			"failed",
			`${problem} Putting back failed too: ${putBack}`,
			"update failed and could not be put back",
			"failure",
		);
	}
};

const attempt = async (
	policy: UpdatePolicy,
	occurrence: WindowOccurrence,
): Promise<Attempt> => {
	if (!deps || !policy.applicationId) return DONE;
	const app = await findApplication(policy.applicationId);
	if (!app) return DONE;
	if (app.sourceType !== "docker") {
		await recordOnce(policy, occurrence, {
			status: "skipped",
			fromImage: "",
			toImage: "",
			reason:
				"Scheduled updates only cover applications deployed from a Docker image.",
		});
		return DONE;
	}

	let check: ApplicationUpdateCheck;
	try {
		check = await checkApplicationUpdate(app, policy.versionRule);
	} catch (error) {
		return { wait: true, reasons: [`the update check failed: ${error}`] };
	}
	if (!check.available) {
		if (check.reason) {
			await recordOnce(policy, occurrence, {
				status: "skipped",
				fromImage: app.dockerImage ?? "",
				toImage: "",
				reason: check.reason,
			});
		}
		return DONE;
	}
	const skip = (reason: string) =>
		recordOnce(policy, occurrence, {
			status: "skipped",
			fromImage: check.currentPinned,
			toImage: check.targetPinned,
			reason,
		});

	const history = await appRuns(app.applicationId);
	const sameTarget = history.filter((r) => r.toImage === check.targetPinned);
	if (
		sameTarget.some((r) => r.status === "rolled_back" || r.status === "failed")
	) {
		await skip(`${check.label} failed before; waiting for a newer image.`);
		return DONE;
	}
	const firstSeen = sameTarget
		.map((r) => new Date(r.startedAt))
		.sort((a, b) => a.getTime() - b.getTime())[0];
	const publishedAt = check.createdAt ?? firstSeen ?? new Date();
	const ageHours = (Date.now() - publishedAt.getTime()) / HOUR_MS;
	if (ageHours < policy.minAgeHours) {
		await skip(
			`${check.label} is ${Math.floor(ageHours)} h old; updates wait ${policy.minAgeHours} h after a release.`,
		);
		return DONE;
	}

	if (policy.mode === "notify") {
		if (!sameTarget.some((r) => r.status === "notified")) {
			const now = new Date().toISOString();
			await db.insert(updateRun).values({
				updatePolicyId: policy.updatePolicyId,
				targetType: "application",
				applicationId: app.applicationId,
				status: "notified",
				fromImage: check.currentPinned,
				toImage: check.targetPinned,
				reason: `${check.label} is available.`,
				startedAt: now,
				finishedAt: now,
			});
			await notify(policy, app, "update available", "info", [
				{ name: "Version", value: check.label },
				{ name: "Image", value: check.targetPinned },
			]);
		}
		return DONE;
	}

	const attempted = history.some(
		(r) =>
			r.startedAt >= occurrence.start.toISOString() &&
			r.status !== "skipped" &&
			r.status !== "notified",
	);
	if (attempted) return DONE;

	const reasons = await blockers(app);
	if (reasons.length > 0) return { wait: true, reasons };

	await applyUpdate(policy, app, check);
	return DONE;
};

const windowsRunning = new Set<string>();

export const runAppWindow = async (updatePolicyId: string) => {
	if (windowsRunning.has(updatePolicyId)) return;
	windowsRunning.add(updatePolicyId);
	try {
		for (;;) {
			const policy = await findPolicy(updatePolicyId);
			if (!policy?.enabled || !policy.applicationId) return;
			const occurrence = currentOrNextOccurrence(policyWindow(policy));
			if (!occurrence || occurrence.start.getTime() > Date.now()) return;

			const result = await attempt(policy, occurrence);
			if (!result.wait) return;
			if (Date.now() + RETRY_MS >= occurrence.end.getTime()) {
				await recordOnce(policy, occurrence, {
					status: "skipped",
					fromImage: "",
					toImage: "",
					reason: `The window closed before the update could start: ${result.reasons.join("; ")}.`,
				});
				return;
			}
			await sleep(RETRY_MS);
		}
	} catch (error) {
		console.error("[auto-update] App update window failed:", error);
	} finally {
		windowsRunning.delete(updatePolicyId);
	}
};

const jobName = (updatePolicyId: string) => `app-auto-update-${updatePolicyId}`;

export const scheduleAppAutoUpdate = (policy: UpdatePolicy) => {
	scheduledJobs[jobName(policy.updatePolicyId)]?.cancel();
	if (!deps || !policy.enabled || !policy.applicationId) return;
	const [hour = 0, minute = 0] = policy.windowStart.split(":").map(Number);
	const rule = new RecurrenceRule();
	rule.dayOfWeek = policy.windowDays;
	rule.hour = hour;
	rule.minute = minute;
	rule.second = 0;
	rule.tz = policy.timezone;
	scheduleJob(jobName(policy.updatePolicyId), rule, () => {
		void runAppWindow(policy.updatePolicyId);
	});
};

/** Runs left half-done by a panel restart: say so, they do not resume. */
const markInterruptedRuns = async () => {
	const stale = await db.query.updateRun.findMany({
		where: and(
			eq(updateRun.targetType, "application"),
			inArray(updateRun.status, IN_PROGRESS),
		),
		with: { policy: true, application: true },
	});
	for (const run of stale) {
		const reason =
			"The panel restarted during this update. Check the application's image and deployments, and redeploy if needed.";
		await setRun(run.updateRunId, {
			status: "interrupted",
			reason,
			finishedAt: new Date().toISOString(),
		});
		if (run.policy && run.application) {
			await notify(
				run.policy,
				run.application,
				"update interrupted",
				"failure",
				[
					{ name: "From", value: run.fromImage ?? "" },
					{ name: "To", value: run.toImage ?? "" },
					{ name: "Details", value: reason },
				],
			);
		}
	}
};

export const initAppAutoUpdates = async (dependencies: AppAutoUpdateDeps) => {
	deps = dependencies;
	try {
		await markInterruptedRuns();
		const policies = await db.query.updatePolicy.findMany({
			where: and(
				eq(updatePolicy.targetType, "application"),
				eq(updatePolicy.enabled, true),
			),
		});
		for (const policy of policies) {
			scheduleAppAutoUpdate(policy);
			void runAppWindow(policy.updatePolicyId);
		}
	} catch (error) {
		console.error("[auto-update] Initialising app updates failed:", error);
	}
};
