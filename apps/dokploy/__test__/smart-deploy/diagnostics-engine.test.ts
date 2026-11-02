import { runDiagnostics } from "@dokploy/server/smart-deploy/diagnostics/engine";
import type {
	DiagnosticContext,
	TaskFact,
} from "@dokploy/server/smart-deploy/diagnostics/types";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const secondsAgo = (s: number) =>
	new Date(NOW.getTime() - s * 1000).toISOString();

const runningTask = (): TaskFact => ({
	state: "running",
	desiredState: "running",
	timestamp: secondsAgo(600),
	containerId: "c1",
});

const failedTask = (s: number, exitCode: number): TaskFact => ({
	state: "failed",
	desiredState: "shutdown",
	timestamp: secondsAgo(s),
	error: `task: non-zero exit (${exitCode})`,
	exitCode,
});

const baseContext = (
	overrides: Partial<DiagnosticContext> = {},
): DiagnosticContext => ({
	now: NOW,
	target: {
		type: "application",
		id: "app1",
		name: "demo",
		appName: "demo-app",
		serverId: null,
	},
	config: {
		domains: [
			{
				domainId: "d1",
				host: "demo.docker.localhost",
				port: 3000,
				path: "/",
				https: false,
			},
		],
		publishedPorts: [],
		envKeys: ["PORT"],
		swarmHealthcheckConfigured: false,
	},
	latestDeployment: {
		deploymentId: "dep1",
		status: "done",
		createdAt: secondsAgo(700),
		errorMessage: null,
	},
	service: { exists: true, desiredReplicas: 1 },
	tasks: [runningTask()],
	container: {
		id: "c1",
		startedAt: secondsAgo(600),
		uptimeSeconds: 600,
		health: { status: "healthy", failingStreak: 0 },
	},
	imageExposedPorts: [3000],
	listening: [{ address: "0.0.0.0", port: 3000, family: "ipv4" }],
	probes: [
		{
			kind: "backend",
			target: "http://demo-app:3000/",
			domainId: "d1",
			ok: true,
			httpStatus: 200,
		},
		{
			kind: "router",
			target: "demo.docker.localhost/",
			domainId: "d1",
			ok: true,
			httpStatus: 200,
		},
	],
	logs: ["listening on 0.0.0.0:3000"],
	collectionErrors: [],
	...overrides,
});

const codes = (ctx: DiagnosticContext) =>
	runDiagnostics(ctx).findings.map((f) => f.code);

