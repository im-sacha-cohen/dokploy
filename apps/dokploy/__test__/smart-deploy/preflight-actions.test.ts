import {
	findProposedFix,
	sameFixAction,
} from "@dokploy/server/smart-deploy/actions/fixes";
import { buildTimeline } from "@dokploy/server/smart-deploy/actions/timeline";
import type { Finding } from "@dokploy/server/smart-deploy/diagnostics/types";
import {
	analyzeSnapshot,
	extractEnvReferences,
	parseComposeServices,
	parseDockerfile,
} from "@dokploy/server/smart-deploy/preflight/analyze";
import { parseSnapshotOutput } from "@dokploy/server/smart-deploy/preflight/index";
import type {
	PreflightConfig,
	RepositorySnapshot,
} from "@dokploy/server/smart-deploy/preflight/types";
import { describe, expect, it } from "vitest";

const snapshot = (
	overrides: Partial<RepositorySnapshot>,
): RepositorySnapshot => ({
	commitSha: "a".repeat(40),
	files: [],
	contents: {},
	envReferences: [],
	listenLines: [],
	truncated: false,
	...overrides,
});

const config = (overrides: Partial<PreflightConfig> = {}): PreflightConfig => ({
	buildType: "dockerfile",
	dockerfilePath: "Dockerfile",
	buildPath: "",
	domains: [{ domainId: "d1", host: "app.test", port: 3000 }],
	envKeys: [],
	swarmHealthcheck: false,
	...overrides,
});

const codes = (s: RepositorySnapshot, c = config()) =>
	analyzeSnapshot(s, c).checks.map((check) => check.code);

// Mirrors demo app D (dev/demo-apps/d-missing-env).
const NODE_APP = snapshot({
	files: [
		"Dockerfile",
		"server.js",
		".env.example",
		"package.json",
		"pnpm-lock.yaml",
	],
	contents: {
		"package.json": JSON.stringify({
			scripts: { start: "node server.js", build: "tsc" },
			dependencies: { express: "^5" },
			devDependencies: { typescript: "^5" },
		}),
		Dockerfile:
			'FROM node:24-alpine\nWORKDIR /app\nENV NODE_ENV=production API_SECRET=hunter22\nCOPY . .\nEXPOSE 3000/tcp\nHEALTHCHECK CMD wget -qO- http://localhost:3000/health\nCMD ["node", "server.js"]',
		".env.example": "DATABASE_URL=\nSESSION_SECRET=\n",
	},
	envReferences: [
		"process.env.DATABASE_URL",
		"process.env.SESSION_SECRET",
		"process.env.PORT",
		"process.env.API_SECRET",
	],
	listenLines: [
		"const port = Number(process.env.PORT || 3000);",
		'app.get("/health", ok)',
	],
});

describe("preflight analysis", () => {
	it("detects language, framework, package manager, Dockerfile facts", () => {
		const a = analyzeSnapshot(NODE_APP, config());
		expect(a.language?.value).toBe("TypeScript (Node.js)");
		expect(a.framework?.value).toBe("Express");
		expect(a.packageManager).toMatchObject({
			value: "pnpm",
			confidence: "high",
		});
		expect(a.dockerfile?.value).toMatchObject({
			exposedPorts: [3000],
			healthcheck: true,
		});
		expect(a.startCommand?.value).toBe('["node", "server.js"]');
		expect(a.healthcheck?.confidence).toBe("high");
		expect(a.ports.map((p) => p.port)).toEqual([3000]);
	});

	it("reports missing env names, never values, and ignores platform/image vars", () => {
		const a = analyzeSnapshot(NODE_APP, config({ envKeys: ["NODE_ENV"] }));
		expect(a.envVars.missing).toEqual(["DATABASE_URL", "SESSION_SECRET"]);
		expect(JSON.stringify(a)).not.toContain("hunter22");
		const check = a.checks.find(
			(c) => c.code === "MISSING_ENVIRONMENT_VARIABLE",
		);
		expect(check?.confidence).toBe("medium");
	});

	it("flags a domain port that matches no detected port (scenario B)", () => {
		const check = analyzeSnapshot(
			NODE_APP,
			config({ domains: [{ domainId: "d1", host: "b.test", port: 80 }] }),
		).checks.find((c) => c.code === "PORT_MISMATCH");
		expect(check?.confidence).toBe("high");
		expect(check?.recommendation).toContain("3000");
	});

	it("flags localhost binding (scenario G) and Flask defaults", () => {
		expect(
			codes(
				snapshot({
					files: ["server.js"],
					listenLines: ['server.listen(3000, "127.0.0.1")'],
				}),
			),
		).toContain("APPLICATION_LISTENING_ON_LOCALHOST");
		expect(
			codes(
				snapshot({
					files: ["requirements.txt", "app.py"],
					contents: { "requirements.txt": "flask==3.0\n" },
					listenLines: ["    app.run(port=5000)"],
				}),
				config({ buildType: "nixpacks" }),
			),
		).toContain("APPLICATION_LISTENING_ON_LOCALHOST");
	});

	it("checks build configuration consistency", () => {
		expect(codes(snapshot({ files: ["index.js"] }))).toContain(
			"BUILD_CONFIGURATION_MISMATCH",
		);
		const compose = analyzeSnapshot(
			snapshot({
				files: ["docker-compose.yml"],
				contents: {
					"docker-compose.yml":
						"services:\n  web:\n    build: ./web\n  cache:\n    image: redis\n",
				},
			}),
			config({ buildType: "nixpacks" }),
		);
		expect(compose.compose?.value.services).toEqual(["web", "cache"]);
		expect(compose.checks.map((c) => c.code)).toContain("COMPOSE_PROJECT");
	});

	it("reports missing healthcheck and missing domain", () => {
		const c = codes(
			snapshot({ files: ["main.go", "go.mod"] }),
			config({ buildType: "nixpacks", domains: [] }),
		);
		expect(c).toEqual(expect.arrayContaining(["NO_HEALTHCHECK", "NO_DOMAIN"]));
	});

	it("parses helpers", () => {
		expect(
			parseDockerfile("EXPOSE 8080 9090/udp $PORT\nHEALTHCHECK NONE")
				.exposedPorts,
		).toEqual([8080, 9090]);
		expect(parseDockerfile("HEALTHCHECK NONE").healthcheck).toBe(false);
		expect(
			parseComposeServices(
				"version: '3'\nservices:\n  api:\n    image: x\n\nvolumes:\n  data:\n",
			),
		).toEqual(["api"]);
		expect(
			extractEnvReferences([
				"os.environ['DB_URL']",
				'os.getenv("REDIS_URL")',
				'os.Getenv("GO_KEY")',
				"ENV.fetch('RAILS_KEY'",
				"import.meta.env.VITE_API",
			]),
		).toEqual(["DB_URL", "GO_KEY", "RAILS_KEY", "REDIS_URL", "VITE_API"]);
	});

	it("parses the snapshot script output", () => {
		const out = [
			"Cloning ... ✅",
			"@@HEAD",
			"b".repeat(40),
			"@@FILES",
			"package.json",
			"src/index.ts",
			"@@FILE package.json",
			'{"name":"x"}',
			"",
			"@@ENDFILE",
			"@@ENVREFS",
			"process.env.FOO",
			"@@LISTEN",
			"app.listen(4000)",
			"@@END",
		].join("\n");
		expect(parseSnapshotOutput(out)).toEqual({
			commitSha: "b".repeat(40),
			files: ["package.json", "src/index.ts"],
			contents: { "package.json": '{"name":"x"}' },
			envReferences: ["process.env.FOO"],
			listenLines: ["app.listen(4000)"],
			truncated: false,
		});
		expect(parseSnapshotOutput("fatal: repository not found")).toBeNull();
	});
});

