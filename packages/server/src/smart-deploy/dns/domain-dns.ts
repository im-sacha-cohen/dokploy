// Creates and removes the DNS record of a Dokploy domain through the DNS
// providers configured in Settings › DNS. Never overwrites a record: a name
// already used by another A/AAAA/CNAME is reported as taken.
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import type { DnsProviderConfig } from "../../db/schema";
import { domainDnsRecord } from "../../db/schema";
import {
	createDnsProviderRecord,
	deleteDnsProviderRecord,
	findDnsProviderInOrganization,
	listDnsProviderRecords,
	listDnsProviderZones,
} from "../../services/dns-provider";
import { getServerIpCandidates } from "../../services/domain";
import { findServerById } from "../../services/server";
import { getWebServerSettings } from "../../services/web-server-settings";
import type { CloudflareConfig } from "../../utils/dns/cloudflare";
import {
	addCloudflareTunnelRoute,
	CLOUDFLARE_PERMISSIONS,
	checkCloudflareTunnelAccess,
	explainCloudflareError,
	getCloudflareTunnel,
	getCloudflareZoneAccountId,
	removeCloudflareTunnelRoute,
} from "../../utils/dns/cloudflare-tunnel";
import {
	addConfigFileRoute,
	removeConfigFileRoute,
} from "../tunnel/config-file";
import {
	detectTunnel,
	type FoundTunnel,
	tunnelHostname,
} from "../tunnel/detect";
import { TunnelRouteConflictError } from "../tunnel/ingress";
import {
	classifyName,
	isValidHostInZone,
	normalizeHost,
	type RecordTarget,
	rankServerIps,
	suggestFqdn,
	toFqdn,
} from "./names";

/** A tunnel running on the service's server, found by `detectTunnel`. */
export type TunnelTarget = FoundTunnel;

export interface TrackedTunnel {
	tunnelAccountId: string;
	tunnelId: string;
	tunnelService: string;
}

const tunnelRecordTarget = (tunnelId: string): RecordTarget => ({
	type: "CNAME",
	contents: [tunnelHostname(tunnelId)],
});

export type TunnelCheck =
	| {
			usable: true;
			name: string;
			accountId: string;
			/** "remote": routes through the API; "file": in config.yml, then a restart. */
			mode: "remote" | "file";
	  }
	| { usable: false; reason: string };

/** Whether the tunnel can publish names of this zone. */
export const checkTunnelForZone = async (
	config: DnsProviderConfig,
	zoneId: string,
	tunnel: TunnelTarget,
): Promise<TunnelCheck> => {
	if (config.providerType !== "cloudflare") {
		return {
			usable: false,
			reason:
				"This zone is not on Cloudflare: a tunnel route needs a Cloudflare zone.",
		};
	}
	let zoneAccountId: string;
	try {
		zoneAccountId = await getCloudflareZoneAccountId(config, zoneId);
	} catch (error) {
		return {
			usable: false,
			reason: explainCloudflareError(error, CLOUDFLARE_PERMISSIONS.zoneRead),
		};
	}
	if (tunnel.accountId && zoneAccountId !== tunnel.accountId) {
		return {
			usable: false,
			reason:
				"The tunnel on this server belongs to another Cloudflare account than this zone.",
		};
	}
	// A config file does not always name the account: the tunnel must then
	// be found in the zone's account.
	const accountId = tunnel.accountId ?? zoneAccountId;
	try {
		const found = await getCloudflareTunnel(config, accountId, tunnel.tunnelId);
		// A tunnel managed from the dashboard ignores the ingress of config.yml.
		if (found.remote_config) {
			return { usable: true, name: found.name, accountId, mode: "remote" };
		}
		if (tunnel.configFile) {
			return { usable: true, name: found.name, accountId, mode: "file" };
		}
		return {
			usable: false,
			reason:
				tunnel.configProblem ??
				`Tunnel ${found.name} is configured locally, but its config.yml was not found on this server.`,
		};
	} catch (error) {
		return {
			usable: false,
			reason: `Cloudflare could not read the tunnel of this server in the zone's account. ${explainCloudflareError(error, CLOUDFLARE_PERMISSIONS.tunnelEdit)}`,
		};
	}
};

export type TunnelProviderStatus =
	| { usable: true; name: string; mode: "remote" | "file" }
	| { usable: false; reason: string };

