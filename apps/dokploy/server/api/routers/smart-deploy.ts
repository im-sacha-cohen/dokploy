import {
	assertRedeployable,
	diagnoseApplication,
	findApplicationById,
	getVersionStatus,
	IS_CLOUD,
	restartApplicationService,
} from "@dokploy/server";
import {
	checkServiceAccess,
	checkServicePermissionAndAccess,
} from "@dokploy/server/services/permission";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import type { DeploymentJob } from "@/server/queues/queue-types";
import { myQueue } from "@/server/queues/queueSetup";

const assertSameOrganization = async (
	applicationId: string,
	activeOrganizationId: string,
) => {
	const application = await findApplicationById(applicationId);
	if (application.environment.project.organizationId !== activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this application",
		});
	}
	return application;
};

export const smartDeployRouter = createTRPCRouter({
	diagnoseApplication: protectedProcedure
		.input(
			z.object({
				applicationId: z.string().min(1),
				probes: z.boolean().default(true),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.applicationId, "read");
			await assertSameOrganization(
				input.applicationId,
				ctx.session.activeOrganizationId,
			);
			return diagnoseApplication(input.applicationId, {
				probes: input.probes,
			});
		}),

	getVersionStatus: protectedProcedure
		.input(
			z.object({
				applicationId: z.string().min(1),
				checkRemote: z.boolean().default(true),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.applicationId, "read");
			await assertSameOrganization(
				input.applicationId,
				ctx.session.activeOrganizationId,
			);
			return getVersionStatus(input.applicationId, {
				checkRemote: input.checkRemote,
			});
		}),

	redeployVersion: protectedProcedure
		.input(z.object({ deploymentId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const { application } = await assertRedeployable(input.deploymentId);
			await checkServicePermissionAndAccess(ctx, application.applicationId, {
				deployment: ["create"],
			});
			await assertSameOrganization(
				application.applicationId,
				ctx.session.activeOrganizationId,
			);
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "NOT_IMPLEMENTED",
					message:
						"Redeploying a retained image is not available on Dokploy Cloud",
				});
			}
			const jobData: DeploymentJob = {
				applicationId: application.applicationId,
				titleLog: "Redeploy version",
				descriptionLog: "",
				type: "redeploy-version",
				applicationType: "application",
				sourceDeploymentId: input.deploymentId,
				server: !!application.serverId,
				serverId: application.serverId ?? undefined,
			};
			await myQueue.add(
				"deployments",
				{ ...jobData },
				{ removeOnComplete: true, removeOnFail: true },
			);
			await audit(ctx, {
				action: "deploy",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),

	restartApplication: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const application = await assertSameOrganization(
				input.applicationId,
				ctx.session.activeOrganizationId,
			);
			const deployment = await restartApplicationService(input.applicationId);
			await audit(ctx, {
				action: "reload",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return { deploymentId: deployment.deploymentId };
		}),
});
