import { db } from "@dokploy/server/db";
import {
	type DeploymentVerification,
	deployments,
	type VerificationStatus,
} from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { and, eq, gt } from "drizzle-orm";
import { collectApplicationContext } from "../diagnostics/collect/application";
import { runDiagnostics } from "../diagnostics/engine";
import { LISTEN_GRACE_SECONDS } from "../diagnostics/rules/runtime";
import { emptyVerification, updateTracking } from "./capture";

const POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** A container must stay up this long before it counts as running. */
const STABLE_RUNNING_MS = 10_000;
const NANOS_PER_MS = 1_000_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();

const timeoutFromHealthcheck = (healthcheck?: {
	Interval?: number;
	Retries?: number;
	StartPeriod?: number;
	Timeout?: number;
}) => {
	if (!healthcheck) return DEFAULT_TIMEOUT_MS;
	const interval =
		(healthcheck.Interval ?? 30_000 * NANOS_PER_MS) / NANOS_PER_MS;
	const startPeriod = (healthcheck.StartPeriod ?? 0) / NANOS_PER_MS;
	const retries = healthcheck.Retries ?? 3;
	return Math.min(
		MAX_TIMEOUT_MS,
		Math.max(
			DEFAULT_TIMEOUT_MS,
			startPeriod + interval * (retries + 1) + 30_000,
		),
	);
};

export const computeVerificationStatus = (
	v: DeploymentVerification,
): VerificationStatus => {
	const { build, containerRunning, healthy, reachable } = v.stages;
	if (build.status === "failed" || containerRunning.status === "failed") {
		return "failed";
	}
	if (containerRunning.status !== "passed") return "unknown";
	if (healthy.status === "failed" || reachable.status === "failed") {
		return "degraded";
	}
	if (healthy.status === "passed" && reachable.status !== "skipped") {
		return "healthy";
	}
	return "running";
};

const isSuperseded = async (applicationId: string, createdAt: string) => {
	const newer = await db
		.select({ id: deployments.deploymentId })
		.from(deployments)
		.where(
			and(
				eq(deployments.applicationId, applicationId),
				gt(deployments.createdAt, createdAt),
			),
		)
		.limit(1);
	return newer.length > 0;
};

/**
 * Observes the service after a deployment and records each stage separately:
 * build ≠ container created ≠ running ≠ healthy ≠ reachable.
 */
