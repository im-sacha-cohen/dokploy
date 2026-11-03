import {
	findApplicationById,
	findComposeById,
	findDnsProvidersByOrganizationId,
	findDomainById,
	findDomainsByApplicationId,
	findDomainsByComposeId,
} from "@dokploy/server";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	hasPermission,
} from "@dokploy/server/services/permission";
import {
	deleteRecordQuietly,
	describeTrackedRecord,
	ensureDomainRecord,
	findTrackedDomainIds,
	findTrackedRecord,
	getServiceServerIps,
	suggestDomainRecord,
	trackDomainRecord,
} from "@dokploy/server/smart-deploy/dns/domain-dns";
import { baseLabel } from "@dokploy/server/smart-deploy/dns/names";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { apiCreateDomain } from "@/server/db/schema";
import { domainRouter } from "./domain";

const ID = z.string().min(1).max(64);
const serviceInput = z.object({
	serviceType: z.enum(["application", "compose"]),
	serviceId: ID,
});

type Ctx = Parameters<typeof checkPermission>[0];

/** Name, environment and server of the service, after the domain permission check. */
const loadService = async (
	ctx: Ctx,
	serviceType: "application" | "compose",
	serviceId: string,
	action: "read" | "create" | "delete",
) => {
	await checkServicePermissionAndAccess(ctx, serviceId, { domain: [action] });
	const service =
		serviceType === "application"
			? await findApplicationById(serviceId)
			: await findComposeById(serviceId);
	if (
		service.environment.project.organizationId !==
		ctx.session.activeOrganizationId
	) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Service not found" });
	}
	return {
		name: service.name,
		environmentName: service.environment.name,
		serverId: service.serverId,
	};
};

/**
 * Creates a domain's DNS record from the domain form, then the domain itself
 * through the unchanged `domain` procedures.
 */
