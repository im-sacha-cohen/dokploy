import {
	applyDomainPortFix,
	assertComposeRedeployable,
	assertRedeployable,
	buildTimeline,
	describeSource,
	diagnoseApplication,
	diagnoseService,
	findApplicationById,
	findComposeById,
	findDeploymentById,
	findDomainById,
	findProposedFix,
	getComposeVersionStatus,
	getVersionStatus,
	listRemoteCommits,
	restartApplicationService,
	runPreflight,
	validateFix,
} from "@dokploy/server";
import {
	checkServiceAccess,
	checkServicePermissionAndAccess,
} from "@dokploy/server/services/permission";
import { loadDatabase } from "@dokploy/server/smart-deploy/diagnostics/collect/database";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	enqueueApplicationJob,
	enqueueComposeJob,
} from "@/server/utils/enqueue-application-job";
import { composeRouter } from "./compose";
import { domainRouter } from "./domain";
import { mariadbRouter } from "./mariadb";
import { mongoRouter } from "./mongo";
import { mysqlRouter } from "./mysql";
import { postgresRouter } from "./postgres";
import { redisRouter } from "./redis";

const SERVICE_TYPES = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
] as const;
type ServiceType = (typeof SERVICE_TYPES)[number];
const serviceInput = z.object({
	serviceType: z.enum(SERVICE_TYPES),
	serviceId: z.string().min(1),
});

const loadServiceRow = (type: ServiceType, id: string) =>
	type === "application"
		? findApplicationById(id)
		: type === "compose"
			? findComposeById(id)
			: loadDatabase(type, id);

const assertServiceInOrganization = async (
	type: ServiceType,
	id: string,
	activeOrganizationId: string,
) => {
	const row = await loadServiceRow(type, id);
	if (row.environment.project.organizationId !== activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this service",
		});
	}
	return row;
};

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

