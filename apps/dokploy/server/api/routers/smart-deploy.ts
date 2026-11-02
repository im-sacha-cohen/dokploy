import {
	applyDomainPortFix,
	assertRedeployable,
	buildTimeline,
	diagnoseApplication,
	findApplicationById,
	findDeploymentById,
	getVersionStatus,
	IS_CLOUD,
	restartApplicationService,
	runPreflight,
	validateFix,
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

const fixActionSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("update_domain_port"),
		domainId: z.string().min(1),
		host: z.string().min(1),
		port: z.number().int().min(1).max(65535),
	}),
	z.object({ kind: z.literal("deploy_latest") }),
	z.object({
		kind: z.literal("redeploy_deployment"),
		deploymentId: z.string().min(1),
	}),
]);

const enqueueApplicationJob = async (
	application: Awaited<ReturnType<typeof findApplicationById>>,
	job:
		| { type: "deploy"; titleLog: string }
		| { type: "redeploy-version"; sourceDeploymentId: string },
) => {
	if (IS_CLOUD) {
		throw new TRPCError({
			code: "NOT_IMPLEMENTED",
			message: "This action is not available on Dokploy Cloud",
		});
	}
	const jobData: DeploymentJob = {
		applicationId: application.applicationId,
		titleLog: job.type === "deploy" ? job.titleLog : "Redeploy version",
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

	preflight: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.applicationId, "read");
			await assertSameOrganization(
				input.applicationId,
				ctx.session.activeOrganizationId,
			);
			return runPreflight(input.applicationId);
		}),

	getDeploymentTimeline: protectedProcedure
		.input(z.object({ deploymentId: z.string().min(1) }))
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			if (!deployment.applicationId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Only application deployments have a timeline",
				});
			}
			await checkServiceAccess(ctx, deployment.applicationId, "read");
			await assertSameOrganization(
				deployment.applicationId,
				ctx.session.activeOrganizationId,
			);
			return {
				deploymentId: deployment.deploymentId,
				title: deployment.title,
				kind: deployment.kind,
				status: deployment.status,
				verificationStatus: deployment.verificationStatus,
				createdAt: deployment.createdAt,
				logPath: deployment.logPath,
				builtCommitSha: deployment.builtCommitSha,
				imageId: deployment.imageId,
				findings: deployment.verification?.findings ?? [],
				...buildTimeline(deployment),
			};
		}),

	applyFix: protectedProcedure
		.input(
			z.object({
				applicationId: z.string().min(1),
				action: fixActionSchema,
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const { action } = input;
			await checkServicePermissionAndAccess(
				ctx,
				input.applicationId,
				action.kind === "update_domain_port"
					? { domain: ["create"] }
					: { deployment: ["create"] },
			);
			const application = await assertSameOrganization(
				input.applicationId,
				ctx.session.activeOrganizationId,
			);
			const finding = await validateFix(input.applicationId, action);

			if (action.kind === "update_domain_port") {
				const result = await applyDomainPortFix(input.applicationId, action);
				await audit(ctx, {
					action: "update",
					resourceType: "domain",
					resourceId: result.domainId,
					resourceName: result.host,
				});
				return { applied: action.kind, finding: finding.code, result };
			}
			if (action.kind === "redeploy_deployment") {
				await assertRedeployable(action.deploymentId);
				await enqueueApplicationJob(application, {
					type: "redeploy-version",
					sourceDeploymentId: action.deploymentId,
				});
			} else {
				await enqueueApplicationJob(application, {
					type: "deploy",
					titleLog: "Deploy latest (fix)",
				});
			}
			await audit(ctx, {
				action: "deploy",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return { applied: action.kind, finding: finding.code };
		}),

	deployLatest: protectedProcedure
		.input(z.object({ applicationId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const application = await assertSameOrganization(
				input.applicationId,
				ctx.session.activeOrganizationId,
			);
			await enqueueApplicationJob(application, {
				type: "deploy",
				titleLog: "Deploy latest",
			});
			await audit(ctx, {
				action: "deploy",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
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
			await enqueueApplicationJob(application, {
				type: "redeploy-version",
				sourceDeploymentId: input.deploymentId,
			});
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
