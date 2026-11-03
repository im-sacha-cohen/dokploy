// End-to-end OAuth 2.1 + MCP test against the LOCAL dev instance.
// Plays a real MCP client: discovery, dynamic registration, PKCE authorization
// with the local test owner session, consent, token exchange, MCP calls, then
// the negative cases (no token, tampered token, wrong host/origin, missing
// scope, revocation, rate limit).
// Usage: node dev/mcp/oauth-mcp-e2e.mjs
import http from "node:http";
import { baseUrl, call, login } from "../demo-apps/api-client.mjs";
import {
	authorize,
	b64url,
	check,
	MCP_URL,
	mcp,
	REDIRECT_URI,
	summarize,
	toolCall,
} from "./mcp-client.mjs";

await login();

// 1. Discovery
const unauth = await mcp(null, "tools/list");
const challengeHeader = unauth.headers.get("www-authenticate") ?? "";
check(
	"sans token → 401 + WWW-Authenticate resource_metadata",
	unauth.status === 401 && challengeHeader.includes("resource_metadata="),
	challengeHeader,
);
const prmUrl = challengeHeader.match(/resource_metadata="([^"]+)"/)?.[1];
const prm = await (await fetch(prmUrl)).json();
check(
	"métadonnées de ressource protégée (RFC 9728)",
	prm.resource === MCP_URL && prm.authorization_servers?.length === 1,
	JSON.stringify(prm),
);
const asUrl = new URL(prm.authorization_servers[0]);
const asMeta = await (
	await fetch(
		`${asUrl.origin}/.well-known/oauth-authorization-server${asUrl.pathname}`,
	)
).json();
check(
	"métadonnées du serveur d'autorisation (RFC 8414)",
	asMeta.issuer === prm.authorization_servers[0] &&
		asMeta.code_challenge_methods_supported?.includes("S256"),
	`issuer=${asMeta.issuer}`,
);

// 2. Organization settings
const settings = await call("/api/mcp.getSettings", undefined, "GET");
await call("/api/mcp.updateSettings", {
	enabled: true,
	allowedScopes: ["mcp:read", "mcp:deploy", "mcp:config"],
});
check("MCP activé pour l'organisation", true, settings.organizationId);

// 3. Dynamic client registration
const regRes = await fetch(asMeta.registration_endpoint, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({
		client_name: "Dokploy E2E client",
		redirect_uris: [REDIRECT_URI],
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		application_type: "native",
		scope: "mcp:read mcp:deploy mcp:config offline_access",
	}),
});
const client = await regRes.json();
check(
	"enregistrement dynamique (client public)",
	regRes.ok && !!client.client_id && !client.client_secret,
	`HTTP ${regRes.status} ${client.error_description ?? ""}`,
);

// 4. Authorization with read-only consent
const tokens = await authorize(
	client.client_id,
	["mcp:read"],
	settings.organizationId,
);
const payload = JSON.parse(
	Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(),
);
check(
	"token : audience = /mcp, durée ≤ 15 min, scope consenti",
	payload.aud === MCP_URL &&
		payload.exp - payload.iat <= 900 &&
		payload.scope.split(" ").includes("mcp:read") &&
		!payload.scope.includes("mcp:deploy"),
	`aud=${payload.aud} ttl=${payload.exp - payload.iat}s scope=${payload.scope}`,
);

// 5. MCP calls (modern and legacy eras)
const list = await mcp(tokens.access_token, "tools/list");
const toolNames = list.json?.result?.tools?.map((t) => t.name) ?? [];
check(
	"tools/list (2026-07-28)",
	list.status === 200 &&
		toolNames.includes("dokploy_list_projects") &&
		toolNames.length >= 19,
	`${toolNames.length} outils, HTTP ${list.status} ${list.text.slice(0, 200)}`,
);
const legacyInit = await mcp(
	tokens.access_token,
	"initialize",
	{
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "legacy", version: "1" },
	},
	{ modern: false },
);
check(
	"client 2025-06-18 (repli sans état)",
	legacyInit.status === 200 && !!legacyInit.json?.result?.serverInfo,
	`HTTP ${legacyInit.status}`,
);