const commitShaInput = z
	.string()
	.trim()
	.toLowerCase()
	.regex(
		/^[0-9a-f]{7,40}$/,
		"Expected a commit SHA (7 to 40 hexadecimal characters)",
	);

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

	/** Smart Deploy diagnosis of any service: application, compose stack or database. */
	diagnoseService: protectedProcedure
		.input(serviceInput.extend({ probes: z.boolean().default(true) }))
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.serviceId, "read");
			await assertServiceInOrganization(
				input.serviceType,
				input.serviceId,
				ctx.session.activeOrganizationId,
			);
			return diagnoseService(input.serviceType, input.serviceId, {
				probes: input.probes,
			});
		}),

	/**
	 * Applies a fix the current diagnosis of a compose stack or database
	 * proposes, through the unchanged upstream procedures (and their checks).
	 */
	applyServiceFix: protectedProcedure
		.input(
			serviceInput.extend({
				action: z.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("update_domain_port"),
						domainId: z.string().min(1),
						host: z.string().min(1),
						port: z.number().int().min(1).max(65535),
					}),
					z.object({ kind: z.literal("redeploy_service") }),
				]),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const { serviceType, serviceId, action } = input;
			if (serviceType === "application") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Use applyFix for applications",
				});
			}
			await checkServicePermissionAndAccess(
				ctx,
				serviceId,
				action.kind === "update_domain_port"
					? { domain: ["create"] }
					: { deployment: ["create"] },
			);
			await assertServiceInOrganization(
				serviceType,
				serviceId,
				ctx.session.activeOrganizationId,
			);
			const report = await diagnoseService(serviceType, serviceId);
			const finding = findProposedFix(report.findings, action);
			if (!finding) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message:
						"This fix is not proposed by the current diagnosis (the situation may have changed). Run the diagnosis again.",
				});
			}

			if (action.kind === "update_domain_port") {
				const domain = await findDomainById(action.domainId);
				if (serviceType !== "compose" || domain.composeId !== serviceId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "The domain does not belong to this service",
					});
				}
				await domainRouter.createCaller(ctx).update({
					domainId: domain.domainId,
					host: domain.host,
					path: domain.path,
					port: action.port,
					https: domain.https,
					certificateType: domain.certificateType,
					customCertResolver: domain.customCertResolver,
					customEntrypoint: domain.customEntrypoint,
					serviceName: domain.serviceName,
					domainType: domain.domainType,
					internalPath: domain.internalPath,
					stripPath: domain.stripPath,
				});
				// Compose routes are container labels: they change on redeploy.
				await composeRouter
					.createCaller(ctx)
					.redeploy({ composeId: serviceId });
				return {
					applied: action.kind,
					finding: finding.code,
					redeployed: true,
				};
			}

			const stopped = finding.code === "SERVICE_STOPPED";
			if (serviceType === "compose") {
				const caller = composeRouter.createCaller(ctx);
				if (stopped) await caller.start({ composeId: serviceId });
				else await caller.redeploy({ composeId: serviceId });
			} else {
				const callers = {
					postgres: () => postgresRouter.createCaller(ctx),
					mysql: () => mysqlRouter.createCaller(ctx),
					mariadb: () => mariadbRouter.createCaller(ctx),
					mongo: () => mongoRouter.createCaller(ctx),
					redis: () => redisRouter.createCaller(ctx),
				};
				const caller = callers[serviceType]() as unknown as Record<
					"start" | "deploy",
					(input: Record<string, string>) => Promise<unknown>
				>;
				const idInput = { [`${serviceType}Id`]: serviceId };
				if (stopped && report.facts.serviceExists) await caller.start(idInput);
				else await caller.deploy(idInput);
			}
			return {
				applied: action.kind,
				finding: finding.code,
				redeployed: !stopped,
			};
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
	/** The last commits of the configured branch, to pick one to deploy. */
	listCommits: protectedProcedure
		.input(
			z.object({
				serviceType: z.enum(["application", "compose"]),
				serviceId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.serviceId, "read");
			const service = await assertServiceInOrganization(
				input.serviceType,
				input.serviceId,
				ctx.session.activeOrganizationId,
			);
			if (!("sourceType" in service)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Not a Git service",
				});
			}
			return listRemoteCommits(
				service as Parameters<typeof listRemoteCommits>[0],
			);
		}),

	/** Fetches, builds and deploys one commit of the application's branch. */
	deployCommit: protectedProcedure
		.input(
			z.object({
				applicationId: z.string().min(1),
				commitSha: commitShaInput,
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const application = await assertSameOrganization(
				input.applicationId,
				ctx.session.activeOrganizationId,
			);
			if (!describeSource(application).isGit) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deploying a commit needs a Git source",
				});
			}
			await enqueueApplicationJob(application, {
				type: "deploy",
				titleLog: `Deploy commit ${input.commitSha.slice(0, 7)}`,
				commitSha: input.commitSha,
			});
			await audit(ctx, {
				action: "deploy",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),

	getComposeVersions: protectedProcedure
		.input(z.object({ composeId: z.string().min(1) }))
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.composeId, "read");
			await assertServiceInOrganization(
				"compose",
				input.composeId,
				ctx.session.activeOrganizationId,
			);
			return getComposeVersionStatus(input.composeId);
		}),

	deployComposeCommit: protectedProcedure
		.input(
			z.object({
				composeId: z.string().min(1),
				commitSha: commitShaInput,
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["create"],
			});
			const compose = await assertServiceInOrganization(
				"compose",
				input.composeId,
				ctx.session.activeOrganizationId,
			);
			if (!("composeId" in compose) || compose.sourceType === "raw") {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Deploying a commit needs a Git source; this stack's compose file is edited in Dokploy",
				});
			}
			await enqueueComposeJob(compose, {
				type: "deploy",
				titleLog: `Deploy commit ${input.commitSha.slice(0, 7)}`,
				commitSha: input.commitSha,
			});
			await audit(ctx, {
				action: "deploy",
				resourceType: "compose",
				resourceId: compose.composeId,
				resourceName: compose.name,
			});
			return true;
		}),

	/** Runs again the retained images of an earlier compose deployment. */
	redeployComposeVersion: protectedProcedure
		.input(z.object({ deploymentId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const { compose } = await assertComposeRedeployable(input.deploymentId);
			await checkServicePermissionAndAccess(ctx, compose.composeId, {
				deployment: ["create"],
			});
			await assertServiceInOrganization(
				"compose",
				compose.composeId,
				ctx.session.activeOrganizationId,
			);
			await enqueueComposeJob(compose, {
				type: "redeploy-version",
				sourceDeploymentId: input.deploymentId,
			});
			await audit(ctx, {
				action: "deploy",
				resourceType: "compose",
				resourceId: compose.composeId,
				resourceName: compose.name,
			});
			return true;
		}),
});