describe("diagnostics engine — demo scenarios", () => {
	it("A healthy: no finding, verdict healthy", () => {
		const report = runDiagnostics(baseContext());
		expect(report.findings).toEqual([]);
		expect(report.verdict).toBe("healthy");
	});

	it("B wrong port: PORT_MISMATCH with an auto-fix to the listening port", () => {
		const ctx = baseContext({
			config: {
				...baseContext().config,
				domains: [
					{
						domainId: "d1",
						host: "b.docker.localhost",
						port: 80,
						path: "/",
						https: false,
					},
				],
			},
			probes: [
				{
					kind: "backend",
					target: "http://demo-app:80/",
					domainId: "d1",
					ok: false,
					error: "connection_refused",
				},
				{
					kind: "router",
					target: "b.docker.localhost/",
					domainId: "d1",
					ok: false,
					httpStatus: 502,
				},
			],
		});
		const report = runDiagnostics(ctx);
		const mismatch = report.findings.find((f) => f.code === "PORT_MISMATCH");
		expect(mismatch?.confidence).toBe("high");
		expect(mismatch?.autoFixable).toBe(true);
		expect(mismatch?.recommendedFix.action).toEqual({
			kind: "update_domain_port",
			domainId: "d1",
			host: "b.docker.localhost",
			port: 3000,
		});
		const proxy = report.findings.find(
			(f) => f.code === "REVERSE_PROXY_UNREACHABLE",
		);
		expect(proxy?.causedBy).toEqual(["PORT_MISMATCH"]);
		expect(report.findings[0]?.code).toBe("PORT_MISMATCH");
		expect(report.verdict).toBe("down");
	});

	it("C crash loop: CONTAINER_CRASH_LOOP with exit code explanation", () => {
		const ctx = baseContext({
			tasks: [failedTask(5, 1), failedTask(12, 1), failedTask(19, 1)],
			container: null,
			listening: undefined,
			logs: ["Error: boom", "    at main (server.js:3)"],
			probes: [
				{
					kind: "backend",
					target: "http://demo-app:3000/",
					domainId: "d1",
					ok: false,
					error: "connection_refused",
				},
				{
					kind: "router",
					target: "c.docker.localhost/",
					domainId: "d1",
					ok: false,
					httpStatus: 502,
				},
			],
		});
		const report = runDiagnostics(ctx);
		const crash = report.findings.find(
			(f) => f.code === "CONTAINER_CRASH_LOOP",
		);
		expect(crash?.severity).toBe("critical");
		expect(crash?.probableCause).toContain("1 :");
		expect(crash?.evidence.some((e) => e.source === "application_logs")).toBe(
			true,
		);
		expect(codes(ctx)).not.toContain("PORT_MISMATCH");
		expect(codes(ctx)).not.toContain("APPLICATION_NOT_LISTENING");
		expect(report.verdict).toBe("down");
	});

	it("D missing env: names from logs, crash loop caused by it, values never exposed", () => {
		const ctx = baseContext({
			config: { ...baseContext().config, envKeys: ["PORT", "NODE_ENV"] },
			tasks: [failedTask(3, 78), failedTask(9, 78)],
			container: null,
			listening: undefined,
			logs: [
				"Missing required environment variable(s): DATABASE_URL, SESSION_SECRET",
			],
			envExampleKeys: ["DATABASE_URL", "SESSION_SECRET", "PORT"],
		});
		const report = runDiagnostics(ctx);
		const env = report.findings.find(
			(f) => f.code === "MISSING_ENVIRONMENT_VARIABLE",
		);
		expect(env?.confidence).toBe("high");
		expect(env?.recommendedFix.action).toEqual({
			kind: "set_environment_variables",
			keys: ["DATABASE_URL", "SESSION_SECRET"],
		});
		expect(env?.autoFixable).toBe(false);
		const crash = report.findings.find(
			(f) => f.code === "CONTAINER_CRASH_LOOP",
		);
		expect(crash?.causedBy).toEqual(["MISSING_ENVIRONMENT_VARIABLE"]);
		expect(crash?.severity).toBe("error");
	});

	it("G localhost bind: APPLICATION_LISTENING_ON_LOCALHOST, no PORT_MISMATCH", () => {
		const ctx = baseContext({
			listening: [{ address: "127.0.0.1", port: 3000, family: "ipv4" }],
			probes: [
				{
					kind: "backend",
					target: "http://demo-app:3000/",
					domainId: "d1",
					ok: false,
					error: "connection_refused",
				},
				{
					kind: "router",
					target: "g.docker.localhost/",
					domainId: "d1",
					ok: false,
					httpStatus: 502,
				},
			],
		});
		expect(codes(ctx)).toEqual([
			"APPLICATION_LISTENING_ON_LOCALHOST",
			"REVERSE_PROXY_UNREACHABLE",
		]);
	});
});

