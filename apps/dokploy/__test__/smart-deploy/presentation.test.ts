import { runDiagnostics } from "@dokploy/server/smart-deploy/diagnostics/engine";
import {
	buildNetworkChains,
	pickRootCause,
	suggestedDomainPort,
} from "@dokploy/server/smart-deploy/diagnostics/presentation";
import type { DiagnosticContext } from "@dokploy/server/smart-deploy/diagnostics/types";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-11-02T12:00:00.000Z");

const ctx = (
	overrides: Partial<DiagnosticContext> = {},
): DiagnosticContext => ({
	now: NOW,
	target: {
		type: "application",
		id: "app",
		name: "app",
		appName: "app",
		serverId: null,
	},
	config: {
		domains: [
			{ domainId: "d1", host: "b.test", port: 80, path: "/", https: false },
		],
		publishedPorts: [],
		envKeys: [],
		swarmHealthcheckConfigured: false,
	},
	service: { exists: true, desiredReplicas: 1 },
	tasks: [
		{
			state: "running",
			desiredState: "running",
			timestamp: "2026-11-02T11:00:00.000Z",
			containerId: "c1",
		},
	],
	container: {
		id: "c1",
		startedAt: "2026-11-02T11:00:00.000Z",
		uptimeSeconds: 3600,
		health: { status: "healthy", failingStreak: 0 },
	},
	imageExposedPorts: [3000],
	listening: [{ address: "0.0.0.0", port: 3000, family: "ipv4" }],
	probes: [
		{
			kind: "backend",
			target: "http://app:80/",
			domainId: "d1",
			ok: false,
			error: "connection_refused",
		},
		{
			kind: "router",
			target: "b.test/",
			domainId: "d1",
			ok: false,
			httpStatus: 502,
		},
	],
	collectionErrors: [],
	...overrides,
});

describe("presentation helpers", () => {
	it("root cause is the port mismatch, not the 502 it causes (scenario B)", () => {
		const report = runDiagnostics(ctx());
		expect(pickRootCause(report.findings)?.code).toBe("PORT_MISMATCH");
	});

	it("network chain marks Traefik and the routed port as broken, with the fix", () => {
		const [chain] = buildNetworkChains(runDiagnostics(ctx()));
		expect(chain?.hops.map((h) => [h.key, h.state])).toEqual([
			["entry", "not_applicable"],
			["router", "broken"],
			["domainPort", "broken"],
			["container", "ok"],
		]);
		expect(chain?.fix).toEqual({
			kind: "update_domain_port",
			domainId: "d1",
			host: "b.test",
			port: 3000,
		});
	});

	it("localhost-only app: container hop broken, no port fix offered (scenario G)", () => {
		const [chain] = buildNetworkChains(
			runDiagnostics(
				ctx({
					config: {
						...ctx().config,
						domains: [
							{
								domainId: "d1",
								host: "g.test",
								port: 3000,
								path: "/",
								https: false,
							},
						],
					},
					listening: [{ address: "127.0.0.1", port: 3000, family: "ipv4" }],
				}),
			),
		);
		expect(chain?.hops.find((h) => h.key === "container")?.state).toBe(
			"broken",
		);
		expect(chain?.fix).toBeNull();
	});

	it("healthy app: every hop ok and no root cause (scenario A)", () => {
		const report = runDiagnostics(
			ctx({
				config: {
					...ctx().config,
					domains: [
						{
							domainId: "d1",
							host: "a.test",
							port: 3000,
							path: "/",
							https: true,
						},
					],
				},
				probes: [
					{
						kind: "backend",
						target: "http://app:3000/",
						domainId: "d1",
						ok: true,
						httpStatus: 200,
					},
					{
						kind: "router",
						target: "a.test/",
						domainId: "d1",
						ok: true,
						httpStatus: 308,
					},
				],
			}),
		);
		expect(pickRootCause(report.findings)).toBeNull();
		expect(
			buildNetworkChains(report)[0]?.hops.every(
				(h) => h.state === "ok" || h.state === "not_applicable",
			),
		).toBe(true);
	});

	it("unknown sockets are shown as unknown, never as ok (crashed app)", () => {
		const [chain] = buildNetworkChains(
			runDiagnostics(ctx({ container: null, listening: undefined, tasks: [] })),
		);
		expect(chain?.hops.find((h) => h.key === "container")?.state).toBe(
			"unknown",
		);
	});

	it("suggests the only listening port, else the only EXPOSE", () => {
		expect(suggestedDomainPort(runDiagnostics(ctx()))).toBe(3000);
		expect(
			suggestedDomainPort(
				runDiagnostics(
					ctx({
						container: null,
						listening: undefined,
						imageExposedPorts: [8080],
					}),
				),
			),
		).toBe(8080);
		expect(
			suggestedDomainPort(
				runDiagnostics(
					ctx({
						imageExposedPorts: [],
						listening: [
							{ address: "0.0.0.0", port: 3000, family: "ipv4" },
							{ address: "0.0.0.0", port: 9229, family: "ipv4" },
						],
					}),
				),
			),
		).toBeNull();
	});
});