/**
 * What a Cloudflare DNS provider can do with the server's tunnel, before any
 * zone is chosen: the tunnel is looked up in the accounts its token reaches.
 */
export const describeTunnelForProvider = async (
	config: CloudflareConfig,
	tunnel: TunnelTarget,
): Promise<TunnelProviderStatus> => {
	const access = await checkCloudflareTunnelAccess(config, tunnel.accountId);
	if (!access.ok) return { usable: false, reason: access.reason };
	let lastError: unknown = null;
	for (const accountId of access.accountIds) {
		let found: Awaited<ReturnType<typeof getCloudflareTunnel>>;
		try {
			found = await getCloudflareTunnel(config, accountId, tunnel.tunnelId);
		} catch (error) {
			lastError = error;
			continue;
		}
		if (found.remote_config) {
			return { usable: true, name: found.name, mode: "remote" };
		}
		if (tunnel.configFile) {
			return { usable: true, name: found.name, mode: "file" };
		}
		return {
			usable: false,
			reason:
				tunnel.configProblem ??
				`Tunnel ${found.name} is configured locally, but its config.yml was not found on this server.`,
		};
	}
	return {
		usable: false,
		reason:
			tunnel.accountId && lastError
				? explainCloudflareError(lastError, CLOUDFLARE_PERMISSIONS.tunnelEdit)
				: "This tunnel is not in the Cloudflare accounts this API token can reach.",
	};
};

const addRouteFor = (
	config: CloudflareConfig,
	check: Extract<TunnelCheck, { usable: true }>,
	tunnel: TunnelTarget,
	serverId: string | null | undefined,
	name: string,
) =>
	check.mode === "remote" || !tunnel.configFile
		? addCloudflareTunnelRoute(
				config,
				check.accountId,
				tunnel.tunnelId,
				name,
				tunnel.origin,
			)
		: addConfigFileRoute(
				serverId,
				tunnel.tunnelId,
				tunnel.configFile,
				name,
				tunnel.origin,
			);

/** IPv4 addresses the service's server answers on, best first. */
export const getServiceServerIps = async (serverId?: string | null) => {
	const configured = serverId
		? (await findServerById(serverId)).ipAddress
		: (await getWebServerSettings())?.serverIp;
	return rankServerIps(await getServerIpCandidates(serverId), configured);
};

/** The provider (checked against the organization) and the zone. */
export const loadDnsZone = async (
	organizationId: string,
	dnsProviderId: string,
	zoneId: string,
) => {
	const provider = await findDnsProviderInOrganization(
		dnsProviderId,
		organizationId,
	);
	const zone = (await listDnsProviderZones(provider.config)).find(
		(z) => z.id === zoneId,
	);
	if (!zone) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "This zone is not available with this DNS provider",
		});
	}
	return { provider, zone };
};

export const suggestDomainRecord = async ({
	organizationId,
	dnsProviderId,
	zoneId,
	baseLabel,
	requestedName,
	serverIps,
	tunnel,
	target = "ip",
}: {
	organizationId: string;
	dnsProviderId: string;
	zoneId: string;
	baseLabel: string;
	requestedName?: string;
	serverIps: string[];
	/** The server's tunnel, checked against the zone. */
	tunnel?: TunnelTarget;
	/** Whether the name is wanted as a tunnel route or an A record. */
	target?: "ip" | "tunnel";
}) => {
	const { provider, zone } = await loadDnsZone(
		organizationId,
		dnsProviderId,
		zoneId,
	);
	const [records, tunnelCheck] = await Promise.all([
		listDnsProviderRecords(provider.config, zone.id),
		tunnel ? checkTunnelForZone(provider.config, zone.id, tunnel) : null,
	]);
	const here =
		tunnel && target === "tunnel" && tunnelCheck?.usable
			? tunnelRecordTarget(tunnel.tunnelId)
			: serverIps;
	const suggestion = suggestFqdn(records, baseLabel, zone.name, here);
	const requested = requestedName ? toFqdn(requestedName, zone.name) : null;
	return {
		zone: { id: zone.id, name: normalizeHost(zone.name) },
		suggestion,
		requested: requested
			? {
					fqdn: requested,
					valid: isValidHostInZone(requested, zone.name),
					...classifyName(records, requested, here),
				}
			: null,
		tunnel: tunnelCheck,
	};
};

