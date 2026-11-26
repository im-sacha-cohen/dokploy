import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
	current: null as { host: string | null; https: boolean } | null,
}));

vi.mock("@dokploy/server/db", () => ({ db: {} }));
vi.mock("@dokploy/server/services/admin", () => ({
	getTrustedOrigins: async () => [],
	getTrustedProviders: async () => [],
	getUserByToken: async () => null,
}));
vi.mock("@dokploy/server/services/web-server-settings", () => ({
	getWebServerSettings: async () => settings.current,
	updateWebServerSettings: async () => null,
}));

const env = process.env as Record<string, string | undefined>;

describe("refreshMcpAuth", () => {
	const previous = { url: env.DOKPLOY_MCP_RESOURCE_URL, nodeEnv: env.NODE_ENV };
	beforeEach(() => {
		env.NODE_ENV = "production";
		env.DOKPLOY_MCP_RESOURCE_URL = "";
		settings.current = null;
	});
	afterEach(async () => {
		const { setPanelMcpResource } = await import("@dokploy/server/mcp/config");
		setPanelMcpResource(null);
		env.DOKPLOY_MCP_RESOURCE_URL = previous.url;
		env.NODE_ENV = previous.nodeEnv;
	});

	it("turns the OAuth server on and off with the panel's HTTPS domain", async () => {
		const { auth, refreshMcpAuth } = await import("@dokploy/server/lib/auth");
		const { getMcpResourceUrls } = await import("@dokploy/server/mcp/config");

		await refreshMcpAuth();
		expect(getMcpResourceUrls()).toEqual([]);
		expect(auth.getJwks).toBeUndefined();

		settings.current = { host: "panel.example.com", https: true };
		await refreshMcpAuth();
		expect(getMcpResourceUrls()).toEqual(["https://panel.example.com/mcp"]);
		expect(auth.getJwks).toBeTypeOf("function");
		const response = await auth.handler(
			new Request("https://panel.example.com/api/auth/get-session"),
		);
		expect(response.status).toBe(200);

		settings.current = { host: "panel.example.com", https: false };
		await refreshMcpAuth();
		expect(getMcpResourceUrls()).toEqual([]);
		expect(auth.getJwks).toBeUndefined();
	}, 20_000);
});
