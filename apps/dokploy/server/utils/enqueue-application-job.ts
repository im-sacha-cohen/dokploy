import {
	type findApplicationById,
	type findComposeById,
	IS_CLOUD,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";

export type ApplicationJob =
	| { type: "deploy"; titleLog: string; commitSha?: string }
	| { type: "redeploy"; titleLog: string }
	| { type: "redeploy-version"; sourceDeploymentId: string };

/** Queues an application job exactly like the UI does (shared by tRPC and MCP). */
export const enqueueApplicationJob = async (
	application: Awaited<ReturnType<typeof findApplicationById>>,
	job: ApplicationJob,
) => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "NOT_IMPLEMENTED",
			message: "This action is not available on Dokploy Cloud",
		});
	}
	const jobData: DeploymentJob = {
		applicationId: application.applicationId,
		titleLog:
			job.type === "redeploy-version" ? "Redeploy version" : job.titleLog,
		descriptionLog: "",
		type: job.type,
		applicationType: "application",
		server: !!application.serverId,
		serverId: application.serverId ?? undefined,
		...(job.type === "redeploy-version"
			? { sourceDeploymentId: job.sourceDeploymentId }
			: {}),
		...(job.type === "deploy" && job.commitSha
			? { commitSha: job.commitSha }
			: {}),
	};
	await myQueue.add(
		"deployments",
		{ ...jobData },
		{ removeOnComplete: true, removeOnFail: true },
	);
};

export type ComposeJob =
	| { type: "deploy"; titleLog: string; commitSha: string }
	| { type: "redeploy-version"; sourceDeploymentId: string };

/** Queues a compose commit deploy or rollback (shared by tRPC and MCP). */
export const enqueueComposeJob = async (
	compose: Awaited<ReturnType<typeof findComposeById>>,
	job: ComposeJob,
) => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "NOT_IMPLEMENTED",
			message: "This action is not available on Dokploy Cloud",
		});
	}
	const jobData: DeploymentJob = {
		composeId: compose.composeId,
		titleLog: job.type === "deploy" ? job.titleLog : "Redeploy version",
		descriptionLog: "",
		type: job.type,
		applicationType: "compose",
		server: !!compose.serverId,
		serverId: compose.serverId ?? undefined,
		...(job.type === "deploy"
			? { commitSha: job.commitSha }
			: { sourceDeploymentId: job.sourceDeploymentId }),
	};
	await myQueue.add(
		"deployments",
		{ ...jobData },
		{ removeOnComplete: true, removeOnFail: true },
	);
};
