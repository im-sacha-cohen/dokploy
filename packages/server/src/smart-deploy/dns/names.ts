// Pure helpers for creating a domain's DNS record from the domain form:
// subdomain suggestion, conflict detection and server IP ranking.
import { isIPv4 } from "node:net";

export interface ExistingRecord {
	id: string;
	type: string;
	name: string;
	content: string;
}

export type NameStatus =
	| { status: "free" }
	| { status: "points_here"; recordId: string }
	| { status: "taken"; records: { type: string; content: string }[] };

const MAX_LABEL = 63;
const MAX_ATTEMPTS = 20;
// Record types that cannot share a name with the A record we would create.
const CONFLICTING_TYPES = new Set(["A", "AAAA", "CNAME", "ALIAS", "ANAME"]);

export const normalizeHost = (name: string) =>
	name.trim().toLowerCase().replace(/\.+$/, "");

/** A DNS label made of the service name: lowercase, [a-z0-9-], ≤ 63 chars. */
export const toLabel = (text: string) =>
	text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, MAX_LABEL)
		.replace(/-+$/g, "");

/** `app` in production, `app-staging` elsewhere. */
export const baseLabel = (serviceName: string, environmentName?: string) => {
	const service = toLabel(serviceName) || "app";
	const env = toLabel(environmentName ?? "");
	return !env || env === "production" || env === "prod"
		? service
		: toLabel(`${service}-${env}`);
};

/** Fully qualified name of `label` in `zone`; `@` or empty means the apex. */
export const toFqdn = (label: string, zone: string) => {
	const name = normalizeHost(label);
	const apex = normalizeHost(zone);
	if (!name || name === "@") return apex;
	return name === apex || name.endsWith(`.${apex}`) ? name : `${name}.${apex}`;
};

export const isValidHostInZone = (fqdn: string, zone: string) => {
	const name = normalizeHost(fqdn);
	const apex = normalizeHost(zone);
	if (name !== apex && !name.endsWith(`.${apex}`)) return false;
	return (
		name.length <= 253 &&
		name.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))
	);
};

export const classifyName = (
	records: ExistingRecord[],
	fqdn: string,
	serverIps: string[],
): NameStatus => {
	const name = normalizeHost(fqdn);
	const conflicting = records.filter(
		(r) =>
			normalizeHost(r.name) === name &&
			CONFLICTING_TYPES.has(r.type.toUpperCase()),
	);
	if (conflicting.length === 0) return { status: "free" };
	const allHere = conflicting.every(
		(r) => r.type.toUpperCase() === "A" && serverIps.includes(r.content.trim()),
	);
	if (allHere && conflicting[0]) {
		return { status: "points_here", recordId: conflicting[0].id };
	}
	return {
		status: "taken",
		records: conflicting.map((r) => ({ type: r.type, content: r.content })),
	};
};

/** First of `base`, `base-2`, `base-3`… that is free or already points here. */
export const suggestFqdn = (
	records: ExistingRecord[],
	base: string,
	zone: string,
	serverIps: string[],
) => {
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const suffix = attempt === 1 ? "" : `-${attempt}`;
		const label = `${base.slice(0, MAX_LABEL - suffix.length).replace(/-+$/, "")}${suffix}`;
		const fqdn = toFqdn(label, zone);
		const status = classifyName(records, fqdn, serverIps);
		if (status.status !== "taken") return { fqdn, status };
	}
	return null;
};

const PRIVATE_V4 = [
	/^10\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

export const isPrivateIPv4 = (ip: string) =>
	PRIVATE_V4.some((pattern) => pattern.test(ip));

/**
 * IPv4 addresses an A record may point to: the configured server IP first,
 * then public addresses, then private ones (only useful on a private network).
 */
export const rankServerIps = (
	candidates: string[],
	configured?: string | null,
) => {
	const unique = [...new Set(candidates.map((ip) => ip.trim()))].filter((ip) =>
		isIPv4(ip),
	);
	const rank = (ip: string) =>
		ip === configured ? 0 : isPrivateIPv4(ip) ? 2 : 1;
	return unique.sort((a, b) => rank(a) - rank(b));
};
