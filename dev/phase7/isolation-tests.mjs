// Permission and isolation tests on the LOCAL dev instance, as the owner and
// as the restricted member prepared by setup-isolation.mjs.
// Usage: node dev/phase7/setup-isolation.mjs && node dev/phase7/isolation-tests.mjs
import { createHash, randomBytes } from "node:crypto";
import { baseUrl, createSession, devEnv } from "../demo-apps/api-client.mjs";

const MCP_URL = `${baseUrl}/mcp`;
const REDIRECT_URI = "http://127.0.0.1:8976/callback";
const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const denied = async (promise) => {
	try {
		await promise;
		return false;
	} catch (error) {
		return [401, 403, 404, 412].includes(error.status);
	}
};

let rpcId = 0;
const mcp = async (token, method, params = {}) => {
	const res = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-protocol-version": "2026-07-28",
			"mcp-method": method,
			...(method === "tools/call" ? { "mcp-name": params.name } : {}),
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: ++rpcId,
			method,
			params: {
				...params,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": { name: "isolation-tests", version: "1" },
					"io.modelcontextprotocol/clientCapabilities": {},
				},
			},
		}),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: res.status, headers: res.headers, json, text };
};
const tool = (token, name, args) => mcp(token, "tools/call", { name, arguments: args });
const toolDenied = (r) => r.json?.result?.isError === true && r.text.includes("not found or access denied");