describe("diagnostics engine — rule details", () => {
	it("does not conclude from facts that were not collected", () => {
		const report = runDiagnostics(
			baseContext({
				tasks: undefined,
				container: undefined,
				listening: undefined,
				probes: undefined,
				logs: undefined,
				imageExposedPorts: undefined,
				collectionErrors: [
					{ source: "docker_service", message: "unreachable" },
				],
			}),
		);
		expect(report.findings).toEqual([]);
		expect(report.verdict).toBe("unknown");
	});

	it("waits for the grace period before reporting a missing listener", () => {
		const booting = baseContext({
			container: {
				id: "c1",
				startedAt: secondsAgo(5),
				uptimeSeconds: 5,
				health: { status: "starting", failingStreak: 0 },
			},
			listening: [],
		});
		expect(codes(booting)).not.toContain("APPLICATION_NOT_LISTENING");
		const settled = baseContext({ listening: [] });
		expect(codes(settled)).toContain("APPLICATION_NOT_LISTENING");
	});

	it("falls back to EXPOSE with medium confidence when sockets are unknown", () => {
		const report = runDiagnostics(
			baseContext({
				listening: undefined,
				imageExposedPorts: [8080],
				probes: [],
			}),
		);
		const mismatch = report.findings.find((f) => f.code === "PORT_MISMATCH");
		expect(mismatch?.confidence).toBe("medium");
		expect(mismatch?.autoFixable).toBe(false);
	});

	it("does not auto-fix when several ports listen and none is exposed", () => {
		const report = runDiagnostics(
			baseContext({
				config: {
					...baseContext().config,
					domains: [
						{
							domainId: "d1",
							host: "x.test",
							port: 80,
							path: null,
							https: false,
						},
					],
				},
				imageExposedPorts: [],
				listening: [
					{ address: "0.0.0.0", port: 3000, family: "ipv4" },
					{ address: "0.0.0.0", port: 9229, family: "ipv4" },
				],
				probes: [],
			}),
		);
		const mismatch = report.findings.find((f) => f.code === "PORT_MISMATCH");
		expect(mismatch?.autoFixable).toBe(false);
		expect(mismatch?.recommendedFix.action).toBeUndefined();
	});

	it("BUILD_FAILED keeps the build log excerpt", () => {
		const report = runDiagnostics(
			baseContext({
				latestDeployment: {
					deploymentId: "dep2",
					status: "error",
					createdAt: secondsAgo(60),
					errorMessage: "Build failed",
					logTail: [
						"Step 3/5 : RUN npm ci",
						"npm ERR! missing script: build",
						"done",
					],
				},
			}),
		);
		const build = report.findings.find((f) => f.code === "BUILD_FAILED");
		expect(build?.severity).toBe("critical");
		expect(build?.evidence[1]?.excerpt).toEqual([
			"npm ERR! missing script: build",
		]);
	});

	it("HEALTHCHECK_FAILED from an unhealthy container", () => {
		const report = runDiagnostics(
			baseContext({
				container: {
					id: "c1",
					startedAt: secondsAgo(600),
					uptimeSeconds: 600,
					health: {
						status: "unhealthy",
						failingStreak: 4,
						lastExitCode: 1,
						lastOutput: ["wget: server returned error: HTTP/1.1 404"],
					},
				},
			}),
		);
		expect(report.findings.map((f) => f.code)).toEqual(["HEALTHCHECK_FAILED"]);
		expect(report.verdict).toBe("degraded");
	});

	it("flapping service is a warning, not a crash loop", () => {
		const report = runDiagnostics(
			baseContext({
				tasks: [
					runningTask(),
					failedTask(60, 137),
					failedTask(120, 137),
					failedTask(180, 137),
				],
			}),
		);
		const crash = report.findings.find(
			(f) => f.code === "CONTAINER_CRASH_LOOP",
		);
		expect(crash?.severity).toBe("warning");
		expect(crash?.probableCause).toContain("OOM");
	});

	it("ignores failures older than the crash window", () => {
		expect(
			codes(
				baseContext({
					tasks: [
						runningTask(),
						failedTask(3600, 1),
						failedTask(3700, 1),
						failedTask(3800, 1),
					],
				}),
			),
		).toEqual([]);
	});

	it("router 404 while backend answers means the route is missing", () => {
		const report = runDiagnostics(
			baseContext({
				probes: [
					{
						kind: "backend",
						target: "http://demo-app:3000/",
						domainId: "d1",
						ok: true,
						httpStatus: 200,
					},
					{
						kind: "router",
						target: "demo.docker.localhost/",
						domainId: "d1",
						ok: true,
						httpStatus: 404,
					},
				],
			}),
		);
		const proxy = report.findings.find(
			(f) => f.code === "REVERSE_PROXY_UNREACHABLE",
		);
		expect(proxy?.title).toContain("ne route pas");
		expect(proxy?.causedBy).toBeUndefined();
	});

	it("env vars from .env.example only are low-confidence info on a healthy app", () => {
		const report = runDiagnostics(
			baseContext({ envExampleKeys: ["PORT", "SENTRY_DSN"] }),
		);
		const env = report.findings.find(
			(f) => f.code === "MISSING_ENVIRONMENT_VARIABLE",
		);
		expect(env?.severity).toBe("info");
		expect(env?.confidence).toBe("low");
		expect(report.verdict).toBe("healthy");
	});

	it("isolates a throwing rule instead of failing the report", () => {
		const report = runDiagnostics(baseContext(), [
			() => {
				throw new Error("broken rule");
			},
		]);
		expect(report.findings).toEqual([]);
		expect(report.collectionErrors[0]?.message).toContain("broken rule");
	});
});
