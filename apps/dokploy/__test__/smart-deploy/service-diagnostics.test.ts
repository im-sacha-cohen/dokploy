import { containerToTasks } from "@dokploy/server/smart-deploy/diagnostics/collect/compose";
import {
	DATABASE_RULES,
	runComposeDiagnostics,
	runDiagnostics,
} from "@dokploy/server/smart-deploy/diagnostics/engine";
import type {
	DiagnosticContext,
	TaskFact,
} from "@dokploy/server/smart-deploy/diagnostics/types";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-11-03T10:00:00Z");
const ago = (seconds: number) =>
	new Date(NOW.getTime() - seconds * 1000).toISOString();

const running = (): TaskFact => ({
	state: "running",
	desiredState: "running",
	timestamp: ago(30),
	containerId: "c1",
});
const failed = (
	seconds: number,
	error?: string,
	exitCode?: number,
): TaskFact => ({
	state: error?.includes("image") ? "rejected" : "failed",
	desiredState: "running",
	timestamp: ago(seconds),
	error,
	exitCode,
});

const database = (
	overrides: Partial<DiagnosticContext> = {},
): DiagnosticContext => ({
	now: NOW,
	target: {
		type: "postgres",
		id: "db1",
		name: "db",
		appName: "db-x",
		serverId: null,
	},
	config: {
		domains: [],
		publishedPorts: [],
		envKeys: ["POSTGRES_PASSWORD"],
		swarmHealthcheckConfigured: false,
	},
	database: {
		engine: "postgres",
		defaultPort: 5432,
		externalPort: null,
		configuredImage: "postgres:17",
	},
	service: { exists: true, desiredReplicas: 1, image: "postgres:17" },
	tasks: [running()],
	container: {
		id: "c1",
		startedAt: ago(600),
		uptimeSeconds: 600,
		health: { status: "none", failingStreak: 0 },
	},
	listening: [{ address: "0.0.0.0", port: 5432, family: "ipv4" }],
	logs: [],
	collectionErrors: [],
	...overrides,
});

const codes = (ctx: DiagnosticContext) =>
	runDiagnostics(ctx, DATABASE_RULES).findings.map((f) => f.code);

describe("database diagnostics", () => {
	it("is healthy when it runs and listens", () => {
		const report = runDiagnostics(database(), DATABASE_RULES);
		expect(report.verdict).toBe("healthy");
		expect(report.facts.database?.runningImage).toBe("postgres:17");
	});

	it("detects data written by another major version", () => {
		const report = runDiagnostics(
			database({
				tasks: [
					failed(30, "task: non-zero exit (1)", 1),
					failed(90, undefined, 1),
				],
				container: null,
				listening: undefined,
				logs: [
					"FATAL:  database files are incompatible with server",
					"DETAIL:  The data directory was initialized by PostgreSQL version 16, which is not compatible with this version 17.6.",
				],
			}),
			DATABASE_RULES,
		);
		const root = report.findings.find(
			(f) => f.code === "DATA_DIRECTORY_INCOMPATIBLE",
		);
		expect(root?.severity).toBe("critical");
		expect(
			report.findings.find((f) => f.code === "CONTAINER_CRASH_LOOP")?.causedBy,
		).toContain("DATA_DIRECTORY_INCOMPATIBLE");
		expect(report.verdict).toBe("down");
	});

	it("does not mistake a normal MongoDB startup for incompatible data", () => {
		expect(
			codes(
				database({
					database: {
						engine: "mongo",
						defaultPort: 27017,
						externalPort: null,
						configuredImage: "mongo:7",
					},
					service: { exists: true, desiredReplicas: 1, image: "mongo:7" },
					listening: [{ address: "0.0.0.0", port: 27017, family: "ipv4" }],
					logs: [
						'{"t":{"$date":"2026-11-03T08:10:35Z"},"s":"I","c":"REPL","msg":"current featureCompatibilityVersion value","attr":{"featureCompatibilityVersion":"7.0","context":"startup"}}',
					],
				}),
			),
		).toEqual([]);
	});

	it("detects an image that cannot be pulled", () => {
		expect(
			codes(
				database({
					tasks: [
						failed(20, "No such image: mysql:does-not-exist"),
						failed(80, "No such image: mysql:does-not-exist"),
					],
					container: null,
					listening: undefined,
				}),
			),
		).toContain("IMAGE_PULL_FAILED");
	});

	it("detects a busy external port", () => {
		const found = runDiagnostics(
			database({
				database: {
					engine: "redis",
					defaultPort: 6379,
					externalPort: 80,
					configuredImage: "redis:7",
				},
				service: { exists: true, desiredReplicas: 1, image: "redis:7" },
				tasks: [
					failed(
						20,
						"Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:80 failed: port is already allocated",
					),
				],
				container: null,
				listening: undefined,
			}),
			DATABASE_RULES,
		).findings.find((f) => f.code === "EXTERNAL_PORT_UNAVAILABLE");
		expect(found?.severity).toBe("critical");
	});

	it("reports an image change that was not deployed, with a redeploy fix", () => {
		const finding = runDiagnostics(
			database({
				database: {
					engine: "postgres",
					defaultPort: 5432,
					externalPort: null,
					configuredImage: "postgres:18",
				},
			}),
			DATABASE_RULES,
		).findings.find((f) => f.code === "CONFIG_NOT_APPLIED");
		expect(finding?.recommendedFix.action).toEqual({
			kind: "redeploy_service",
		});
		expect(finding?.autoFixable).toBe(true);
	});

	it("says stopped, not down, for a database stopped on purpose", () => {
		const report = runDiagnostics(
			database({
				service: { exists: true, desiredReplicas: 0, image: "postgres:17" },
				tasks: [],
				container: null,
				listening: undefined,
			}),
			DATABASE_RULES,
		);
		expect(report.verdict).toBe("stopped");
	});

	it("detects a full disk and an OOM kill", () => {
		expect(
			codes(
				database({
					container: {
						id: "c1",
						startedAt: ago(10),
						uptimeSeconds: 10,
						health: { status: "none", failingStreak: 0 },
						oomKilled: true,
					},
					logs: ["could not write to file: No space left on device"],
				}),
			),
		).toEqual(expect.arrayContaining(["DISK_FULL", "OUT_OF_MEMORY"]));
	});
});