const registerClient = async (name) =>
	(
		await fetch(`${baseUrl}/api/auth/oauth2/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", application_type: "native", scope: "mcp:read mcp:deploy mcp:config offline_access" }),
		})
	).json();

const authorize = async (session, clientId, scopes, organizationId) => {
	const verifier = randomBytes(32).toString("base64url");
	const url = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: scopes.join(" "),
		state: "x",
		code_challenge: createHash("sha256").update(verifier).digest("base64url"),
		code_challenge_method: "S256",
		resource: MCP_URL,
	}).toString();
	const res = await session.rawGet(url.toString());
	const consentUrl = new URL(res.headers.get("location") ?? (await res.json()).url, baseUrl);
	await session.call("/api/mcp.recordGrant", { clientId, organizationId, scopes });
	const consent = await session.call("/api/auth/oauth2/consent", { accept: true, scope: scopes.join(" "), oauth_query: consentUrl.search.slice(1) });
	const code = new URL(consent.url).searchParams.get("code");
	const tokenRes = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier, resource: MCP_URL }),
	});
	return (await tokenRes.json()).access_token;
};

const owner = createSession();
await owner.signIn(devEnv.DEMO_ADMIN_EMAIL, devEnv.DEMO_ADMIN_PASSWORD);
const member = createSession();
await member.signIn(devEnv.DEMO_MEMBER_EMAIL, devEnv.DEMO_MEMBER_PASSWORD);

const orgA = (await owner.call("/api/auth/get-session", undefined, "GET")).session.activeOrganizationId;
const orgB = (await owner.call("/api/organization.all", undefined, "GET")).find((o) => o.name === "Isolation Org B").id;
const ownerProjects = await owner.call("/api/project.all", undefined, "GET");
const demoApps = ownerProjects.find((p) => p.name === "Smart Deploy Demo").environments.flatMap((e) => e.applications);
const appId = (name) => demoApps.find((a) => a.name === name).applicationId;
const restrictedApp = ownerProjects.find((p) => p.name === "Restricted project").environments[0].applications[0].applicationId;
await owner.call("/api/auth/organization/set-active", { organizationId: orgB });
const orgBApp = (await owner.call("/api/project.all", undefined, "GET")).find((p) => p.name === "Org B project").environments[0].applications[0].applicationId;
await owner.call("/api/mcp.updateSettings", { enabled: false, allowedScopes: ["mcp:read"] });
await owner.call("/api/auth/organization/set-active", { organizationId: orgA });
await owner.call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ["mcp:read", "mcp:deploy", "mcp:config"] });

console.log("— Membre restreint, API de l'interface (tRPC/REST)");
const memberProjects = await member.call("/api/project.all", undefined, "GET");
const visible = memberProjects.flatMap((p) => p.environments.flatMap((e) => e.applications.map((a) => a.name))).sort();
check("project.all : seulement les apps accordées (a, b, e)", JSON.stringify(visible) === JSON.stringify(["a-healthy", "b-wrong-port", "e-outdated"]), visible.join(","));
const q = (id) => `/api/smartDeploy.diagnoseApplication?${new URLSearchParams({ applicationId: id, probes: "false" })}`;
check("diagnostic d'une app d'un projet non accordé → refusé", await denied(member.call(q(restrictedApp), undefined, "GET")));
check("diagnostic d'une app d'une autre organisation → refusé", await denied(member.call(q(orgBApp), undefined, "GET")));
check("diagnostic d'une app non accordée du même projet (C) → refusé", await denied(member.call(q(appId("c-crash-loop")), undefined, "GET")));
check("diagnostic d'une app accordée (A) → autorisé", !(await denied(member.call(q(appId("a-healthy")), undefined, "GET"))));
check("restart d'une app non accordée (C) → refusé", await denied(member.call("/api/smartDeploy.restartApplication", { applicationId: appId("c-crash-loop") })));
check("applyFix sur une app non accordée → refusé", await denied(member.call("/api/smartDeploy.applyFix", { applicationId: appId("c-crash-loop"), action: { kind: "deploy_latest" } })));
check("membre : modifier les réglages MCP → refusé", await denied(member.call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ["mcp:read"] })));

console.log("— Membre restreint, via MCP");
const memberClient = await registerClient("Member client");
const memberToken = await authorize(member, memberClient.client_id, ["mcp:read", "mcp:deploy"], orgA);
const mcpProjects = (await tool(memberToken, "dokploy_list_projects", {})).json?.result?.structuredContent?.projects ?? [];
const mcpVisible = mcpProjects.flatMap((p) => p.environments.flatMap((e) => e.applications.map((a) => a.name))).sort();
check("dokploy_list_projects : mêmes apps que l'interface", JSON.stringify(mcpVisible) === JSON.stringify(visible), mcpVisible.join(","));
check("MCP : app d'un projet non accordé → refusée", toolDenied(await tool(memberToken, "dokploy_get_application", { applicationId: restrictedApp })));
check("MCP : app d'une autre organisation → refusée", toolDenied(await tool(memberToken, "dokploy_get_application", { applicationId: orgBApp })));
check("MCP : app non accordée du même projet → refusée", toolDenied(await tool(memberToken, "dokploy_diagnose_deployment", { applicationId: appId("c-crash-loop") })));
check("MCP : restart d'une app non accordée → refusé", toolDenied(await tool(memberToken, "dokploy_restart_application", { applicationId: appId("c-crash-loop") })));
const okApp = await tool(memberToken, "dokploy_get_application", { applicationId: appId("a-healthy") });
check("MCP : app accordée → autorisée", okApp.status === 200 && !okApp.json?.result?.isError);
const memberServers = await tool(memberToken, "dokploy_list_servers", {});
check("MCP : liste des serveurs limitée aux serveurs accordés (aucun)", (memberServers.json?.result?.structuredContent?.servers ?? []).length === 0 || memberServers.json?.result?.isError === true, memberServers.text.slice(0, 120));

console.log("— Propriétaire : isolation par organisation");
const ownerClient = await registerClient("Owner client");
const ownerToken = await authorize(owner, ownerClient.client_id, ["mcp:read"], orgA);
check("token org A : app de l'org B refusée (même pour le propriétaire)", toolDenied(await tool(ownerToken, "dokploy_get_application", { applicationId: orgBApp })));
check("org B (MCP désactivé) : grant refusé", await denied(owner.call("/api/mcp.recordGrant", { clientId: ownerClient.client_id, organizationId: orgB, scopes: ["mcp:read"] })));
check("grant pour une organisation dont on n'est pas membre → refusé", await denied(member.call("/api/mcp.recordGrant", { clientId: memberClient.client_id, organizationId: orgB, scopes: ["mcp:read"] })));

console.log("— Restrictions appliquées immédiatement");
await owner.call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ["mcp:read"] });
const narrowed = await tool(memberToken, "dokploy_restart_application", { applicationId: appId("a-healthy") });
check("scope retiré par l'organisation → 403 insufficient_scope sur un token existant", narrowed.status === 403, `HTTP ${narrowed.status}`);
await owner.call("/api/mcp.updateSettings", { enabled: false, allowedScopes: ["mcp:read"] });
check("intégration désactivée → token existant refusé (401)", (await mcp(memberToken, "tools/list")).status === 401);
await owner.call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ["mcp:read", "mcp:deploy", "mcp:config"] });
check("réactivée → token de nouveau accepté", (await mcp(memberToken, "tools/list")).status === 200);

console.log("— Visibilité des réglages");
const memberGrants = await member.call("/api/mcp.listGrants", undefined, "GET");
check("membre : ne voit que ses propres clients", memberGrants.length > 0 && memberGrants.every((g) => g.isOwn));
const memberAudit = await member.call("/api/mcp.auditLog?limit=200", undefined, "GET");
check("membre : audit limité à ses propres entrées", memberAudit.every((e) => e.userId === memberGrants[0]?.user?.id));
const ownerGrants = await owner.call("/api/mcp.listGrants", undefined, "GET");
check("propriétaire : voit les clients des membres", ownerGrants.some((g) => !g.isOwn));
const ownerUserId = ownerGrants.find((g) => g.isOwn)?.user?.id;
check("membre : révoquer le client du propriétaire → refusé", await denied(member.call("/api/mcp.revokeGrant", { clientId: ownerClient.client_id, userId: ownerUserId })));
check("propriétaire : révoquer le client du membre → autorisé", !(await denied(owner.call("/api/mcp.revokeGrant", { clientId: memberClient.client_id, userId: memberGrants[0].user.id }))));
check("… et le token du membre est refusé aussitôt", (await mcp(memberToken, "tools/list")).status === 401);
await owner.call("/api/mcp.revokeGrant", { clientId: ownerClient.client_id });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies`);
process.exitCode = failed.length ? 1 : 0;