/**
 * Creates `fqdn` as an A record to `ip`, or with `tunnel` as a CNAME to the
 * tunnel plus the tunnel route, unless the name already points there (then no
 * record is created). Throws when the name is used elsewhere.
 */
export const ensureDomainRecord = async ({
	organizationId,
	dnsProviderId,
	zoneId,
	fqdn,
	ip,
	serverIps,
	proxied,
	tunnel,
	serverId,
}: {
	organizationId: string;
	dnsProviderId: string;
	zoneId: string;
	fqdn: string;
	ip?: string;
	serverIps: string[];
	proxied: boolean;
	tunnel?: TunnelTarget;
	/** The server cloudflared runs on, for a tunnel with a config file. */
	serverId?: string | null;
}) => {
	if (!tunnel && (!ip || !serverIps.includes(ip))) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${ip || "This address"} is not an address of this service's server`,
		});
	}
	const { provider, zone } = await loadDnsZone(
		organizationId,
		dnsProviderId,
		zoneId,
	);
	const name = normalizeHost(fqdn);
	if (!isValidHostInZone(name, zone.name)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${name} is not a valid name in ${zone.name}`,
		});
	}
	const status = classifyName(
		await listDnsProviderRecords(provider.config, zone.id),
		name,
		tunnel ? tunnelRecordTarget(tunnel.tunnelId) : serverIps,
	);
	if (status.status === "taken") {
		throw new TRPCError({
			code: "CONFLICT",
			message: `${name} already exists (${status.records
				.map((r) => `${r.type} ${r.content}`)
				.join(", ")}); choose another name`,
		});
	}
	if (tunnel) {
		return ensureTunnelRecord(
			provider.config,
			zone.id,
			name,
			tunnel,
			serverId,
			status,
		);
	}
	if (status.status === "points_here") {
		return {
			created: false as const,
			routeCreated: false,
			name,
			recordId: status.recordId,
			tunnel: null,
		};
	}
	const { id } = await createDnsProviderRecord(provider.config, {
		zoneId: zone.id,
		type: "A",
		name,
		content: ip as string,
		proxied:
			provider.config.providerType === "cloudflare" ? proxied : undefined,
	});
	return {
		created: true as const,
		name,
		recordId: id,
		routeCreated: false,
		tunnel: null,
	};
};

const ensureTunnelRecord = async (
	config: DnsProviderConfig,
	zoneId: string,
	name: string,
	tunnel: TunnelTarget,
	serverId: string | null | undefined,
	status: { status: "free" } | { status: "points_here"; recordId: string },
) => {
	const check = await checkTunnelForZone(config, zoneId, tunnel);
	if (!check.usable || config.providerType !== "cloudflare") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: check.usable ? "A tunnel needs a Cloudflare zone" : check.reason,
		});
	}
	let routeCreated: boolean;
	try {
		routeCreated = await addRouteFor(config, check, tunnel, serverId, name);
	} catch (error) {
		if (error instanceof TunnelRouteConflictError) {
			throw new TRPCError({ code: "CONFLICT", message: error.message });
		}
		throw error;
	}
	const tracked: TrackedTunnel = {
		tunnelAccountId: check.accountId,
		tunnelId: tunnel.tunnelId,
		tunnelService: tunnel.origin,
	};
	if (status.status === "points_here") {
		return {
			created: false as const,
			routeCreated,
			name,
			recordId: status.recordId,
			tunnel: tracked,
		};
	}
	try {
		const { id } = await createDnsProviderRecord(config, {
			zoneId,
			type: "CNAME",
			name,
			content: tunnelHostname(tunnel.tunnelId),
			// A tunnel hostname only answers through Cloudflare's proxy.
			proxied: true,
		});
		return {
			created: true as const,
			routeCreated,
			name,
			recordId: id,
			tunnel: tracked,
		};
	} catch (error) {
		if (routeCreated) {
			await removeRoute(config, tracked, serverId, name).catch((cleanupError) =>
				console.error(
					"[domain-dns] tunnel route rollback failed:",
					cleanupError,
				),
			);
		}
		throw error;
	}
};

export type TrackedRecord = typeof domainDnsRecord.$inferSelect;

export const trackDomainRecord = async (
	domainId: string,
	record: {
		dnsProviderId: string;
		zoneId: string;
		recordId: string;
		name: string;
		tunnel?: TrackedTunnel | null;
	},
) => {
	const { tunnel, ...fields } = record;
	return db
		.insert(domainDnsRecord)
		.values({ domainId, ...fields, ...(tunnel ?? {}) });
};

export const findTrackedRecord = async (domainId: string) =>
	(await db.query.domainDnsRecord.findFirst({
		where: eq(domainDnsRecord.domainId, domainId),
	})) ?? null;

/** Which of these domains have a record created by Dokploy. */
export const findTrackedDomainIds = async (domainIds: string[]) =>
	domainIds.length === 0
		? []
		: (
				await db
					.select({ domainId: domainDnsRecord.domainId })
					.from(domainDnsRecord)
					.where(inArray(domainDnsRecord.domainId, domainIds))
			).map((row) => row.domainId);

export const deleteRecordQuietly = async (
	organizationId: string,
	dnsProviderId: string,
	zoneId: string,
	recordId: string,
) => {
	const provider = await findDnsProviderInOrganization(
		dnsProviderId,
		organizationId,
	);
	await deleteDnsProviderRecord(provider.config, zoneId, recordId);
};

/**
 * Removes a route from the tunnel's remote configuration, or from its
 * config.yml found again on the server.
 */
const removeRoute = async (
	config: CloudflareConfig,
	tunnel: TrackedTunnel,
	serverId: string | null | undefined,
	name: string,
) => {
	const found = await getCloudflareTunnel(
		config,
		tunnel.tunnelAccountId,
		tunnel.tunnelId,
	);
	if (found.remote_config) {
		return removeCloudflareTunnelRoute(
			config,
			tunnel.tunnelAccountId,
			tunnel.tunnelId,
			name,
			tunnel.tunnelService,
		);
	}
	const detected = await detectTunnel(serverId);
	if (
		detected?.status !== "found" ||
		detected.tunnelId !== tunnel.tunnelId ||
		!detected.configFile
	) {
		throw new Error(
			`The config.yml of tunnel ${found.name} was not found on the server: remove the route of ${name} by hand`,
		);
	}
	return removeConfigFileRoute(
		serverId,
		tunnel.tunnelId,
		detected.configFile,
		name,
		tunnel.tunnelService,
	);
};

/** Removes the route Dokploy added to a tunnel for `name`. */
export const removeTunnelRouteQuietly = async (
	organizationId: string,
	dnsProviderId: string,
	name: string,
	tunnel: TrackedTunnel,
	serverId: string | null | undefined,
) => {
	const provider = await findDnsProviderInOrganization(
		dnsProviderId,
		organizationId,
	);
	if (provider.config.providerType !== "cloudflare") return;
	await removeRoute(provider.config, tunnel, serverId, name);
};

export const trackedTunnel = (tracked: TrackedRecord): TrackedTunnel | null =>
	tracked.tunnelAccountId && tracked.tunnelId && tracked.tunnelService
		? {
				tunnelAccountId: tracked.tunnelAccountId,
				tunnelId: tracked.tunnelId,
				tunnelService: tracked.tunnelService,
			}
		: null;

/**
 * The record Dokploy created for a domain, and whether it may be deleted: it
 * must still exist with the same name and point only to this server (or to
 * its tunnel).
 */
export const describeTrackedRecord = async (
	organizationId: string,
	tracked: TrackedRecord,
	serverIps: string[],
) => {
	if (!tracked.dnsProviderId) return null;
	const provider = await findDnsProviderInOrganization(
		tracked.dnsProviderId,
		organizationId,
	);
	const records = await listDnsProviderRecords(provider.config, tracked.zoneId);
	const record = records.find((r) => r.id === tracked.recordId);
	const target = tracked.tunnelId
		? tunnelRecordTarget(tracked.tunnelId)
		: { type: "A" as const, contents: serverIps };
	const deletable =
		!!record &&
		record.type.toUpperCase() === target.type &&
		normalizeHost(record.name) === normalizeHost(tracked.name) &&
		target.contents.includes(normalizeHost(record.content));
	return {
		name: normalizeHost(tracked.name),
		providerName: provider.name,
		viaTunnel: !!tracked.tunnelId,
		exists: !!record,
		deletable,
		reason: !record
			? "The record no longer exists at the provider"
			: deletable
				? null
				: "The record was changed since Dokploy created it",
	};
};
