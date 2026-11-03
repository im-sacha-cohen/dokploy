import path from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type DeploymentKind,
	type DeploymentVerification,
	deployments,
} from "@dokploy/server/db/schema";
import {
	type Application,
	findApplicationById,
} from "@dokploy/server/services/application";
import type { Deployment } from "@dokploy/server/services/deployment";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { quote } from "shell-quote";
import { getRemoteHead } from "./remote-head";
import { runOn, SHA_PATTERN } from "./shell";
import { describeSource } from "./source";

export const KEPT_DEPLOYMENT_IMAGES = 5;

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

// A separate repository keeps `docker images <appName>` unchanged for upstream
// code and tests; the "dpl-" prefix guarantees a valid tag start character.
export const deploymentImageTag = (appName: string, deploymentId: string) =>
	`dokploy-versions/${appName}:dpl-${deploymentId}`;

export const emptyVerification = (): DeploymentVerification => ({
	startedAt: new Date().toISOString(),
	stages: {
		build: { status: "pending" },
		containerCreated: { status: "pending" },
		containerRunning: { status: "pending" },
		healthy: { status: "pending" },
		reachable: { status: "pending" },
	},
});

export const updateTracking = (
	deploymentId: string,
	data: Partial<Deployment>,
) =>
	db
		.update(deployments)
		.set(data)
		.where(eq(deployments.deploymentId, deploymentId));

/**
 * Tracking must never break a deployment: every public function here logs and
 * swallows its own errors.
 */
const safely = async (label: string, fn: () => Promise<void>) => {
	try {
		await fn();
	} catch (error) {
		console.error(`[smart-deploy] ${label} failed:`, error);
	}
};

export const trackDeploymentStart = (
	deploymentId: string,
	application: Application,
	kind: DeploymentKind,
	requestedCommitSha?: string | null,
) =>
	safely("trackDeploymentStart", async () => {
		const source = describeSource(application);
		await updateTracking(deploymentId, {
			kind,
			sourceRepository: source.repository,
			sourceBranch: source.branch,
			requestedCommitSha: requestedCommitSha ?? null,
			verificationStatus: "pending",
			verification: emptyVerification(),
		});
	});

/**
 * Head of the branch at request time, resolved by the caller (the deployment
 * queue) so that `deployApplication` itself runs no extra command.
 */
export const resolveRequestedCommit = async (
	applicationId: string,
): Promise<string | null> => {
	try {
		const application = await findApplicationById(applicationId);
		const head = await getRemoteHead(application);
		return head.status === "ok" ? head.sha : null;
	} catch (error) {
		console.error("[smart-deploy] resolveRequestedCommit failed:", error);
		return null;
	}
};

const readSourceCommit = async (
	application: Application,
	serverId: string | null,
) => {
	const codeDir = path.join(
		paths(!!serverId).APPLICATIONS_PATH,
		application.appName,
		"code",
	);
	const result = await runOn(
		serverId,
		`git -C ${quote([codeDir])} rev-parse HEAD && (git -C ${quote([codeDir])} diff --quiet HEAD && echo clean || echo dirty)`,
	);
	const [sha, state] = result.stdout.trim().split("\n");
	return SHA_PATTERN.test(sha ?? "")
		? { sha: sha as string, dirty: state === "dirty" }
		: null;
};

const inspectImage = async (image: string, serverId: string | null) => {
	// `join` fails on RepoDigests ([]interface{}), hence json.
	const result = await runOn(
		serverId,
		`docker image inspect ${quote([image])} --format '{{.Id}}|{{json .RepoDigests}}'`,
	);
	const [id, digestsJson] = result.stdout.trim().split("|");
	if (!result.ok || !IMAGE_ID.test(id ?? "")) return null;
	let digest: string | null = null;
	try {
		const digests = JSON.parse(digestsJson ?? "[]") as string[] | null;
		digest = digests?.find(Boolean) ?? null;
	} catch {
		digest = null;
	}
	return { id: id as string, digest };
};

