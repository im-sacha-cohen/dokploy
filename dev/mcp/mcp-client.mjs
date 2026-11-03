// Minimal MCP client for the local e2e scripts: JSON-RPC over Streamable HTTP
// (protocol 2026-07-28 envelope or legacy), OAuth authorization with PKCE
// through the owner session, and a results collector.
import { createHash, randomBytes } from "node:crypto";
import { baseUrl, call, rawGet } from "../demo-apps/api-client.mjs";

export const MCP_URL = `${baseUrl}/mcp`;
export const REDIRECT_URI = "http://127.0.0.1:8976/callback";
export const MODERN = "2026-07-28";
export const results = [];
export const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
};
export const b64url = (buf) => buf.toString("base64url");
let rpcId = 0;

export const mcp = async (
	token,
	method,
	params = {},
	{ headers = {}, modern = true, capabilities = {} } = {},
) => {
	const body = {
		jsonrpc: "2.0",
		id: ++rpcId,
		method,
		params: modern
			? {
					...params,
					_meta: {
						"io.modelcontextprotocol/protocolVersion": MODERN,
						"io.modelcontextprotocol/clientInfo": {
							name: "dokploy-e2e",
							version: "1.0.0",
						},
						"io.modelcontextprotocol/clientCapabilities": capabilities,
					},
				}
			: params,
	};
	const res = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(modern
				? {
						"mcp-protocol-version": MODERN,
						"mcp-method": method,
						...(method === "tools/call" ? { "mcp-name": params.name } : {}),
					}
				: {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...headers,
		},
		body: JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		const data = text.split("\n").find((l) => l.startsWith("data:"));
		if (data) json = JSON.parse(data.slice(5));
	}
	return { status: res.status, headers: res.headers, json, text };
};

export const toolCall = (token, name, args = {}, extra = {}, options = {}) =>
	mcp(token, "tools/call", { name, arguments: args, ...extra }, options);

export const authorize = async (
	clientId,
	scopes,
	organizationId,
	session = { call, rawGet },
) => {
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash("sha256").update(verifier).digest());
	const state = b64url(randomBytes(12));
	const url = new URL(`${baseUrl}/api/auth/oauth2/authorize`);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT_URI,
		scope: `${scopes.join(" ")} offline_access`,
		state,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: MCP_URL,
	}).toString();
	const res = await session.rawGet(url.toString());
	// better-auth answers with a 302 for browsers and with {redirect, url} otherwise.
	const location =
		res.headers.get("location") ??
		(await res.json().catch(() => ({}))).url ??
		"";
	const consentUrl = new URL(location, baseUrl);
	check(
		"authorize → redirection vers la page de consentement",
		consentUrl.pathname === "/oauth/consent",
		consentUrl.pathname,
	);

	// Like the consent page: only the scopes the organization allows are consented.
	const { scopes: granted } = await session.call("/api/mcp.recordGrant", {
		clientId,
		organizationId,
		scopes,
	});
	const consent = await session.call("/api/auth/oauth2/consent", {
		accept: true,
		scope: `${granted.join(" ")} offline_access`,
		oauth_query: consentUrl.search.slice(1),
	});
	const redirect = new URL(consent.url ?? consent.redirect_uri);
	check(
		"consentement → code renvoyé à l'URI enregistrée",
		redirect.origin + redirect.pathname === REDIRECT_URI &&
			redirect.searchParams.get("state") === state,
	);
	const code = redirect.searchParams.get("code");

	const tokenRes = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: clientId,
			code_verifier: verifier,
			resource: MCP_URL,
		}),
	});
	const tokens = await tokenRes.json();
	check(
		"échange du code avec PKCE",
		tokenRes.ok && !!tokens.access_token,
		`HTTP ${tokenRes.status} ${tokens.error ?? ""}`,
	);
	const replay = await fetch(`${baseUrl}/api/auth/oauth2/token`, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: clientId,
			code_verifier: verifier,
			resource: MCP_URL,
		}),
	});
	check("rejeu du code refusé", !replay.ok, `HTTP ${replay.status}`);
	return tokens;
};

export const summarize = () => {
	const failed = results.filter((r) => !r.ok);
	console.log(
		`\n${results.length - failed.length}/${results.length} vérifications réussies`,
	);
	process.exitCode = failed.length ? 1 : 0;
};

/** Dynamic client registration of a public (PKCE) client. */
export const registerClient = async (name, scopes) => {
	const res = await fetch(`${baseUrl}/api/auth/oauth2/register`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: name,
			redirect_uris: [REDIRECT_URI],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			application_type: "native",
			scope: `${scopes.join(" ")} offline_access`,
		}),
	});
	return res.json();
};