const finding = (overrides: Partial<Finding>): Finding => ({
	code: "PORT_MISMATCH",
	title: "",
	description: "",
	severity: "critical",
	confidence: "high",
	evidence: [],
	probableCause: "",
	recommendedFix: {
		summary: "",
		action: {
			kind: "update_domain_port",
			domainId: "d1",
			host: "b.test",
			port: 3000,
		},
	},
	risk: "low",
	autoFixable: true,
	...overrides,
});

describe("fix validation", () => {
	it("only accepts actions proposed as auto-fixable by the diagnosis", () => {
		const findings = [finding({})];
		expect(
			findProposedFix(findings, {
				kind: "update_domain_port",
				domainId: "d1",
				host: "b.test",
				port: 3000,
			}),
		).toBeDefined();
		expect(
			findProposedFix(findings, {
				kind: "update_domain_port",
				domainId: "d1",
				host: "b.test",
				port: 22,
			}),
		).toBeUndefined();
		expect(
			findProposedFix(findings, { kind: "deploy_latest" }),
		).toBeUndefined();
		expect(
			findProposedFix([finding({ autoFixable: false })], {
				kind: "update_domain_port",
				domainId: "d1",
				host: "b.test",
				port: 3000,
			}),
		).toBeUndefined();
	});

	it("compares actions independently of key order", () => {
		expect(
			sameFixAction({ kind: "redeploy_deployment", deploymentId: "x" }, {
				deploymentId: "x",
				kind: "redeploy_deployment",
			} as never),
		).toBe(true);
	});
});

describe("timeline", () => {
	const stages = {
		build: { status: "passed" as const, at: "t1" },
		containerCreated: { status: "passed" as const, at: "t2" },
		containerRunning: { status: "pending" as const },
		healthy: { status: "pending" as const },
		reachable: { status: "pending" as const },
	};

	it("marks the first pending stage as running while verifying", () => {
		const t = buildTimeline({
			createdAt: "t0",
			status: "done",
			kind: "deploy_latest",
			verificationStatus: "verifying",
			verification: { startedAt: "t0", stages },
		});
		expect(t.settled).toBe(false);
		expect(t.events.map((e) => e.state)).toEqual([
			"done",
			"done",
			"done",
			"running",
			"pending",
			"pending",
		]);
	});

	it("is settled with failures and skipped stages", () => {
		const t = buildTimeline({
			createdAt: "t0",
			status: "done",
			kind: "deploy_latest",
			verificationStatus: "failed",
			verification: {
				startedAt: "t0",
				stages: {
					...stages,
					containerRunning: { status: "failed" },
					healthy: { status: "skipped" },
					reachable: { status: "skipped" },
				},
			},
		});
		expect(t.settled).toBe(true);
		expect(t.events.find((e) => e.key === "containerRunning")?.state).toBe(
			"failed",
		);
	});

	it("does not invent stages for untracked deployments", () => {
		const t = buildTimeline({
			createdAt: "t0",
			status: "done",
			kind: null,
			verificationStatus: null,
			verification: null,
		});
		expect(t.events).toHaveLength(2);
		expect(t.events[1]?.detail).toContain("No step-by-step");
	});
});
