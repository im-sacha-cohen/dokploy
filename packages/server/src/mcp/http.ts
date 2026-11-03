import {
	createMcpHandler,
	getOAuthProtectedResourceMetadataUrl,
	type McpHttpHandler,
	originValidationResponse,
	requireBearerAuth,
	validateHostHeader,
} from "@modelcontextprotocol/server";
import { auth } from "../lib/auth";
import { writeMcpAudit } from "./audit";
import { getMcpIssuer, getMcpResourceUrls, MCP_SCOPES } from "./config";
import { touchMcpGrant } from "./grants";
import { anonymousLimiter, requestLimiter } from "./rate-limit";
import { createMcpTokenVerifier, principalOf } from "./token";
import type { McpActionDeps } from "./tool-kit";
import { createDokployMcpServer } from "./tools";

const MAX_BODY_BYTES = 1024 * 1024;
const GRANT_TOUCH_INTERVAL_MS = 60_000;

let mcpHandler: McpHttpHandler | null = null;
let actionDeps: McpActionDeps | null = null;
const lastTouched = new Map<string, number>();

/** Wires the deployment queue (owned by the Next app) into the MCP tools. */
export const configureMcp = (deps: McpActionDeps) => {
	actionDeps = deps;
};

const getHandler = () => {
	if (!actionDeps) throw new Error("MCP actions are not configured");
	const deps = actionDeps;
	mcpHandler ??= createMcpHandler(
		(context) => createDokployMcpServer(principalOf(context.authInfo), deps),
		{
			legacy: "stateless",
			maxRequestBodySize: MAX_BODY_BYTES,
			onerror: (error) => console.error("[mcp]", error.message),
		},
	);
	return mcpHandler;
};

const jsonResponse = (
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			...headers,
		},
	});

/** The configured resource whose hostname matches the request, if any. */
export const resolveResource = (request: Request): string | null => {
	const host = request.headers.get("host");
	for (const resource of getMcpResourceUrls()) {
		const check = validateHostHeader(host, [new URL(resource).hostname]);
		if (check.ok) return resource;
	}
	return null;
};

const clientIp = (request: Request) =>
	request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
	request.headers.get("x-real-ip") ||
	"unknown";

export const handleMcpRequest = async (request: Request): Promise<Response> => {
	if (getMcpResourceUrls().length === 0) {
		return jsonResponse(503, {
			error: "mcp_not_configured",
			error_description:
				"Set DOKPLOY_MCP_RESOURCE_URL to the public URL of /mcp to enable the MCP server.",
		});
	}
	const resource = resolveResource(request);
	if (!resource) {
		return jsonResponse(421, {
			error: "invalid_host",
			error_description: "Unknown host for this MCP server",
		});
	}
	// Browsers send Origin: refuse cross-site pages (DNS rebinding, CSRF).
	const originRejected = originValidationResponse(request, [
		new URL(resource).origin,
	]);
	if (originRejected) return originRejected;

	const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
		new URL(resource),
	);
	const gate = requireBearerAuth({
		verifier: createMcpTokenVerifier(resource),
		expectedResource: new URL(resource),
		resourceMetadataUrl,
	});
	const authResult = await gate(request);
	if (authResult instanceof Response) {
		const ip = clientIp(request);
		const wait = anonymousLimiter.hit(ip);
		if (request.headers.get("authorization")) {
			await writeMcpAudit({
				kind: "auth",
				name: "bearer",
				outcome: wait > 0 ? "rate_limited" : "invalid",
				detail: `rejected token from ${ip}`,
			});
		}
		if (wait > 0) {
			return jsonResponse(
				429,
				{ error: "rate_limited" },
				{ "retry-after": String(wait) },
			);
		}
		return authResult;
	}

	const principal = principalOf(authResult);
	const wait = requestLimiter.hit(`${principal.userId}:${principal.clientId}`);
	if (wait > 0) {
		await writeMcpAudit({
			principal,
			kind: "auth",
			name: "request",
			outcome: "rate_limited",
		});
		return jsonResponse(
			429,
			{ error: "rate_limited" },
			{ "retry-after": String(wait) },
		);
	}

	const now = Date.now();
	if (
		now - (lastTouched.get(principal.grantId) ?? 0) >
		GRANT_TOUCH_INTERVAL_MS
	) {
		lastTouched.set(principal.grantId, now);
		void touchMcpGrant(principal.grantId).catch(() => undefined);
	}

	return getHandler().fetch(request, { authInfo: authResult });
};

/** RFC 9728 Protected Resource Metadata for `/mcp`. */
export const handleProtectedResourceMetadata = (request: Request): Response => {
	const resource = resolveResource(request);
	if (!resource) return jsonResponse(404, { error: "not_found" });
	return jsonResponse(
		200,
		{
			resource,
			authorization_servers: [getMcpIssuer(resource)],
			scopes_supported: [...MCP_SCOPES],
			bearer_methods_supported: ["header"],
			resource_name: "Dokploy",
		},
		{ "cache-control": "public, max-age=300" },
	);
};

/**
 * Called in-process, better-auth has no request URL and returns endpoints
 * relative to its base path; RFC 8414 requires absolute URLs. They are
 * resolved against the configured issuer, never against the request Host.
 */
export const absolutizeEndpoints = (
	metadata: Record<string, unknown>,
	issuer: string,
): Record<string, unknown> =>
	Object.fromEntries(
		Object.entries(metadata).map(([key, value]) =>
			(key.endsWith("_endpoint") || key === "jwks_uri") &&
			typeof value === "string" &&
			value.startsWith("/")
				? [key, `${issuer}${value}`]
				: [key, value],
		),
	);

/** RFC 8414 Authorization Server Metadata, also served at the origin root for older clients. */
export const handleAuthorizationServerMetadata = async (
	request: Request,
): Promise<Response> => {
	const resource = resolveResource(request);
	if (!resource) return jsonResponse(404, { error: "not_found" });
	const issuer = getMcpIssuer(resource);
	const metadata = (await auth.getOAuthServerConfig({
		headers: request.headers,
	})) as unknown as Record<string, unknown>;
	return jsonResponse(
		200,
		{ ...absolutizeEndpoints(metadata, issuer), issuer },
		{ "cache-control": "public, max-age=300" },
	);
};
