import { mcpOAuthPlugins } from "@dokploy/server/mcp/oauth-plugins";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const env = process.env as Record<string, string | undefined>;

const authWith = (plugins: ReturnType<typeof mcpOAuthPlugins>) =>
	betterAuth({
		database: memoryAdapter({}),
		secret: "test-secret-test-secret-test-secret",
		plugins,
	});

describe("MCP OAuth plugins", () => {
	const previous = { url: env.DOKPLOY_MCP_RESOURCE_URL, nodeEnv: env.NODE_ENV };
	beforeEach(() => {
		env.NODE_ENV = "production";
	});
	afterEach(() => {
		env.DOKPLOY_MCP_RESOURCE_URL = previous.url;
		env.NODE_ENV = previous.nodeEnv;
	});

	it("registers no OAuth server without a public MCP URL", () => {
		env.DOKPLOY_MCP_RESOURCE_URL = "";
		expect(mcpOAuthPlugins()).toEqual([]);
	});

	it("keeps auth working without a public MCP URL (install without a domain)", async () => {
		env.DOKPLOY_MCP_RESOURCE_URL = "";
		const auth = authWith(mcpOAuthPlugins());
		await expect(
			auth.api.getSession({ headers: new Headers() }),
		).resolves.toBeNull();
	});

	it("registers jwt and the OAuth server, issuing for the configured URL", async () => {
		env.DOKPLOY_MCP_RESOURCE_URL = "https://dokploy.example.com/mcp";
		const plugins = mcpOAuthPlugins();
		expect(plugins.map((p) => p.id)).toEqual(["jwt", "oauth-provider"]);
		expect(plugins[0]?.options).toMatchObject({
			jwt: { issuer: "https://dokploy.example.com/api/auth" },
		});
		await expect(
			authWith(plugins).api.getSession({ headers: new Headers() }),
		).resolves.toBeNull();
	});
});
