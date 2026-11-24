import {
	addRoute,
	conflictError,
	type IngressRule,
	removeRoute,
} from "../../smart-deploy/tunnel/ingress";
import { withTunnelLock } from "../../smart-deploy/tunnel/lock";
import {
	CloudflareApiError,
	type CloudflareConfig,
	cfFetch,
} from "./cloudflare";

export interface CloudflareTunnel {
	id: string;
	name: string;
	status: string;
	remote_config: boolean;
}

interface TunnelConfiguration {
	config: ({ ingress?: IngressRule[] } & Record<string, unknown>) | null;
}

const tunnelPath = (accountId: string, tunnelId: string) =>
	`/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;

export const getCloudflareTunnel = (
	config: CloudflareConfig,
	accountId: string,
	tunnelId: string,
) => cfFetch<CloudflareTunnel>(config, tunnelPath(accountId, tunnelId));

export const getCloudflareZoneAccountId = async (
	config: CloudflareConfig,
	zoneId: string,
) =>
	(
		await cfFetch<{ account: { id: string } }>(
			config,
			`/zones/${encodeURIComponent(zoneId)}`,
		)
	).account.id;

const updateIngress = (
	config: CloudflareConfig,
	accountId: string,
	tunnelId: string,
	change: (ingress: IngressRule[] | undefined) => IngressRule[] | null,
) =>
	withTunnelLock(tunnelId, async () => {
		const path = `${tunnelPath(accountId, tunnelId)}/configurations`;
		const current = await cfFetch<TunnelConfiguration>(config, path);
		const ingress = change(current.config?.ingress);
		if (!ingress) return false;
		await cfFetch(config, path, {
			method: "PUT",
			body: JSON.stringify({ config: { ...(current.config ?? {}), ingress } }),
		});
		return true;
	});

/** Adds `hostname → service`; false when the exact route already existed. */
export const addCloudflareTunnelRoute = (
	config: CloudflareConfig,
	accountId: string,
	tunnelId: string,
	hostname: string,
	service: string,
) =>
	updateIngress(config, accountId, tunnelId, (ingress) => {
		const result = addRoute(ingress, hostname, service);
		if (result.status === "conflict") {
			throw conflictError(hostname, result.services);
		}
		return result.status === "added" ? result.ingress : null;
	});

export const removeCloudflareTunnelRoute = (
	config: CloudflareConfig,
	accountId: string,
	tunnelId: string,
	hostname: string,
	service: string,
) =>
	updateIngress(config, accountId, tunnelId, (ingress) =>
		removeRoute(ingress, hostname, service),
	);

export const listCloudflareAccounts = (config: CloudflareConfig) =>
	cfFetch<{ id: string; name: string }[]>(config, "/accounts?per_page=50");

/** The permissions of a Cloudflare API token used by Dokploy, as the dashboard names them. */
export const CLOUDFLARE_PERMISSIONS = {
	zoneRead: "Zone › Zone › Read",
	dnsEdit: "Zone › DNS › Edit",
	tunnelEdit: "Account › Cloudflare Tunnel › Edit",
} as const;

/** Why Cloudflare refused a request that needs `permission`, and how to fix it. */
export const explainCloudflareError = (error: unknown, permission: string) => {
	if (!(error instanceof CloudflareApiError)) {
		return error instanceof Error ? error.message : String(error);
	}
	// Cloudflare answers code 9109 both for a token used from an IP outside
	// its filter and for an invalid token: only the message tells them apart.
	if (/from location/i.test(error.detail)) {
		return `Cloudflare refuses this API token from this server's IP address (${error.detail}). Add the server's public IP to the token's "Client IP Address Filtering", or remove the filter.`;
	}
	if (
		/invalid (api|access) token/i.test(error.detail) ||
		error.errors.some((e) => e.code === 1000)
	) {
		return "Cloudflare rejects this API token: it is invalid, expired or was rolled. Paste the current token in Settings › DNS.";
	}
	if (error.status === 403 || error.errors.some((e) => e.code === 10000)) {
		return `The API token lacks the "${permission}" permission: add it to the token in Cloudflare (My Profile › API Tokens › Edit).`;
	}
	return error.message;
};

/**
 * The accounts of the zones the token reaches, plus those it lists: a token
 * without account-level read permissions lists no account at all.
 */
const reachableAccounts = async (config: CloudflareConfig) => {
	const [zones, accounts] = await Promise.allSettled([
		cfFetch<{ account: { id: string } }[]>(config, "/zones?per_page=50"),
		listCloudflareAccounts(config),
	]);
	const ids = new Set<string>();
	if (zones.status === "fulfilled") {
		for (const zone of zones.value) ids.add(zone.account.id);
	}
	if (accounts.status === "fulfilled") {
		for (const account of accounts.value) ids.add(account.id);
	}
	return {
		ids: [...ids],
		error: zones.status === "rejected" ? zones.reason : null,
	};
};

export type TunnelAccess =
	| { ok: true; accountIds: string[] }
	| { ok: false; reason: string };

const A_RECORD_FALLBACK =
	"Until then, domains on a server with a Cloudflare Tunnel get an A record instead of a tunnel route.";

/**
 * Whether the token may read and edit tunnels, needed for tunnel routes: in
 * `accountId` when the tunnel's account is known, else in every account the
 * token reaches. `accountIds` are the accounts where it may.
 */
export const checkCloudflareTunnelAccess = async (
	config: CloudflareConfig,
	accountId?: string,
): Promise<TunnelAccess> => {
	let accountIds = accountId ? [accountId] : [];
	if (!accountId) {
		const reachable = await reachableAccounts(config);
		accountIds = reachable.ids;
		if (accountIds.length === 0) {
			const reason = reachable.error
				? explainCloudflareError(
						reachable.error,
						CLOUDFLARE_PERMISSIONS.zoneRead,
					)
				: `The API token reaches no Cloudflare account: add the "${CLOUDFLARE_PERMISSIONS.tunnelEdit}" permission on the account of your tunnel.`;
			return { ok: false, reason: `${reason} ${A_RECORD_FALLBACK}` };
		}
	}
	const results = await Promise.allSettled(
		accountIds.map((id) =>
			cfFetch(
				config,
				`/accounts/${encodeURIComponent(id)}/cfd_tunnel?per_page=1&is_deleted=false`,
			),
		),
	);
	const allowed = accountIds.filter(
		(_, index) => results[index]?.status === "fulfilled",
	);
	if (allowed.length > 0) return { ok: true, accountIds: allowed };
	const failure = results.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	return {
		ok: false,
		reason: `${explainCloudflareError(failure?.reason, CLOUDFLARE_PERMISSIONS.tunnelEdit)} ${A_RECORD_FALLBACK}`,
	};
};
