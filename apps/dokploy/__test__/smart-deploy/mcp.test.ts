import { sanitizeArguments } from "@dokploy/server/mcp/audit";
import { getMcpIssuer, getMcpResourceUrls } from "@dokploy/server/mcp/config";
import { isMcpScope } from "@dokploy/server/mcp/grants";
import {
	absolutizeEndpoints,
	handleMcpRequest,
	handleProtectedResourceMetadata,
	resolveResource,
} from "@dokploy/server/mcp/http";
import { RateLimiter } from "@dokploy/server/mcp/rate-limit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RESOURCE = "https://dokploy.example.com/mcp";

const request = (host: string, init: RequestInit = {}) =>
	new Request(`https://${host}/mcp`, {
		method: "POST",
		...init,
		headers: {
			host,
			"content-type": "application/json",
			...(init.headers ?? {}),
		},
		body:
			"body" in init
				? init.body
				: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});

describe("MCP configuration", () => {
	const previous = process.env.DOKPLOY_MCP_RESOURCE_URL;
	beforeEach(() => {
		process.env.DOKPLOY_MCP_RESOURCE_URL = `${RESOURCE}/`;
	});
	afterEach(() => {
		process.env.DOKPLOY_MCP_RESOURCE_URL = previous;
	});

	it("uses the explicitly configured resource URL (trailing slash removed)", () => {
		expect(getMcpResourceUrls()).toEqual([RESOURCE]);
		expect(getMcpIssuer(RESOURCE)).toBe("https://dokploy.example.com/api/auth");
	});

	it("matches the request Host against configured resources only", () => {
		expect(resolveResource(request("dokploy.example.com"))).toBe(RESOURCE);
		expect(resolveResource(request("evil.example"))).toBeNull();
	});

	it("refuses unknown hosts before any token check (421)", async () => {
		expect((await handleMcpRequest(request("evil.example"))).status).toBe(421);
	});

	it("refuses cross-site browser origins (403)", async () => {
		const res = await handleMcpRequest(
			request("dokploy.example.com", {
				headers: { origin: "https://attacker.example" },
			}),
		);
		expect(res.status).toBe(403);
	});

	it("answers 401 with a resource_metadata challenge without a token", async () => {
		const res = await handleMcpRequest(request("dokploy.example.com"));
		expect(res.status).toBe(401);
		expect(res.headers.get("www-authenticate")).toContain(
			'resource_metadata="https://dokploy.example.com/.well-known/oauth-protected-resource/mcp"',
		);
	});

	it("serves RFC 9728 metadata pointing to the configured issuer", async () => {
		const res = handleProtectedResourceMetadata(
			request("dokploy.example.com", { method: "GET", body: null }),
		);
		expect(await res.json()).toMatchObject({
			resource: RESOURCE,
			authorization_servers: ["https://dokploy.example.com/api/auth"],
			scopes_supported: ["mcp:read", "mcp:deploy", "mcp:config"],
		});
	});

	it("is disabled (503) when no public URL is configured in production", async () => {
		process.env.DOKPLOY_MCP_RESOURCE_URL = "";
		const env = process.env as Record<string, string | undefined>;
		const nodeEnv = env.NODE_ENV;
		env.NODE_ENV = "production";
		try {
			expect(getMcpResourceUrls()).toEqual([]);
			expect(
				(await handleMcpRequest(request("dokploy.example.com"))).status,
			).toBe(503);
		} finally {
			env.NODE_ENV = nodeEnv;
		}
	});
});

describe("MCP helpers", () => {
	it("makes relative authorization server endpoints absolute", () => {
		expect(
			absolutizeEndpoints(
				{
					issuer: "x",
					token_endpoint: "/oauth2/token",
					jwks_uri: "/jwks",
					registration_endpoint: "https://already.absolute/register",
					scopes_supported: ["/not-an-endpoint"],
				},
				"https://d.example/api/auth",
			),
		).toEqual({
			issuer: "x",
			token_endpoint: "https://d.example/api/auth/oauth2/token",
			jwks_uri: "https://d.example/api/auth/jwks",
			registration_endpoint: "https://already.absolute/register",
			scopes_supported: ["/not-an-endpoint"],
		});
	});

	it("limits per key within a window", () => {
		const limiter = new RateLimiter(2, 1000);
		expect(limiter.hit("a", 0)).toBe(0);
		expect(limiter.hit("a", 10)).toBe(0);
		expect(limiter.hit("a", 20)).toBe(1);
		expect(limiter.hit("b", 20)).toBe(0);
		expect(limiter.hit("a", 1000)).toBe(0);
	});

	it("sanitizes audit arguments (secrets, control chars, nested values)", () => {
		expect(
			sanitizeArguments({
				applicationId: "abc",
				note: "token=supersecret \u001b[31mred",
				port: 3000,
				nested: { a: 1 },
				list: [1, 2],
			}),
		).toEqual({
			applicationId: "abc",
			note: "token=[REDACTED] red",
			port: 3000,
			nested: "[object]",
			list: "[2 items]",
		});
		expect(sanitizeArguments(null)).toEqual({});
	});

	it("recognizes only Dokploy MCP scopes", () => {
		expect(isMcpScope("mcp:read")).toBe(true);
		expect(isMcpScope("offline_access")).toBe(false);
		expect(isMcpScope("mcp:admin")).toBe(false);
	});
});