export const verifyDeployment = async (
	deploymentId: string,
	applicationId: string,
): Promise<void> => {
	const [row] = await db
		.select()
		.from(deployments)
		.where(eq(deployments.deploymentId, deploymentId));
	if (!row) return;

	const application = await findApplicationById(applicationId);
	const v = row.verification ?? emptyVerification();
	if (v.stages.build.status === "pending") {
		v.stages.build = { status: "skipped", at: nowIso() };
	}
	v.notes = v.notes ?? [];
	await updateTracking(deploymentId, {
		verificationStatus: "verifying",
		verification: v,
	});

	const docker = await getRemoteDocker(application.serverId);
	const since = new Date(row.createdAt).getTime() - 1_000;
	let deadline = Date.now() + DEFAULT_TIMEOUT_MS;
	let runningSince: number | null = null;
	let runningTaskId: string | undefined;
	let containerId: string | undefined;
	let runningImageId: string | undefined;

	while (true) {
		if (await isSuperseded(applicationId, row.createdAt)) {
			v.notes.push("Verification interrupted: a newer deployment started.");
			break;
		}

		const service = await docker.getService(application.appName).inspect();
		const forceUpdate = service.Spec?.TaskTemplate?.ForceUpdate ?? 0;
		const tasks = (
			await docker.listTasks({
				filters: JSON.stringify({ service: [application.appName] }),
			})
		).filter(
			(t) =>
				(t.Spec?.ForceUpdate ?? 0) === forceUpdate &&
				new Date(t.CreatedAt ?? 0).getTime() >= since,
		);

		const created = tasks.find((t) => t.Status?.ContainerStatus?.ContainerID);
		if (created && v.stages.containerCreated.status === "pending") {
			v.stages.containerCreated = {
				status: "passed",
				at: nowIso(),
				detail: created.Status?.ContainerStatus?.ContainerID?.slice(0, 12),
			};
		}

		const running = tasks.find((t) => t.Status?.State === "running");
		const failed = tasks.filter((t) =>
			["failed", "rejected"].includes(t.Status?.State ?? ""),
		);

		if (running && running.ID !== runningTaskId) {
			runningTaskId = running.ID;
			runningSince = Date.now();
			containerId = running.Status?.ContainerStatus?.ContainerID;
		}

		if (failed.length >= 3 || (!running && failed.length >= 2)) {
			const last = failed[0]?.Status?.Err ?? failed[0]?.Status?.State;
			v.stages.containerRunning = {
				status: "failed",
				at: nowIso(),
				detail: `${failed.length} failed tasks (${last})`,
			};
			break;
		}

		if (running && containerId) {
			const info = await docker
				.getContainer(containerId)
				.inspect()
				.catch(() => null);
			if (!info) {
				await sleep(POLL_INTERVAL_MS);
				continue;
			}
			runningImageId = info.Image;
			deadline = Math.max(
				deadline,
				new Date(row.createdAt).getTime() +
					timeoutFromHealthcheck(
						(
							info.Config as {
								Healthcheck?: Parameters<typeof timeoutFromHealthcheck>[0];
							}
						).Healthcheck,
					),
			);
			const health = info.State?.Health?.Status;
			if (!health) {
				v.stages.healthy = {
					status: "not_applicable",
					detail: "no healthcheck defined (image or Swarm)",
				};
			} else if (health === "healthy") {
				v.stages.healthy = { status: "passed", at: nowIso() };
			} else if (health === "unhealthy") {
				const last = info.State?.Health?.Log?.at(-1)
					?.Output?.trim()
					.slice(0, 200);
				v.stages.healthy = { status: "failed", at: nowIso(), detail: last };
			}

			const stable =
				runningSince !== null && Date.now() - runningSince >= STABLE_RUNNING_MS;
			if (stable && v.stages.healthy.status !== "pending") {
				v.stages.containerRunning = {
					status: "passed",
					at: nowIso(),
					detail: `task ${running.ID?.slice(0, 12)}`,
				};
				break;
			}
		}

		if (Date.now() > deadline) {
			const stage = running ? "healthy" : "containerRunning";
			if (running && v.stages.containerRunning.status === "pending") {
				v.stages.containerRunning = { status: "passed", at: nowIso() };
			}
			v.stages[stage] = {
				status: "failed",
				at: nowIso(),
				detail: running
					? "healthcheck still starting at the deadline"
					: "no container running at the deadline",
			};
			break;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	for (const stage of [
		"containerCreated",
		"containerRunning",
		"healthy",
	] as const) {
		if (v.stages[stage].status === "pending")
			v.stages[stage] = { status: "skipped" };
	}

	if (v.stages.containerRunning.status !== "passed") {
		v.stages.reachable = { status: "skipped" };
	} else if (application.domains.length === 0) {
		v.stages.reachable = { status: "not_applicable", detail: "no domain" };
	}

	// Give the listening-socket rules their grace period so the final report
	// can name the cause, not only the symptom.
	if (v.stages.containerRunning.status === "passed" && runningSince !== null) {
		const waitMs =
			runningSince + (LISTEN_GRACE_SECONDS + 1) * 1000 - Date.now();
		if (waitMs > 0) await sleep(waitMs);
	}
	const report = runDiagnostics(
		await collectApplicationContext(application, { remote: false }),
	);
	v.findings = report.findings
		.filter((f) => f.confidence !== "low")
		.map((f) => f.code);
	if (v.stages.reachable.status === "pending") {
		const unreachable = report.findings.find(
			(f) => f.code === "REVERSE_PROXY_UNREACHABLE",
		);
		const probed = report.facts.probes.length > 0;
		v.stages.reachable = unreachable
			? { status: "failed", at: nowIso(), detail: unreachable.title }
			: probed
				? { status: "passed", at: nowIso() }
				: { status: "skipped", detail: "sondes Traefik indisponibles" };
	}

	v.finishedAt = nowIso();
	await updateTracking(deploymentId, {
		verificationStatus: computeVerificationStatus(v),
		verification: v,
		runningImageId: runningImageId ?? null,
		containerId: containerId ?? null,
		taskId: runningTaskId ?? null,
	});
};

/** Fire-and-forget: the deployment queue must not wait for verification. */
export const startDeploymentVerification = (
	deploymentId: string,
	applicationId: string,
) => {
	verifyDeployment(deploymentId, applicationId).catch(async (error) => {
		console.error("[smart-deploy] verification failed:", error);
		await updateTracking(deploymentId, { verificationStatus: "unknown" }).catch(
			() => undefined,
		);
	});
};