const composeService = (
	name: string,
	overrides: Partial<DiagnosticContext> = {},
): DiagnosticContext => ({
	...database(),
	database: undefined,
	target: {
		type: "compose",
		id: "cp1",
		name: "stack",
		appName: "stack-x",
		serverId: null,
		service: name,
	},
	config: {
		domains: [],
		publishedPorts: [],
		envKeys: [],
		swarmHealthcheckConfigured: false,
	},
	listening: undefined,
	...overrides,
});

const stack = (
	overrides: Partial<DiagnosticContext> = {},
): DiagnosticContext => ({
	now: NOW,
	target: {
		type: "compose",
		id: "cp1",
		name: "stack",
		appName: "stack-x",
		serverId: null,
	},
	config: {
		domains: [],
		publishedPorts: [],
		envKeys: [],
		swarmHealthcheckConfigured: false,
	},
	latestDeployment: {
		deploymentId: "d1",
		status: "done",
		createdAt: ago(300),
		errorMessage: null,
		logTail: [],
	},
	collectionErrors: [],
	...overrides,
});

describe("compose diagnostics", () => {
	it("tags findings with their service and lists every service", () => {
		const report = runComposeDiagnostics(stack(), [
			composeService("web", {
				config: {
					domains: [
						{
							domainId: "dm1",
							host: "app.example.com",
							port: 3000,
							path: "/",
							https: false,
							serviceName: "web",
						},
					],
					publishedPorts: [],
					envKeys: [],
					swarmHealthcheckConfigured: false,
				},
				listening: [{ address: "0.0.0.0", port: 8080, family: "ipv4" }],
			}),
			composeService("worker", {
				tasks: [failed(20, "exit code 3", 3), failed(60, "exit code 3", 3)],
				container: null,
			}),
		]);
		const portMismatch = report.findings.find(
			(f) => f.code === "PORT_MISMATCH",
		);
		expect(portMismatch?.service).toBe("web");
		expect(
			report.findings.find((f) => f.code === "CONTAINER_CRASH_LOOP")?.service,
		).toBe("worker");
		expect(report.facts.services?.map((s) => [s.name, s.verdict])).toEqual([
			["web", "down"],
			["worker", "down"],
		]);
		expect(report.verdict).toBe("down");
	});

	it("never flags a worker without domain for not listening", () => {
		const report = runComposeDiagnostics(stack(), [
			composeService("worker", { listening: [] }),
		]);
		expect(report.findings).toEqual([]);
		expect(report.verdict).toBe("healthy");
	});

	it("reports variables the compose file uses but Dokploy lacks", () => {
		const report = runComposeDiagnostics(
			stack({
				latestDeployment: {
					deploymentId: "d1",
					status: "done",
					createdAt: ago(300),
					errorMessage: null,
					logTail: [
						'time="2026-11-03T09:55:00Z" level=warning msg="The \\"API_KEY\\" variable is not set. Defaulting to a blank string."',
					],
				},
			}),
			[composeService("web")],
		);
		const finding = report.findings.find(
			(f) => f.code === "MISSING_ENVIRONMENT_VARIABLE",
		);
		expect(finding?.recommendedFix.action).toEqual({
			kind: "set_environment_variables",
			keys: ["API_KEY"],
		});
		expect(report.verdict).toBe("degraded");
	});

	it("takes the stack down when a service with a domain is stopped", () => {
		const report = runComposeDiagnostics(stack(), [
			composeService("web", {
				config: {
					domains: [
						{
							domainId: "dm1",
							host: "app.example.com",
							port: 80,
							path: "/",
							https: false,
							serviceName: "web",
						},
					],
					publishedPorts: [],
					envKeys: [],
					swarmHealthcheckConfigured: false,
				},
				service: { exists: true, desiredReplicas: 0, image: "nginx" },
				tasks: [
					{
						state: "complete",
						desiredState: "running",
						timestamp: ago(900),
						exitCode: 255,
					},
				],
				container: null,
			}),
			composeService("worker"),
		]);
		const stopped = report.findings.find((f) => f.code === "SERVICE_STOPPED");
		expect(stopped?.service).toBe("web");
		expect(stopped?.description).toContain("255");
		expect(stopped?.recommendedFix.action).toEqual({
			kind: "redeploy_service",
		});
		expect(report.verdict).toBe("down");
	});

	it("turns a restarting container into failed tasks", () => {
		const tasks = containerToTasks(
			{
				Status: "restarting",
				Running: true,
				Restarting: true,
				ExitCode: 3,
				FinishedAt: ago(5),
			},
			"c1",
			7,
			NOW,
		);
		expect(tasks.filter((t) => t.state === "failed")).toHaveLength(5);
		expect(tasks.some((t) => t.state === "running")).toBe(false);
		expect(
			containerToTasks(
				{ Status: "exited", ExitCode: 0, FinishedAt: ago(5) },
				"c1",
				0,
				NOW,
			).map((t) => t.state),
		).toEqual(["complete"]);
	});
});
