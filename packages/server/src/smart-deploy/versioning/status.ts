import { findApplicationById } from "@dokploy/server/services/application";
import type { Deployment } from "@dokploy/server/services/deployment";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { getRemoteHead, type RemoteHead } from "./remote-head";
import { describeSource } from "./source";

/** A "verifying" row older than this was interrupted (e.g. server restart). */
const STALE_VERIFICATION_MS = 15 * 60 * 1000;

export type VersionState =
	| "up_to_date"
	| "outdated"
	| "unknown"
	| "not_applicable";

export type RecommendedAction = "none" | "deploy_latest" | "diagnose";

export interface LiveRuntime {
	collected: boolean;
	reason?: string;
	runningTasks: number;
	desiredReplicas: number;
	containerId?: string;
	runningImageId?: string;
}

export interface DeploymentVersion {
	deploymentId: string;
	createdAt: string;
	title: string;
	kind: string | null;
	status: string | null;
	verificationStatus: string | null;
	sourceBranch: string | null;
	requestedCommitSha: string | null;
	fetchedCommitSha: string | null;
	builtCommitSha: string | null;
	imageId: string | null;
	imageTag: string | null;
	imageDigest: string | null;
	sourceDeploymentId: string | null;
	/** Whether this deployment can be redeployed without rebuilding. */
	redeployable: boolean;
}

export interface VersionStatus {
	applicationId: string;
	source: ReturnType<typeof describeSource>;
	live: LiveRuntime;
	current: DeploymentVersion | null;
	/** How `current` was identified. "image_match" is the only exact method. */
	currentMatch: "image_match" | "latest_successful" | "none";
	runningCommitSha: string | null;
	latestRemote: RemoteHead | { status: "skipped" };
	versionState: VersionState;
	versionReason: string;
	recommendedAction: RecommendedAction;
	history: DeploymentVersion[];
}

const toVersion = (d: Deployment): DeploymentVersion => {
	const stale =
		d.verificationStatus === "verifying" &&
		Date.now() - new Date(d.createdAt).getTime() > STALE_VERIFICATION_MS;
	return {
		deploymentId: d.deploymentId,
		createdAt: d.createdAt,
		title: d.title,
		kind: d.kind,
		status: d.status,
		verificationStatus: stale ? "unknown" : d.verificationStatus,
		sourceBranch: d.sourceBranch,
		requestedCommitSha: d.requestedCommitSha,
		fetchedCommitSha: d.fetchedCommitSha,
		builtCommitSha: d.builtCommitSha,
		imageId: d.imageId,
		imageTag: d.imageTag,
		imageDigest: d.imageDigest,
		sourceDeploymentId: d.sourceDeploymentId,
		redeployable: !!d.imageTag && d.status === "done",
	};
};

const collectLive = async (
	appName: string,
	serverId: string | null,
): Promise<LiveRuntime> => {
	try {
		const docker = await getRemoteDocker(serverId);
		const service = await docker.getService(appName).inspect();
		const tasks = await docker.listTasks({
			filters: JSON.stringify({
				service: [appName],
				"desired-state": ["running"],
			}),
		});
		const running = tasks.filter((t) => t.Status?.State === "running");
		const containerId = running[0]?.Status?.ContainerStatus?.ContainerID;
		let runningImageId: string | undefined;
		if (containerId) {
			runningImageId = (await docker.getContainer(containerId).inspect()).Image;
		}
		return {
			collected: true,
			runningTasks: running.length,
			desiredReplicas: service.Spec?.Mode?.Replicated?.Replicas ?? 1,
			containerId,
			runningImageId,
		};
	} catch (error) {
		return {
			collected: false,
			reason:
				error instanceof Error ? error.message.slice(0, 200) : String(error),
			runningTasks: 0,
			desiredReplicas: 0,
		};
	}
};

export const getVersionStatus = async (
	applicationId: string,
	options: { checkRemote?: boolean } = {},
): Promise<VersionStatus> => {
	const application = await findApplicationById(applicationId);
	const source = describeSource(application);
	const history = [...application.deployments]
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.map(toVersion);

	const live = await collectLive(application.appName, application.serverId);

	let current: DeploymentVersion | null = null;
	let currentMatch: VersionStatus["currentMatch"] = "none";
	if (live.runningImageId) {
		current =
			history.find(
				(d) => d.imageId === live.runningImageId && d.status === "done",
			) ?? null;
		if (current) currentMatch = "image_match";
	}
	if (!current) {
		current = history.find((d) => d.status === "done") ?? null;
		if (current) currentMatch = "latest_successful";
	}

	// Only an exact image match proves which commit is running.
	const runningCommitSha =
		currentMatch === "image_match" ? (current?.builtCommitSha ?? null) : null;

	const latestRemote =
		options.checkRemote === false
			? ({ status: "skipped" } as const)
			: await getRemoteHead(application);

	let versionState: VersionState;
	let versionReason: string;
	if (!source.isGit) {
		versionState = "not_applicable";
		versionReason = "The source is not a Git repository.";
	} else if (latestRemote.status !== "ok") {
		versionState = "unknown";
		versionReason =
			latestRemote.status === "error"
				? `Latest remote commit not checked: ${latestRemote.reason}`
				: "Latest remote commit not checked.";
	} else if (!runningCommitSha) {
		versionState = "unknown";
		versionReason = live.runningImageId
			? "The running image matches no tracked deployment: running commit unknown."
			: "No container running.";
	} else if (runningCommitSha === latestRemote.sha) {
		versionState = "up_to_date";
		versionReason = "The running commit is the latest commit on the branch.";
	} else {
		versionState = "outdated";
		versionReason = `Branch ${latestRemote.branch} has moved on: ${latestRemote.sha.slice(0, 7)} in the repository, ${runningCommitSha.slice(0, 7)} running.`;
	}

	let recommendedAction: RecommendedAction = "none";
	if (live.collected && live.runningTasks === 0) recommendedAction = "diagnose";
	else if (versionState === "outdated") recommendedAction = "deploy_latest";

	return {
		applicationId,
		source,
		live,
		current,
		currentMatch,
		runningCommitSha,
		latestRemote,
		versionState,
		versionReason,
		recommendedAction,
		history: history.slice(0, 20),
	};
};
