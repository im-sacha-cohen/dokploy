import {
	addRoute,
	conflictError,
	type IngressRule,
	removeRoute,
} from "../../smart-deploy/tunnel/ingress";
import { withTunnelLock } from "../../smart-deploy/tunnel/lock";
import { type CloudflareConfig, cfFetch } from "./cloudflare";

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

export type TunnelAccess = { ok: true } | { ok: false; reason: string };

/** Whether the token may read and edit tunnels, needed for tunnel routes. */
export const checkCloudflareTunnelAccess = async (
	config: CloudflareConfig,
): Promise<TunnelAccess> => {
	const missing =
		'The token lacks the "Account › Cloudflare Tunnel › Edit" permission: domains on a server with a Cloudflare Tunnel will get an A record instead of a tunnel route.';
	let accounts: { id: string }[];
	try {
		accounts = await listCloudflareAccounts(config);
	} catch {
		return { ok: false, reason: missing };
	}
	const results = await Promise.allSettled(
		accounts.map((account) =>
			cfFetch(
				config,
				`/accounts/${encodeURIComponent(account.id)}/cfd_tunnel?per_page=1&is_deleted=false`,
			),
		),
	);
	return results.some((result) => result.status === "fulfilled")
		? { ok: true }
		: { ok: false, reason: missing };
};
