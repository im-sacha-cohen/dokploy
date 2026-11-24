import {
	CloudflareApiError,
	type CloudflareConfig,
	cfFetch,
} from "./cloudflare";
import {
	CLOUDFLARE_PERMISSIONS,
	explainCloudflareError,
	listCloudflareAccounts,
} from "./cloudflare-tunnel";

export type PermissionCheck =
	| { status: "ok"; detail?: string }
	| { status: "missing" | "error"; detail: string }
	| { status: "skipped" };

export interface CloudflareTokenReport {
	token: PermissionCheck;
	zoneRead: PermissionCheck;
	dnsEdit: PermissionCheck;
	tunnelEdit: PermissionCheck;
}

const SKIPPED: PermissionCheck = { status: "skipped" };

const isRefusal = (error: unknown) =>
	error instanceof CloudflareApiError &&
	(error.status === 403 || error.errors.some((e) => e.code === 10000));

const failed = (error: unknown, permission: string): PermissionCheck => ({
	status: isRefusal(error) ? "missing" : "error",
	detail: explainCloudflareError(error, permission),
});

/** A refusal that concerns the token itself, not one of its permissions. */
const tokenProblem = (error: unknown) =>
	error instanceof CloudflareApiError &&
	(/from location|invalid (api|access) token/i.test(error.detail) ||
		error.errors.some((e) => e.code === 1000));

interface Zone {
	id: string;
	name: string;
	account: { id: string };
}

/**
 * Tries each permission Dokploy uses. DNS edit is proven by creating then
 * deleting a TXT record, as Cloudflare offers no way to read a token's
 * permissions without the "API Tokens Read" permission. Tunnel edit is only
 * read: writing would change a live tunnel.
 */
export const checkCloudflareToken = async (
	config: CloudflareConfig,
): Promise<CloudflareTokenReport> => {
	let zones: Zone[];
	try {
		zones = await cfFetch<Zone[]>(config, "/zones?per_page=50");
	} catch (error) {
		if (tokenProblem(error)) {
			return {
				token: {
					status: "error",
					detail: explainCloudflareError(
						error,
						CLOUDFLARE_PERMISSIONS.zoneRead,
					),
				},
				zoneRead: SKIPPED,
				dnsEdit: SKIPPED,
				tunnelEdit: SKIPPED,
			};
		}
		return {
			token: { status: "ok" },
			zoneRead: failed(error, CLOUDFLARE_PERMISSIONS.zoneRead),
			dnsEdit: SKIPPED,
			tunnelEdit: await checkTunnelEdit(config, []),
		};
	}

	const zoneRead: PermissionCheck =
		zones.length > 0
			? {
					status: "ok",
					detail: `${zones.length} zone${zones.length > 1 ? "s" : ""}: ${zones
						.slice(0, 3)
						.map((zone) => zone.name)
						.join(", ")}${zones.length > 3 ? "…" : ""}`,
				}
			: {
					status: "missing",
					detail:
						'The token reaches no zone: set "Zone Resources" to the zones Dokploy manages.',
				};

	const [dnsEdit, tunnelEdit] = await Promise.all([
		zones[0] ? checkDnsEdit(config, zones[0]) : SKIPPED,
		checkTunnelEdit(
			config,
			zones.map((zone) => zone.account.id),
		),
	]);
	return { token: { status: "ok" }, zoneRead, dnsEdit, tunnelEdit };
};

const checkDnsEdit = async (
	config: CloudflareConfig,
	zone: Zone,
): Promise<PermissionCheck> => {
	const path = `/zones/${encodeURIComponent(zone.id)}/dns_records`;
	let record: { id: string };
	try {
		record = await cfFetch<{ id: string }>(config, path, {
			method: "POST",
			body: JSON.stringify({
				type: "TXT",
				name: `_dokploy-permission-check.${zone.name}`,
				content: '"Dokploy permission check, safe to delete"',
				ttl: 60,
			}),
		});
	} catch (error) {
		return failed(error, CLOUDFLARE_PERMISSIONS.dnsEdit);
	}
	try {
		await cfFetch(config, `${path}/${encodeURIComponent(record.id)}`, {
			method: "DELETE",
		});
	} catch {
		return {
			status: "ok",
			detail: `Test record created in ${zone.name} but not removed: delete _dokploy-permission-check by hand.`,
		};
	}
	return {
		status: "ok",
		detail: `Test record created and removed in ${zone.name}`,
	};
};

const checkTunnelEdit = async (
	config: CloudflareConfig,
	zoneAccountIds: string[],
): Promise<PermissionCheck> => {
	const ids = new Set(zoneAccountIds);
	// A token without account-level read permissions lists no account: the
	// zones' accounts are where its tunnels can be.
	const listed = await listCloudflareAccounts(config).catch(() => []);
	for (const account of listed) ids.add(account.id);
	if (ids.size === 0) {
		return {
			status: "missing",
			detail: `The token reaches no Cloudflare account: add "${CLOUDFLARE_PERMISSIONS.tunnelEdit}" on the account of your tunnel.`,
		};
	}
	const results = await Promise.allSettled(
		[...ids].map((id) =>
			cfFetch(
				config,
				`/accounts/${encodeURIComponent(id)}/cfd_tunnel?per_page=1&is_deleted=false`,
			),
		),
	);
	if (results.some((result) => result.status === "fulfilled")) {
		return { status: "ok" };
	}
	const failure = results.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	return failed(failure?.reason, CLOUDFLARE_PERMISSIONS.tunnelEdit);
};
