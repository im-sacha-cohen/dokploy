export const MCP_SCOPES = [
	"mcp:read",
	"mcp:deploy",
	"mcp:config",
	"mcp:env",
	"mcp:manage",
	"mcp:exec",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Scopes an organization allows until an admin changes it. The broader ones
 * (environment variables, create/delete, commands) must be opted into.
 */
export const DEFAULT_ALLOWED_SCOPES: readonly McpScope[] = [
	"mcp:read",
	"mcp:deploy",
	"mcp:config",
];

export const MCP_SCOPE_DESCRIPTIONS: Record<McpScope, string> = {
	"mcp:read":
		"Read projects, services, deployments, logs (redacted), health and diagnostics",
	"mcp:deploy":
		"Deploy, rebuild, restart, start and roll back services you are allowed to deploy",
	"mcp:config":
		"Change service settings, source, build type, domains and healthcheck",
	"mcp:env":
		"Read environment variables (secret values masked) and set or remove variables",
	"mcp:manage":
		"Create and delete projects, environments and services, stop services, run and restore backups (destructive actions ask for confirmation)",
	"mcp:exec":
		"Run a command inside a service's container, after a human confirms each command",
};

export const OAUTH_SCOPES = [...MCP_SCOPES, "offline_access"] as const;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const DEV_RESOURCE = "http://localhost:3000/mcp";

const globalForMcp = globalThis as unknown as {
	__dokployPanelMcpResource?: string | null;
};

/**
 * MCP URL derived from the panel domain saved in Settings > Web Server, so
 * the MCP works without DOKPLOY_MCP_RESOURCE_URL. HTTPS only: OAuth issuers
 * must be https, and a plain-http domain usually sits behind a proxy whose
 * public scheme Dokploy cannot know.
 */
export const panelMcpResource = (
	settings: { host?: string | null; https?: boolean | null } | null | undefined,
): string | null => {
	const host = settings?.host?.trim().toLowerCase().replace(/\/+$/, "");
	if (!host || !settings?.https) return null;
	try {
		const url = new URL(`https://${host}/mcp`);
		return url.host === host ? url.toString() : null;
	} catch {
		return null;
	}
};

/** Kept on globalThis: this package is bundled twice (server.ts and Next.js). */
export const getPanelMcpResource = () =>
	globalForMcp.__dokployPanelMcpResource ?? null;

export const setPanelMcpResource = (resource: string | null) => {
	globalForMcp.__dokployPanelMcpResource = resource;
};

const configuredResourceUrls = () =>
	(process.env.DOKPLOY_MCP_RESOURCE_URL ?? "")
		.split(",")
		.map((u) => u.trim().replace(/\/+$/, ""))
		.filter(Boolean);

export const isMcpResourceFromEnv = () => configuredResourceUrls().length > 0;

/**
 * Public URL of the MCP endpoint, used as the OAuth audience (RFC 8707):
 * DOKPLOY_MCP_RESOURCE_URL, else the panel domain. Never guessed from
 * request headers: a spoofed Host header would choose the audience.
 */
export const getMcpResourceUrls = (): string[] => {
	const configured = configuredResourceUrls();
	if (configured.length > 0) return configured;
	const panel = getPanelMcpResource();
	if (panel) return [panel];
	return process.env.NODE_ENV === "production" ? [] : [DEV_RESOURCE];
};

/** Issuer of OAuth tokens: better-auth served under /api/auth on the same origin. */
export const getMcpIssuer = (resourceUrl: string) =>
	`${new URL(resourceUrl).origin}/api/auth`;