/** Untags per-deployment images beyond the retention limit (never forced). */
const pruneDeploymentImages = async (
	application: Application,
	serverId: string | null,
) => {
	const tagged = await db
		.select({
			deploymentId: deployments.deploymentId,
			imageTag: deployments.imageTag,
		})
		.from(deployments)
		.where(
			and(
				eq(deployments.applicationId, application.applicationId),
				isNotNull(deployments.imageTag),
			),
		)
		.orderBy(desc(deployments.createdAt));

	const ownTags = tagged.filter(
		(row) =>
			row.imageTag ===
			deploymentImageTag(application.appName, row.deploymentId),
	);
	for (const row of ownTags.slice(KEPT_DEPLOYMENT_IMAGES)) {
		const result = await runOn(
			serverId,
			`docker image rm ${quote([row.imageTag as string])}`,
		);
		const gone = result.ok || /No such image/i.test(result.stderr);
		if (gone) await updateTracking(row.deploymentId, { imageTag: null });
	}
};

/**
 * Called once the build command succeeded: records which commit and which
 * image were actually produced, and tags the image per deployment.
 */
export const trackBuildArtifacts = (
	deploymentId: string,
	application: Application,
	buildServerId: string | null,
	options: { fetched: boolean },
) =>
	safely("trackBuildArtifacts", async () => {
		const data: Partial<Deployment> = {};
		let sourceDirty: boolean | undefined;

		if (
			application.sourceType !== "docker" &&
			application.sourceType !== "drop"
		) {
			const commit = await readSourceCommit(application, buildServerId);
			if (commit) {
				data.builtCommitSha = commit.sha;
				if (options.fetched) data.fetchedCommitSha = commit.sha;
				sourceDirty = commit.dirty;
			}
		}

		const builtImage =
			application.sourceType === "docker"
				? (application.dockerImage ?? "")
				: `${application.appName}:latest`;
		const image = builtImage
			? await inspectImage(builtImage, buildServerId)
			: null;
		if (image) {
			data.imageId = image.id;
			data.imageDigest = image.digest;
		}

		const canTag =
			image &&
			application.sourceType !== "docker" &&
			!application.registryId &&
			!application.buildRegistryId;
		if (canTag) {
			const tag = deploymentImageTag(application.appName, deploymentId);
			const tagged = await runOn(
				buildServerId,
				`docker tag ${quote([builtImage, tag])}`,
			);
			if (tagged.ok) data.imageTag = tag;
		}

		const [row] = await db
			.select({ verification: deployments.verification })
			.from(deployments)
			.where(eq(deployments.deploymentId, deploymentId));
		const verification = row?.verification ?? emptyVerification();
		verification.stages.build = {
			status: "passed",
			at: new Date().toISOString(),
		};
		if (sourceDirty !== undefined) verification.sourceDirty = sourceDirty;
		data.verification = verification;

		await updateTracking(deploymentId, data);
		if (canTag) await pruneDeploymentImages(application, buildServerId);
	});

/** The build, or the service update right after it, failed. */
export const trackBuildFailure = (deploymentId: string) =>
	safely("trackBuildFailure", async () => {
		const [row] = await db
			.select({ verification: deployments.verification })
			.from(deployments)
			.where(eq(deployments.deploymentId, deploymentId));
		const verification = row?.verification ?? emptyVerification();
		const at = new Date().toISOString();
		verification.finishedAt = at;
		if (verification.stages.build.status === "passed") {
			verification.stages.containerCreated = {
				status: "failed",
				at,
				detail: "the Swarm service update failed",
			};
		} else {
			verification.stages.build = { status: "failed", at };
		}
		for (const stage of [
			"containerCreated",
			"containerRunning",
			"healthy",
			"reachable",
		] as const) {
			if (verification.stages[stage].status === "pending") {
				verification.stages[stage] = { status: "skipped" };
			}
		}
		await updateTracking(deploymentId, {
			verificationStatus: "failed",
			verification,
		});
	});
