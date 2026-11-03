// Permission and isolation tests on the LOCAL dev instance, as the owner and
// as the restricted member prepared by setup-isolation.mjs.
// Usage: node dev/phase7/setup-isolation.mjs && node dev/phase7/isolation-tests.mjs
import { createHash, randomBytes } from "node:crypto";
import { baseUrl, createSession, devEnv } from "../demo-apps/api-client.mjs";

// DOKPLOY_MCP_URL: public MCP URL when the instance is reached through a tunnel.
const MCP_URL = process.env.DOKPLOY_MCP_URL || `${baseUrl}/mcp`;
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

console.log("— Restricted member, UI API (tRPC/REST)");
const memberProjects = await member.call("/api/project.all", undefined, "GET");
const visible = memberProjects.flatMap((p) => p.environments.flatMap((e) => e.applications.map((a) => a.name))).sort();
check("project.all: only the granted apps (a, b, e)", JSON.stringify(visible) === JSON.stringify(["a-healthy", "b-wrong-port", "e-outdated"]), visible.join(","));
const q = (id) => `/api/smartDeploy.diagnoseApplication?${new URLSearchParams({ applicationId: id, probes: "false" })}`;
check("diagnosis of an app in a non-granted project → denied", await denied(member.call(q(restrictedApp), undefined, "GET")));
check("diagnosis of an app in another organization → denied", await denied(member.call(q(orgBApp), undefined, "GET")));
check("diagnosis of a non-granted app in the same project (C) → denied", await denied(member.call(q(appId("c-crash-loop")), undefined, "GET")));
check("diagnosis of a granted app (A) → allowed", !(await denied(member.call(q(appId("a-healthy")), undefined, "GET"))));
check("restart of a non-granted app (C) → denied", await denied(member.call("/api/smartDeploy.restartApplication", { applicationId: appId("c-crash-loop") })));
check("applyFix on a non-granted app → denied", await denied(member.call("/api/smartDeploy.applyFix", { applicationId: appId("c-crash-loop"), action: { kind: "deploy_latest" } })));
check("member: changing MCP settings → denied", await denied(member.call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ["mcp:read"] })));

console.log("— Restricted member, via MCP");
const memberClient = await registerClient("Member client");
const memberToken = await authorize(member, memberClient.client_id, ["mcp:read", "mcp:deploy"], orgA);
const mcpProjects = (await tool(memberToken, "dokploy_list_projects", {})).json?.result?.structuredContent?.projects ?? [];
const mcpVisible = mcpProjects.flatMap((p) => p.environments.flatMap((e) => e.applications.map((a) => a.name))).sort();
check("dokploy_list_projects: same apps as the UI", JSON.stringify(mcpVisible) === JSON.stringify(visible), mcpVisible.join(","));
check("MCP: app in a non-granted project → denied", toolDenied(await tool(memberToken, "dokploy_get_application", { applicationId: restrictedApp })));
check("MCP: app in another organization → denied", toolDenied(await tool(memberToken, "dokploy_get_application", { applicationId: orgBApp })));
check("MCP: non-granted app in the same project → denied", toolDenied(await tool(memberToken, "dokploy_diagnose_deployment", { applicationId: appId("c-crash-loop") })));
check("MCP: restart of a non-granted app → denied", toolDenied(await tool(memberToken, "dokploy_restart_application", { applicationId: appId("c-crash-loop") })));
const okApp = await tool(memberToken, "dokploy_get_application", { applicationId: appId("a-healthy") });
check("MCP: granted app → allowed", okApp.status === 200 && !okApp.json?.result?.isError);
const memberServers = await tool(memberToken, "dokploy_list_servers", {});
check("MCP: server list limited to granted servers (none)", (memberServers.json?.result?.structuredContent?.servers ?? []).length === 0 || memberServers.json?.result?.isError === true, memberServers.text.slice(0, 120));

console.log("— Owner: isolation per organization");
const ownerClient = await registerClient("Owner client");
const ownerToken = await authorize(owner, ownerClient.client_id, ["mcp:read"], orgA);
check("org A token: org B app denied (even for the owner)", toolDenied(await tool(ownerToken, "dokploy_get_application", { applicationId: orgBApp })));
check("org B (MCP disabled): grant denied", await denied(owner.call("/api/mcp.recordGrant", { clientId: ownerClient.client_id, organizationId: orgB, scopes: ["mcp:read"] })));
check("grant for an organization the user is not a member of → denied", await denied(member.call("/api/mcp.recordGrant", { clientId: memberClient.client_id, organizationId: orgB, scopes: ["mcp:read"] })));

console.log("— Restrictions applied immediately");
await owner.call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ["mcp:read"] });
const narrowed = await tool(memberToken, "dokploy_restart_application", { applicationId: appId("a-healthy") });
check("scope removed by the organization → 403 insufficient_scope on an existing token", narrowed.status === 403, `HTTP ${narrowed.status}`);
await owner.call("/api/mcp.updateSettings", { enabled: false, allowedScopes: ["mcp:read"] });
check("integration disabled → existing token rejected (401)", (await mcp(memberToken, "tools/list")).status === 401);
await owner.call("/api/mcp.updateSettings", { enabled: true, allowedScopes: ["mcp:read", "mcp:deploy", "mcp:config"] });
check("re-enabled → token accepted again", (await mcp(memberToken, "tools/list")).status === 200);

console.log("— Settings visibility");
const memberGrants = await member.call("/api/mcp.listGrants", undefined, "GET");
check("member: sees only their own clients", memberGrants.length > 0 && memberGrants.every((g) => g.isOwn));
const memberAudit = await member.call("/api/mcp.auditLog?limit=200", undefined, "GET");
check("member: audit limited to their own entries", memberAudit.every((e) => e.userId === memberGrants[0]?.user?.id));
const ownerGrants = await owner.call("/api/mcp.listGrants", undefined, "GET");
check("owner: sees the members' clients", ownerGrants.some((g) => !g.isOwn));
const ownerUserId = ownerGrants.find((g) => g.isOwn)?.user?.id;
check("member: revoking the owner's client → denied", await denied(member.call("/api/mcp.revokeGrant", { clientId: ownerClient.client_id, userId: ownerUserId })));
check("owner: revoking the member's client → allowed", !(await denied(owner.call("/api/mcp.revokeGrant", { clientId: memberClient.client_id, userId: memberGrants[0].user.id }))));
check("… and the member's token is rejected immediately", (await mcp(memberToken, "tools/list")).status === 401);
await owner.call("/api/mcp.revokeGrant", { clientId: ownerClient.client_id });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
