// Creates and removes the DNS record of a Dokploy domain through the DNS
// providers configured in Settings › DNS. Never overwrites a record: a name
// already used by another A/AAAA/CNAME is reported as taken.
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
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
import {
	classifyName,
	isValidHostInZone,
	normalizeHost,
	rankServerIps,
	suggestFqdn,
	toFqdn,
} from "./names";

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
}: {
	organizationId: string;
	dnsProviderId: string;
	zoneId: string;
	baseLabel: string;
	requestedName?: string;
	serverIps: string[];
}) => {
	const { provider, zone } = await loadDnsZone(
		organizationId,
		dnsProviderId,
		zoneId,
	);
	const records = await listDnsProviderRecords(provider.config, zone.id);
	const suggestion = suggestFqdn(records, baseLabel, zone.name, serverIps);
	const requested = requestedName ? toFqdn(requestedName, zone.name) : null;
	return {
		zone: { id: zone.id, name: normalizeHost(zone.name) },
		suggestion,
		requested: requested
			? {
					fqdn: requested,
					valid: isValidHostInZone(requested, zone.name),
					...classifyName(records, requested, serverIps),
				}
			: null,
	};
};

/**
 * Creates `fqdn` as an A record to `ip`, unless it already points to this
 * server (then nothing is created). Throws when the name is used elsewhere.
 */
export const ensureDomainRecord = async ({
	organizationId,
	dnsProviderId,
	zoneId,
	fqdn,
	ip,
	serverIps,
	proxied,
}: {
	organizationId: string;
	dnsProviderId: string;
	zoneId: string;
	fqdn: string;
	ip: string;
	serverIps: string[];
	proxied: boolean;
}) => {
	if (!serverIps.includes(ip)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `${ip} is not an address of this service's server`,
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
		serverIps,
	);
	if (status.status === "taken") {
		throw new TRPCError({
			code: "CONFLICT",
			message: `${name} already exists (${status.records
				.map((r) => `${r.type} ${r.content}`)
				.join(", ")}); choose another name`,
		});
	}
	if (status.status === "points_here") {
		return { created: false as const, name, recordId: status.recordId };
	}
	const { id } = await createDnsProviderRecord(provider.config, {
		zoneId: zone.id,
		type: "A",
		name,
		content: ip,
		proxied:
			provider.config.providerType === "cloudflare" ? proxied : undefined,
	});
	return {
		created: true as const,
		name,
		recordId: id,
		provider,
		zone,
	};
};

export type TrackedRecord = typeof domainDnsRecord.$inferSelect;

export const trackDomainRecord = async (
	domainId: string,
	record: {
		dnsProviderId: string;
		zoneId: string;
		recordId: string;
		name: string;
	},
) => db.insert(domainDnsRecord).values({ domainId, ...record });

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
 * The record Dokploy created for a domain, and whether it may be deleted: it
 * must still exist with the same name and point only to this server.
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
	const deletable =
		!!record &&
		record.type.toUpperCase() === "A" &&
		normalizeHost(record.name) === normalizeHost(tracked.name) &&
		serverIps.includes(record.content.trim());
	return {
		name: normalizeHost(tracked.name),
		providerName: provider.name,
		exists: !!record,
		deletable,
		reason: !record
			? "The record no longer exists at the provider"
			: deletable
				? null
				: "The record was changed since Dokploy created it",
	};
};