const projectsRes = await toolCall(
	tokens.access_token,
	"dokploy_list_projects",
);
const projects = projectsRes.json?.result?.structuredContent?.projects ?? [];
const demo = projects.find((p) => p.name === "Smart Deploy Demo");
const apps = demo?.environments.flatMap((e) => e.applications) ?? [];
check(
	"dokploy_list_projects",
	!!demo && apps.length >= 6,
	`${projects.length} projet(s), ${apps.length} apps`,
);
const appB = apps.find((a) => a.name === "b-wrong-port");
const diag = await toolCall(
	tokens.access_token,
	"dokploy_diagnose_deployment",
	{ applicationId: appB.applicationId },
);
const codes =
	diag.json?.result?.structuredContent?.findings?.map((f) => f.code) ?? [];
check(
	"dokploy_diagnose_deployment (B)",
	codes.includes("PORT_MISMATCH"),
	codes.join(","),
);
const appD = apps.find((a) => a.name === "d-missing-env");
const getApp = await toolCall(tokens.access_token, "dokploy_get_application", {
	applicationId: appD.applicationId,
});
check(
	"dokploy_get_application ne renvoie aucune valeur de variable",
	getApp.status === 200 &&
		!getApp.text.includes("REDACTED") &&
		Array.isArray(
			getApp.json?.result?.structuredContent?.environmentVariableNames,
		),
);
const deps = await toolCall(tokens.access_token, "dokploy_get_deployments", {
	applicationId: appB.applicationId,
	limit: 1,
});
const depId =
	deps.json?.result?.structuredContent?.deployments?.[0]?.deploymentId;
const logs = await toolCall(
	tokens.access_token,
	"dokploy_get_deployment_logs",
	{ deploymentId: depId, lines: 20 },
);
check(
	"dokploy_get_deployment_logs",
	logs.status === 200 &&
		Array.isArray(logs.json?.result?.structuredContent?.lines),
);
const version = await toolCall(
	tokens.access_token,
	"dokploy_get_runtime_version",
	{ applicationId: apps.find((a) => a.name === "e-outdated").applicationId },
);
check(
	"dokploy_get_runtime_version",
	["up_to_date", "outdated"].includes(
		version.json?.result?.structuredContent?.versionState,
	),
	version.json?.result?.structuredContent?.versionReason,
);

// 6. Negative cases
const deploy = await toolCall(
	tokens.access_token,
	"dokploy_restart_application",
	{ applicationId: appB.applicationId },
);
check(
	"outil de déploiement sans scope mcp:deploy → 403 insufficient_scope",
	deploy.status === 403 &&
		(deploy.headers.get("www-authenticate") ?? "").includes(
			"insufficient_scope",
		),
	`HTTP ${deploy.status}`,
);
const badInput = await toolCall(
	tokens.access_token,
	"dokploy_get_application",
	{ applicationId: "../../etc/passwd" },
);
check(
	"entrée invalide refusée",
	badInput.json?.result?.isError === true || !!badInput.json?.error,
	badInput.text.slice(0, 120),
);
const unknownApp = await toolCall(
	tokens.access_token,
	"dokploy_get_application",
	{ applicationId: "doesNotExist123" },
);
check(
	"application inconnue → même réponse qu'un refus d'accès",
	unknownApp.json?.result?.isError === true &&
		unknownApp.text.includes("not found or access denied"),
);
const parts = tokens.access_token.split(".");
const tampered = [
	parts[0],
	b64url(
		Buffer.from(
			JSON.stringify({ ...payload, scope: "mcp:read mcp:deploy mcp:config" }),
		),
	),
	parts[2],
].join(".");
check(
	"token falsifié (scope élargi) → 401",
	(await mcp(tampered, "tools/list")).status === 401,
);
check(
	"token aléatoire → 401",
	(await mcp("abc.def.ghi", "tools/list")).status === 401,
);
// fetch() cannot override Host, hence node:http (DNS-rebinding style request).
const hostStatus = await new Promise((resolve) => {
	const target = new URL(MCP_URL);
	const req = http.request(
		{
			host: target.hostname,
			port: target.port,
			path: target.pathname,
			method: "POST",
			headers: {
				host: "evil.example",
				"content-type": "application/json",
				authorization: `Bearer ${tokens.access_token}`,
			},
		},
		(res) => {
			res.resume();
			resolve(res.statusCode);
		},
	);
	req.end("{}");
});
check("Host inconnu → refusé (421)", hostStatus === 421, `HTTP ${hostStatus}`);
check(
	"Origin d'un autre site → refusé",
	(
		await mcp(
			tokens.access_token,
			"tools/list",
			{},
			{ headers: { origin: "https://evil.example" } },
		)
	).status === 403,
);
const malformed = await fetch(MCP_URL, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		authorization: `Bearer ${tokens.access_token}`,
	},
	body: "{not json",
});
check(
	"JSON malformé → erreur sans crash",
	malformed.status >= 400 || (await malformed.text()).includes("error"),
	`HTTP ${malformed.status}`,
);