export const domainDnsRouter = createTRPCRouter({
	context: protectedProcedure
		.input(serviceInput)
		.query(async ({ ctx, input }) => {
			const service = await loadService(
				ctx,
				input.serviceType,
				input.serviceId,
				"create",
			);
			const canRead = await hasPermission(ctx, { dnsProvider: ["read"] });
			const canCreate = await hasPermission(ctx, { dnsProvider: ["update"] });
			const providers = canRead
				? (
						await findDnsProvidersByOrganizationId(
							ctx.session.activeOrganizationId,
						)
					).map((p) => ({
						dnsProviderId: p.dnsProviderId,
						name: p.name,
						providerType: p.providerType,
					}))
				: [];
			return {
				providers,
				canCreateRecords: canCreate,
				baseLabel: baseLabel(service.name, service.environmentName),
				serverIps: providers.length
					? await getServiceServerIps(service.serverId)
					: [],
			};
		}),

	suggest: protectedProcedure
		.input(
			serviceInput.extend({
				dnsProviderId: ID,
				zoneId: z.string().min(1).max(255),
				name: z.string().max(253).optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const service = await loadService(
				ctx,
				input.serviceType,
				input.serviceId,
				"create",
			);
			await checkPermission(ctx, { dnsProvider: ["read"] });
			return suggestDomainRecord({
				organizationId: ctx.session.activeOrganizationId,
				dnsProviderId: input.dnsProviderId,
				zoneId: input.zoneId,
				baseLabel: baseLabel(service.name, service.environmentName),
				requestedName: input.name || undefined,
				serverIps: await getServiceServerIps(service.serverId),
			});
		}),

	createDomain: protectedProcedure
		.input(
			apiCreateDomain.omit({ host: true }).extend({
				dnsProviderId: ID,
				zoneId: z.string().min(1).max(255),
				name: z.string().min(1).max(253),
				ip: z.ipv4(),
				proxied: z.boolean().default(false),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { dnsProviderId, zoneId, name, ip, proxied, ...domainInput } =
				input;
			const serviceType =
				domainInput.domainType === "compose" ? "compose" : "application";
			const serviceId =
				serviceType === "compose"
					? domainInput.composeId
					: domainInput.applicationId;
			if (!serviceId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "An application or a compose service is required",
				});
			}
			const service = await loadService(ctx, serviceType, serviceId, "create");
			await checkPermission(ctx, { dnsProvider: ["update"] });

			const record = await ensureDomainRecord({
				organizationId: ctx.session.activeOrganizationId,
				dnsProviderId,
				zoneId,
				fqdn: name,
				ip,
				serverIps: await getServiceServerIps(service.serverId),
				proxied,
			});

			let domain: Awaited<
				ReturnType<ReturnType<typeof domainRouter.createCaller>["create"]>
			>;
			try {
				domain = await domainRouter
					.createCaller(ctx)
					.create({ ...domainInput, host: record.name });
			} catch (error) {
				// Leave nothing behind at the provider for a domain that does not exist.
				if (record.created) {
					await deleteRecordQuietly(
						ctx.session.activeOrganizationId,
						dnsProviderId,
						zoneId,
						record.recordId,
					).catch((cleanupError) =>
						console.error("[domain-dns] rollback failed:", cleanupError),
					);
				}
				throw error;
			}
			if (record.created) {
				await trackDomainRecord(domain.domainId, {
					dnsProviderId,
					zoneId,
					recordId: record.recordId,
					name: record.name,
				});
			}
			return {
				domain,
				record: { name: record.name, created: record.created },
			};
		}),

	trackedDomains: protectedProcedure
		.input(serviceInput)
		.query(async ({ ctx, input }) => {
			await loadService(ctx, input.serviceType, input.serviceId, "read");
			const domains =
				input.serviceType === "application"
					? await findDomainsByApplicationId(input.serviceId)
					: await findDomainsByComposeId(input.serviceId);
			return findTrackedDomainIds(domains.map((d) => d.domainId));
		}),

	recordForDomain: protectedProcedure
		.input(z.object({ domainId: ID }))
		.query(async ({ ctx, input }) => {
			const domain = await findDomainById(input.domainId);
			const serviceId = domain.applicationId ?? domain.composeId;
			if (!serviceId) return null;
			const service = await loadService(
				ctx,
				domain.applicationId ? "application" : "compose",
				serviceId,
				"read",
			);
			const tracked = await findTrackedRecord(input.domainId);
			if (!tracked) return null;
			if (!(await hasPermission(ctx, { dnsProvider: ["read"] }))) return null;
			const info = await describeTrackedRecord(
				ctx.session.activeOrganizationId,
				tracked,
				await getServiceServerIps(service.serverId),
			).catch(() => null);
			if (!info) return null;
			return {
				...info,
				canDelete:
					info.deletable &&
					(await hasPermission(ctx, { dnsProvider: ["delete"] })),
			};
		}),

	deleteDomain: protectedProcedure
		.input(z.object({ domainId: ID, deleteRecord: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			const domain = await findDomainById(input.domainId);
			const serviceId = domain.applicationId ?? domain.composeId;
			let record: {
				zoneId: string;
				recordId: string;
				providerId: string;
			} | null = null;
			if (input.deleteRecord) {
				if (!serviceId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "This domain has no DNS record created by Dokploy",
					});
				}
				const service = await loadService(
					ctx,
					domain.applicationId ? "application" : "compose",
					serviceId,
					"delete",
				);
				await checkPermission(ctx, { dnsProvider: ["delete"] });
				const tracked = await findTrackedRecord(input.domainId);
				const info = tracked
					? await describeTrackedRecord(
							ctx.session.activeOrganizationId,
							tracked,
							await getServiceServerIps(service.serverId),
						)
					: null;
				if (!info?.deletable) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							info?.reason ??
							"This domain has no DNS record created by Dokploy",
					});
				}
				record = {
					providerId: tracked?.dnsProviderId as string,
					zoneId: tracked?.zoneId as string,
					recordId: tracked?.recordId as string,
				};
			}

			await domainRouter.createCaller(ctx).delete({ domainId: input.domainId });

			if (!record) return { recordDeleted: false };
			try {
				await deleteRecordQuietly(
					ctx.session.activeOrganizationId,
					record.providerId,
					record.zoneId,
					record.recordId,
				);
				return { recordDeleted: true };
			} catch (error) {
				return {
					recordDeleted: false,
					recordError:
						error instanceof Error
							? error.message
							: "Could not delete the record",
				};
			}
		}),
});
