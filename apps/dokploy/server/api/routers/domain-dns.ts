import {
	findApplicationById,
	findComposeById,
	findDnsProvidersByOrganizationId,
	findDomainById,
	findDomainsByApplicationId,
	findDomainsByComposeId,
	findServerById,
	getAccessibleServerIds,
} from "@dokploy/server";
import {
	checkPermission,
	checkServicePermissionAndAccess,
	hasPermission,
} from "@dokploy/server/services/permission";
import {
	deleteRecordQuietly,
	describeTrackedRecord,
	describeTunnelForProvider,
	ensureDomainRecord,
	findTrackedDomainIds,
	findTrackedRecord,
	getServiceServerIps,
	removeTunnelRouteQuietly,
	suggestDomainRecord,
	type TunnelProviderStatus,
	type TunnelTarget,
	trackDomainRecord,
	trackedTunnel,
} from "@dokploy/server/smart-deploy/dns/domain-dns";
import { baseLabel } from "@dokploy/server/smart-deploy/dns/names";
import { detectTunnel } from "@dokploy/server/smart-deploy/tunnel/detect";
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

const recordTarget = z.enum(["ip", "tunnel"]).default("ip");

/** The tunnel connector of the server, if Dokploy can add routes to it. */
const usableTunnel = async (
	serverId?: string | null,
): Promise<TunnelTarget | null> => {
	const tunnel = await detectTunnel(serverId);
	return tunnel?.status === "found" ? tunnel : null;
};

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
			const hasCloudflare = providers.some(
				(p) => p.providerType === "cloudflare",
			);
			const [serverIps, tunnel] = await Promise.all([
				providers.length ? getServiceServerIps(service.serverId) : [],
				hasCloudflare ? detectTunnel(service.serverId) : null,
			]);
			return {
				providers,
				canCreateRecords: canCreate,
				baseLabel: baseLabel(service.name, service.environmentName),
				serverIps,
				tunnel:
					tunnel?.status === "found"
						? {
								status: "found" as const,
								tunnelId: tunnel.tunnelId,
								withConfigFile: !!tunnel.configFile,
							}
						: tunnel,
			};
		}),

	suggest: protectedProcedure
		.input(
			serviceInput.extend({
				dnsProviderId: ID,
				zoneId: z.string().min(1).max(255),
				name: z.string().max(253).optional(),
				target: recordTarget,
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
				tunnel: (await usableTunnel(service.serverId)) ?? undefined,
				target: input.target,
			});
		}),

	createDomain: protectedProcedure
		.input(
			apiCreateDomain.omit({ host: true }).extend({
				dnsProviderId: ID,
				zoneId: z.string().min(1).max(255),
				name: z.string().min(1).max(253),
				ip: z.ipv4().optional(),
				proxied: z.boolean().default(false),
				target: recordTarget,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const {
				dnsProviderId,
				zoneId,
				name,
				ip,
				proxied,
				target,
				...domainInput
			} = input;
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

			let tunnel: TunnelTarget | undefined;
			if (target === "tunnel") {
				tunnel = (await usableTunnel(service.serverId)) ?? undefined;
				if (!tunnel) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"No Cloudflare Tunnel that Dokploy can manage runs on this server",
					});
				}
				// Cloudflare terminates TLS and the tunnel reaches Traefik over
				// HTTP: an HTTPS redirect in Traefik would loop forever.
				domainInput.https = false;
				domainInput.certificateType = "none";
			}

			const record = await ensureDomainRecord({
				organizationId: ctx.session.activeOrganizationId,
				dnsProviderId,
				zoneId,
				fqdn: name,
				ip,
				serverIps: await getServiceServerIps(service.serverId),
				proxied,
				tunnel,
				serverId: service.serverId,
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
				if (record.routeCreated && record.tunnel) {
					await removeTunnelRouteQuietly(
						ctx.session.activeOrganizationId,
						dnsProviderId,
						record.name,
						record.tunnel,
						service.serverId,
					).catch((cleanupError) =>
						console.error("[domain-dns] route rollback failed:", cleanupError),
					);
				}
				throw error;
			}
			if (record.created || record.routeCreated) {
				await trackDomainRecord(domain.domainId, {
					dnsProviderId,
					zoneId,
					recordId: record.recordId,
					name: record.name,
					tunnel: record.tunnel,
				});
			}
			return {
				domain,
				record: {
					name: record.name,
					created: record.created,
					viaTunnel: !!record.tunnel,
				},
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

	/** The Cloudflare Tunnel connector of a server, for its settings page. */
	tunnelStatus: protectedProcedure
		.input(
			z.object({
				serverId: ID.optional(),
				refresh: z.boolean().default(false),
			}),
		)
		.query(async ({ ctx, input }) => {
			if (input.serverId) {
				await checkPermission(ctx, { server: ["read"] });
				const server = await findServerById(input.serverId);
				const accessible = await getAccessibleServerIds(ctx.session);
				if (
					server.organizationId !== ctx.session.activeOrganizationId ||
					!accessible.has(input.serverId)
				) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Server not found",
					});
				}
			} else if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
				throw new TRPCError({ code: "UNAUTHORIZED" });
			}

			const tunnel = await detectTunnel(input.serverId, input.refresh);
			if (tunnel?.status !== "found") return { tunnel, providers: [] };

			const providers = (await hasPermission(ctx, { dnsProvider: ["read"] }))
				? (
						await findDnsProvidersByOrganizationId(
							ctx.session.activeOrganizationId,
						)
					).filter((p) => p.config.providerType === "cloudflare")
				: [];
			return {
				tunnel: {
					status: tunnel.status,
					tunnelId: tunnel.tunnelId,
					connector: tunnel.connector,
					origin: tunnel.origin,
					configPath: tunnel.configFile?.path ?? null,
					configProblem: tunnel.configProblem ?? null,
				},
				providers: await Promise.all(
					providers.map(async (provider) => ({
						name: provider.name,
						status:
							provider.config.providerType === "cloudflare"
								? await describeTunnelForProvider(
										provider.config,
										tunnel,
									).catch(
										(error): TunnelProviderStatus => ({
											usable: false,
											reason:
												error instanceof Error
													? error.message
													: "Cloudflare could not be reached",
										}),
									)
								: ({ usable: false, reason: "Not Cloudflare" } as const),
					})),
				),
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
				name: string;
				tunnel: ReturnType<typeof trackedTunnel>;
				serverId: string | null;
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
				if (!tracked) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "This domain has no DNS record created by Dokploy",
					});
				}
				record = {
					providerId: tracked.dnsProviderId as string,
					zoneId: tracked.zoneId,
					recordId: tracked.recordId,
					name: tracked.name,
					tunnel: trackedTunnel(tracked),
					serverId: service.serverId ?? null,
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
				if (record.tunnel) {
					await removeTunnelRouteQuietly(
						ctx.session.activeOrganizationId,
						record.providerId,
						record.name,
						record.tunnel,
						record.serverId,
					);
				}
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
