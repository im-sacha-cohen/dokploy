import { type findApplicationById, IS_CLOUD } from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";

export type ApplicationJob =
	| { type: "deploy"; titleLog: string }
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
	};
	await myQueue.add(
		"deployments",
		{ ...jobData },
		{ removeOnComplete: true, removeOnFail: true },
	);
};
