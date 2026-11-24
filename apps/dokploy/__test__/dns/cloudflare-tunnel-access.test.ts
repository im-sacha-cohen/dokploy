import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

import { CloudflareApiError } from "@dokploy/server/utils/dns/cloudflare";
import { checkCloudflareToken } from "@dokploy/server/utils/dns/cloudflare-permissions";
import {
	CLOUDFLARE_PERMISSIONS,
	checkCloudflareTunnelAccess,
	explainCloudflareError,
} from "@dokploy/server/utils/dns/cloudflare-tunnel";

const config = { providerType: "cloudflare" as const, apiToken: "cf-token" };

const ok = (result: unknown) =>
	({
		ok: true,
		status: 200,
		json: async () => ({ success: true, errors: [], result }),
	}) as Response;

const fail = (status: number, code: number, message: string) =>
	({
		ok: false,
		status,
		json: async () => ({ success: false, errors: [{ code, message }] }),
	}) as Response;

const route = (routes: Record<string, () => Response>) =>
	mockFetch.mockImplementation(async (url: string) => {
		const match = Object.keys(routes).find((path) => url.includes(path));
		if (!match) throw new Error(`unexpected ${url}`);
		return routes[match]!();
	});

beforeEach(() => {
	mockFetch.mockReset();
});

describe("explainCloudflareError", () => {
	it("points to the IP filter when the token is used from another IP", () => {
		const error = new CloudflareApiError("/zones", 403, [
			{
				code: 9109,
				message: "Cannot use the access token from location: 1.2.3.4",
			},
		]);
		expect(explainCloudflareError(error, "x")).toContain(
			"Client IP Address Filtering",
		);
	});

	it("says the token is invalid", () => {
		const error = new CloudflareApiError("/zones", 401, [
			{ code: 1000, message: "Invalid API Token" },
		]);
		expect(explainCloudflareError(error, "x")).toContain("invalid, expired");
	});

	it("names the missing permission", () => {
		const error = new CloudflareApiError("/accounts/a/cfd_tunnel", 403, [
			{ code: 10000, message: "Authentication error" },
		]);
		expect(
			explainCloudflareError(error, CLOUDFLARE_PERMISSIONS.tunnelEdit),
		).toContain('lacks the "Account › Cloudflare Tunnel › Edit" permission');
	});
});

describe("checkCloudflareTunnelAccess", () => {
	it("finds the account through the zones when the token lists no account", async () => {
		route({
			"/zones?": () => ok([{ account: { id: "acc1" } }]),
			"/accounts?": () => ok([]),
			"/accounts/acc1/cfd_tunnel": () => ok([]),
		});
		expect(await checkCloudflareTunnelAccess(config)).toEqual({
			ok: true,
			accountIds: ["acc1"],
		});
	});

	it("checks only the tunnel's account when it is known", async () => {
		route({ "/accounts/acc9/cfd_tunnel": () => ok([]) });
		expect(await checkCloudflareTunnelAccess(config, "acc9")).toEqual({
			ok: true,
			accountIds: ["acc9"],
		});
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("explains a missing tunnel permission", async () => {
		route({
			"/accounts/acc9/cfd_tunnel": () =>
				fail(403, 10000, "Authentication error"),
		});
		const access = await checkCloudflareTunnelAccess(config, "acc9");
		expect(access.ok).toBe(false);
		expect(!access.ok && access.reason).toContain(
			"Account › Cloudflare Tunnel › Edit",
		);
	});

	it("reports the IP filter rather than a missing permission", async () => {
		const blocked = () =>
			fail(403, 9109, "Cannot use the access token from location: 1.2.3.4");
		route({ "/zones?": blocked, "/accounts?": blocked });
		const access = await checkCloudflareTunnelAccess(config);
		expect(!access.ok && access.reason).toContain(
			"Client IP Address Filtering",
		);
	});
});

describe("checkCloudflareToken", () => {
	const zone = { id: "z1", name: "example.com", account: { id: "acc1" } };

	it("reports each permission", async () => {
		route({
			"/zones?": () => ok([zone]),
			"/zones/z1/dns_records/r1": () => ok({ id: "r1" }),
			"/zones/z1/dns_records": () => ok({ id: "r1" }),
			"/accounts?": () => ok([]),
			"/accounts/acc1/cfd_tunnel": () =>
				fail(403, 10000, "Authentication error"),
		});
		const report = await checkCloudflareToken(config);
		expect(report.token.status).toBe("ok");
		expect(report.zoneRead).toMatchObject({ status: "ok" });
		expect(report.dnsEdit).toMatchObject({
			status: "ok",
			detail: "Test record created and removed in example.com",
		});
		expect(report.tunnelEdit.status).toBe("missing");
		const methods = mockFetch.mock.calls
			.filter(([url]) => String(url).includes("dns_records"))
			.map(([, init]) => (init as RequestInit).method);
		expect(methods).toEqual(["POST", "DELETE"]);
	});

	it("marks DNS edit missing when Cloudflare refuses the test record", async () => {
		route({
			"/zones?": () => ok([zone]),
			"/zones/z1/dns_records": () => fail(403, 10000, "Authentication error"),
			"/accounts?": () => ok([]),
			"/accounts/acc1/cfd_tunnel": () => ok([]),
		});
		const report = await checkCloudflareToken(config);
		expect(report.dnsEdit.status).toBe("missing");
		expect(report.tunnelEdit.status).toBe("ok");
	});

	it("stops at the token when its IP is filtered", async () => {
		route({
			"/zones?": () =>
				fail(403, 9109, "Cannot use the access token from location: 1.2.3.4"),
		});
		const report = await checkCloudflareToken(config);
		expect(report.token.status).toBe("error");
		expect(report.zoneRead.status).toBe("skipped");
		expect(report.dnsEdit.status).toBe("skipped");
		expect(report.tunnelEdit.status).toBe("skipped");
	});
});
