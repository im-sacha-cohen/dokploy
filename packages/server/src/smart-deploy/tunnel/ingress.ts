// Edits the ingress rules of a tunnel. Cloudflare applies the first rule that
// matches, and both the API and config.yml take the whole list at once, so a
// route is added or removed by reading the list, changing it and writing it
// back.
import { normalizeHost } from "../dns/names";

export interface IngressRule {
	hostname?: string;
	path?: string;
	service: string;
	originRequest?: Record<string, unknown>;
	[key: string]: unknown;
}

export const CATCH_ALL: IngressRule = { service: "http_status:404" };

export class TunnelRouteConflictError extends Error {}

const sameHost = (rule: IngressRule, hostname: string) =>
	!!rule.hostname && normalizeHost(rule.hostname) === normalizeHost(hostname);

export const isCatchAll = (rule: IngressRule) => !rule.hostname && !rule.path;

/** The plain `hostname → service` rule Dokploy adds. */
export const isRoute = (rule: IngressRule, hostname: string, service: string) =>
	sameHost(rule, hostname) && !rule.path && rule.service === service;

export type AddRouteResult =
	| { status: "added"; route: IngressRule; ingress: IngressRule[] }
	| { status: "exists" }
	| { status: "conflict"; services: string[] };

/**
 * Puts the route first, so that an existing wildcard such as `*.example.com`
 * does not shadow it. A hostname already routed elsewhere, or with path
 * rules, is left alone.
 */
export const addRoute = (
	ingress: IngressRule[] | undefined,
	hostname: string,
	service: string,
): AddRouteResult => {
	const rules = ingress ?? [];
	const existing = rules.filter((rule) => sameHost(rule, hostname));
	if (existing.length > 0) {
		return existing.length === 1 &&
			isRoute(existing[0] as IngressRule, hostname, service)
			? { status: "exists" }
			: { status: "conflict", services: existing.map((r) => r.service) };
	}
	const route: IngressRule = { hostname: normalizeHost(hostname), service };
	return {
		status: "added",
		route,
		ingress: [route, ...rules, ...(rules.some(isCatchAll) ? [] : [CATCH_ALL])],
	};
};

export const conflictError = (hostname: string, services: string[]) =>
	new TunnelRouteConflictError(
		`${hostname} is already routed by this tunnel (${services.join(", ")})`,
	);

/** Removes the rule Dokploy added for `hostname`, if it is still there. */
export const removeRoute = (
	ingress: IngressRule[] | undefined,
	hostname: string,
	service: string,
) => {
	const rules = ingress ?? [];
	const kept = rules.filter((rule) => !isRoute(rule, hostname, service));
	return kept.length === rules.length ? null : kept;
};