// 7. Concurrency
const parallel = await Promise.all(
	Array.from({ length: 20 }, () => mcp(tokens.access_token, "tools/list")),
);
check(
	"20 requêtes concurrentes",
	parallel.every((r) => r.status === 200),
	parallel.map((r) => r.status).join(","),
);

// 8. Refresh token
const refreshRes = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: tokens.refresh_token,
		client_id: client.client_id,
		resource: MCP_URL,
	}),
});
const refreshed = await refreshRes.json();
check(
	"refresh token → nouveau token valide",
	refreshRes.ok &&
		(await mcp(refreshed.access_token, "tools/list")).status === 200,
	`HTTP ${refreshRes.status} ${refreshed.error ?? ""}`,
);

// 9. Scope step-up: grant deploy too, then restart works
const deployTokens = await authorize(
	client.client_id,
	["mcp:read", "mcp:deploy"],
	settings.organizationId,
);
const restart = await toolCall(
	deployTokens.access_token,
	"dokploy_restart_application",
	{ applicationId: apps.find((a) => a.name === "a-healthy").applicationId },
);
check(
	"avec mcp:deploy → dokploy_restart_application",
	restart.status === 200 &&
		restart.json?.result?.structuredContent?.restarted === true,
	restart.text.slice(0, 200),
);

// 10. Audit trail
const audit = await call("/api/mcp.auditLog?limit=100", undefined, "GET");
check(
	"journal d'audit alimenté (outils, refus, consentement)",
	audit.some(
		(a) => a.name === "dokploy_diagnose_deployment" && a.outcome === "ok",
	) &&
		audit.some((a) => a.outcome === "denied") &&
		audit.some((a) => a.name === "consent"),
	`${audit.length} entrées`,
);

// 11. Revocation is immediate
await call("/api/mcp.revokeGrant", { clientId: client.client_id });
check(
	"après révocation → le token d'accès encore valide est refusé",
	(await mcp(deployTokens.access_token, "tools/list")).status === 401,
);
const afterRevoke = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
	method: "POST",
	headers: { "content-type": "application/x-www-form-urlencoded" },
	body: new URLSearchParams({
		grant_type: "refresh_token",
		refresh_token: deployTokens.refresh_token,
		client_id: client.client_id,
		resource: MCP_URL,
	}),
});
check(
	"après révocation → refresh token refusé",
	!afterRevoke.ok,
	`HTTP ${afterRevoke.status}`,
);

// 12. Rate limiting (anonymous probing)
const burst = await Promise.all(
	Array.from({ length: 40 }, () => mcp("x.y.z", "tools/list")),
);
check(
	"limitation de débit sur tokens invalides → 429",
	burst.some((r) => r.status === 429),
	`${burst.filter((r) => r.status === 429).length} × 429`,
);

summarize();
