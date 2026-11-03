import type { DeploymentKind } from "@dokploy/server/db/schema";
import {
	findApplicationById,
	updateApplicationStatus,
} from "@dokploy/server/services/application";
import {
	createDeployment,
	findDeploymentById,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import {
	getAuthConfig,
	mechanizeDockerContainer,
} from "@dokploy/server/utils/builders";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { TRPCError } from "@trpc/server";
import { quote } from "shell-quote";
import { emptyVerification, updateTracking } from "./capture";
import { runOn } from "./shell";
import { getVersionStatus } from "./status";
import { startDeploymentVerification } from "./verify";

const appendLog = (serverId: string | null, logPath: string, line: string) =>
	runOn(serverId, `echo ${quote([line])} >> ${quote([logPath])}`);

const noBuildVerification = () => {
	const v = emptyVerification();
	v.stages.build = { status: "not_applicable", detail: "no build" };
	return v;
};

const failTracked = async (
	deploymentId: string,
	applicationId: string,
	note: string,
) => {
	const v = noBuildVerification();
	v.finishedAt = new Date().toISOString();
	v.notes = [note.slice(0, 300)];
	for (const stage of [
		"containerCreated",
		"containerRunning",
		"healthy",
		"reachable",
	] as const) {
		v.stages[stage] = { status: "skipped" };
	}
	await updateTracking(deploymentId, {
		verificationStatus: "failed",
		verification: v,
	});
	await updateDeploymentStatus(deploymentId, "error");
	await updateApplicationStatus(applicationId, "error");
};

export const assertRedeployable = async (sourceDeploymentId: string) => {
	const source = await findDeploymentById(sourceDeploymentId);
	if (!source.applicationId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only application deployments can be redeployed",
		});
	}
	if (source.status !== "done" || !source.imageTag || !source.imageId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"This deployment has no retained image (only the last 5 successful builds are kept)",
		});
	}
	const application = await findApplicationById(source.applicationId);
	if (
		application.registryId ||
		application.buildRegistryId ||
		application.sourceType === "docker" ||
		(application.buildServerId &&
			application.buildServerId !== application.serverId)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message:
				"Redeploying a retained image is only available for images built and run on the same server without a registry; use the registry rollback instead",
		});
	}
	return { source, application };
};

/**
 * Redeploy (or roll back to) the exact image built by an earlier deployment,
 * without fetching or rebuilding. Uses the application's current settings.
 */
export const redeployDeploymentVersion = async ({
	sourceDeploymentId,
}: {
	sourceDeploymentId: string;
}) => {
	const { source, application } = await assertRedeployable(sourceDeploymentId);
	const serverId = application.serverId;

	const status = await getVersionStatus(application.applicationId, {
		checkRemote: false,
	});
	const kind: DeploymentKind =
		status.current && source.createdAt < status.current.createdAt
			? "rollback"
			: "redeploy";
	const version = source.builtCommitSha?.slice(0, 7) ?? source.deploymentId;

	const deployment = await createDeployment({
		applicationId: application.applicationId,
		title: `${kind === "rollback" ? "Rollback" : "Redeploy"} to ${version}`,
		description: `Image ${source.imageTag} (no fetch, no rebuild)`,
	});
	await updateTracking(deployment.deploymentId, {
		kind,
		sourceDeploymentId: source.deploymentId,
		sourceRepository: source.sourceRepository,
		sourceBranch: source.sourceBranch,
		requestedCommitSha: source.builtCommitSha,
		builtCommitSha: source.builtCommitSha,
		imageId: source.imageId,
		imageDigest: source.imageDigest,
		verificationStatus: "pending",
		verification: noBuildVerification(),
	});

	try {
		const tag = source.imageTag as string;
		const inspect = await runOn(
			serverId,
			`docker image inspect ${quote([tag])} --format '{{.Id}}'`,
		);
		if (!inspect.ok || inspect.stdout.trim() !== source.imageId) {
			throw new Error(
				`Image ${tag} is missing or no longer matches the recorded image ${source.imageId}`,
			);
		}
		await appendLog(
			serverId,
			deployment.logPath,
			`Retagging ${tag} as ${application.appName}:latest`,
		);
		const retag = await runOn(
			serverId,
			`docker tag ${quote([tag, `${application.appName}:latest`])}`,
		);
		if (!retag.ok)
			throw new Error(`docker tag failed: ${retag.stderr.slice(0, 200)}`);

		await appendLog(serverId, deployment.logPath, "Updating the Swarm service");
		await mechanizeDockerContainer(application);
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateApplicationStatus(application.applicationId, "done");
		await appendLog(
			serverId,
			deployment.logPath,
			"Service updated; verification started",
		);
		startDeploymentVerification(
			deployment.deploymentId,
			application.applicationId,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await appendLog(serverId, deployment.logPath, `❌ ${message}`);
		await failTracked(
			deployment.deploymentId,
			application.applicationId,
			message,
		);
		throw error;
	}
	return deployment;
};

/**
 * Restarts the running service without rebuilding and without re-applying
 * configuration: the current Swarm spec is kept, only ForceUpdate changes.
 */
export const restartApplicationService = async (applicationId: string) => {
	const application = await findApplicationById(applicationId);
	const status = await getVersionStatus(applicationId, { checkRemote: false });
	const current = status.currentMatch === "image_match" ? status.current : null;

	const deployment = await createDeployment({
		applicationId,
		title: "Restart",
		description: "Restart without rebuild or configuration change",
	});
	await updateTracking(deployment.deploymentId, {
		kind: "restart",
		sourceDeploymentId: current?.deploymentId ?? null,
		sourceRepository: status.source.repository,
		sourceBranch: status.source.branch,
		builtCommitSha: current?.builtCommitSha ?? null,
		imageId: status.live.runningImageId ?? null,
		verificationStatus: "pending",
		verification: noBuildVerification(),
	});

	try {
		const docker = await getRemoteDocker(application.serverId);
		const service = docker.getService(application.appName);
		const inspect = await service.inspect();
		const authconfig = await getAuthConfig(application);
		await service.update({
			...(authconfig ? { authconfig } : {}),
			version: Number.parseInt(inspect.Version.Index),
			...inspect.Spec,
			TaskTemplate: {
				...inspect.Spec.TaskTemplate,
				ForceUpdate: (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1,
			},
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
		await appendLog(
			application.serverId,
			deployment.logPath,
			"Service restarted; verification started",
		);
		startDeploymentVerification(deployment.deploymentId, applicationId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await appendLog(application.serverId, deployment.logPath, `❌ ${message}`);
		await failTracked(deployment.deploymentId, applicationId, message);
		throw error;
	}
	return deployment;
};
