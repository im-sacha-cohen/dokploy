import {
	baseLabel,
	classifyName,
	isValidHostInZone,
	rankServerIps,
	suggestFqdn,
	toFqdn,
	toLabel,
} from "@dokploy/server/smart-deploy/dns/names";
import { describe, expect, it } from "vitest";

const SERVER = ["203.0.113.10"];
const record = (name: string, type: string, content: string, id = name) => ({
	id,
	name,
	type,
	content,
});

describe("subdomain suggestion", () => {
	it("builds DNS labels from service and environment names", () => {
		expect(toLabel("My API_v2!")).toBe("my-api-v2");
		expect(toLabel("--Déjà vu--")).toBe("deja-vu");
		expect(toLabel("x".repeat(80))).toHaveLength(63);
		expect(baseLabel("Web App", "production")).toBe("web-app");
		expect(baseLabel("Web App", "Staging")).toBe("web-app-staging");
		expect(baseLabel("", undefined)).toBe("app");
	});

	it("qualifies names in the zone", () => {
		expect(toFqdn("api", "Example.com.")).toBe("api.example.com");
		expect(toFqdn("api.example.com.", "example.com")).toBe("api.example.com");
		expect(toFqdn("@", "example.com")).toBe("example.com");
		expect(isValidHostInZone("api.example.com", "example.com")).toBe(true);
		expect(isValidHostInZone("api.other.com", "example.com")).toBe(false);
		expect(isValidHostInZone("-bad.example.com", "example.com")).toBe(false);
		expect(isValidHostInZone("a_b.example.com", "example.com")).toBe(false);
	});

	it("skips names already used by another record", () => {
		const records = [
			record("web.example.com", "A", "198.51.100.7"),
			record("web-2.example.com", "CNAME", "elsewhere.net"),
			record("web-3.example.com", "TXT", "verification"),
		];
		expect(suggestFqdn(records, "web", "example.com", SERVER)).toEqual({
			fqdn: "web-3.example.com",
			status: { status: "free" },
		});
	});

	it("reuses a name that already points to this server", () => {
		const records = [record("web.example.com.", "A", "203.0.113.10", "r1")];
		expect(suggestFqdn(records, "web", "example.com", SERVER)).toEqual({
			fqdn: "web.example.com",
			status: { status: "points_here", recordId: "r1" },
		});
	});
});

describe("conflict detection (never overwrite)", () => {
	it("treats A, AAAA and CNAME on the same name as taken", () => {
		for (const type of ["A", "AAAA", "CNAME"]) {
			const status = classifyName(
				[record("api.example.com", type, "198.51.100.7")],
				"API.example.com",
				SERVER,
			);
			expect(status.status).toBe("taken");
		}
	});

	it("is taken when only part of the records point here", () => {
		const status = classifyName(
			[
				record("api.example.com", "A", "203.0.113.10"),
				record("api.example.com", "A", "198.51.100.7"),
			],
			"api.example.com",
			SERVER,
		);
		expect(status.status).toBe("taken");
	});

	it("ignores records that can coexist (TXT, MX)", () => {
		expect(
			classifyName(
				[
					record("api.example.com", "TXT", "x"),
					record("api.example.com", "MX", "10 mail"),
				],
				"api.example.com",
				SERVER,
			),
		).toEqual({ status: "free" });
	});
});

describe("server IP ranking", () => {
	it("keeps IPv4 only, configured first, then public, then private", () => {
		expect(
			rankServerIps(
				[
					"192.168.1.4",
					"2001:db8::1",
					"198.51.100.7",
					"203.0.113.10",
					"10.0.0.2",
				],
				"203.0.113.10",
			),
		).toEqual(["203.0.113.10", "198.51.100.7", "192.168.1.4", "10.0.0.2"]);
	});
});
