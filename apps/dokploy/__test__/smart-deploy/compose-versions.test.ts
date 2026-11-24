import { paths } from "@dokploy/server/constants";
import {
	buildComposeRunCommand,
	composeImageTag,
	composeRollbackUnavailableReason,
	matchesRunning,
	parseComposeContainers,
	pinComposeImages,
} from "@dokploy/server/smart-deploy/versioning/compose";
import { describe, expect, it } from "vitest";

const ROOT = `${paths(false).COMPOSE_PATH}/coach-abc`;
const IMAGE_1 = `sha256:${"1".repeat(64)}`;
const IMAGE_2 = `sha256:${"2".repeat(64)}`;
const IMAGE_3 = `sha256:${"3".repeat(64)}`;

describe("composeImageTag", () => {
	it("tags per deployment and service in the versions repository", () => {
		expect(composeImageTag("coach-abc123", "dpl_X-1", "app")).toBe(
			"dokploy-versions/coach-abc123:dpl-dpl_X-1-app",
		);
	});

	it("gives up on a tag Docker would refuse", () => {
		expect(composeImageTag("a", "d", "x".repeat(130))).toBeNull();
		expect(composeImageTag("a", "d", "bad/name")).toBeNull();
	});
});

describe("parseComposeContainers", () => {
	it("keeps one entry per service and ignores junk", () => {
		const services = parseComposeContainers(
			[
				`app|${IMAGE_1}|coach-app`,
				`app|${IMAGE_2}|coach-app`,
				`db|${IMAGE_3}|postgres:17-alpine`,
				"broken line",
				"web|not-an-id|nginx",
				"",
			].join("\n"),
		);
		expect([...services]).toEqual([
			["app", { imageId: IMAGE_1, image: "coach-app" }],
			["db", { imageId: IMAGE_3, image: "postgres:17-alpine" }],
		]);
	});
});

describe("matchesRunning", () => {
	const recorded = [
		{ service: "app", imageId: IMAGE_1 },
		{ service: "db", imageId: IMAGE_3 },
		{ service: "migrate", imageId: IMAGE_2 },
	];

	it("matches when every running service runs its recorded image", () => {
		const running = new Map([
			["app", { imageId: IMAGE_1 }],
			["db", { imageId: IMAGE_3 }],
		]);
		expect(matchesRunning(recorded, running)).toBe(true);
	});

	it("does not match a different image or an unrecorded service", () => {
		expect(
			matchesRunning(recorded, new Map([["app", { imageId: IMAGE_2 }]])),
		).toBe(false);
		expect(
			matchesRunning(
				recorded,
				new Map([
					["app", { imageId: IMAGE_1 }],
					["cache", { imageId: IMAGE_2 }],
				]),
			),
		).toBe(false);
	});

	it("never matches nothing", () => {
		expect(matchesRunning([], new Map([["app", { imageId: IMAGE_1 }]]))).toBe(
			false,
		);
		expect(matchesRunning(recorded, new Map())).toBe(false);
	});
});

describe("pinComposeImages", () => {
	it("points each recorded service at its retained tag and stops pulls", () => {
		const spec = {
			services: {
				app: { build: { context: "." }, pull_policy: "build" },
				db: { image: "postgres:17-alpine", pull_policy: "always" },
				extra: { image: "redis:7" },
			} as Record<string, Record<string, unknown>>,
		};
		const untouched = pinComposeImages(spec, [
			{
				service: "app",
				image: "x-app",
				imageId: IMAGE_1,
				tag: "dv/x:dpl-1-app",
			},
			{
				service: "db",
				image: "postgres:17-alpine",
				imageId: IMAGE_3,
				tag: "dv/x:dpl-1-db",
			},
			{ service: "gone", image: "y", imageId: IMAGE_2, tag: "dv/x:dpl-1-gone" },
		]);
		expect(spec.services.app).toEqual({
			build: { context: "." },
			image: "dv/x:dpl-1-app",
		});
		expect(spec.services.db).toEqual({ image: "dv/x:dpl-1-db" });
		expect(untouched).toEqual(["extra"]);
	});
});

describe("buildComposeRunCommand", () => {
	const compose = {
		serverId: null,
		appName: "coach-abc",
		sourceType: "github" as const,
		composePath: "./deploy/docker-compose.yml",
		createEnvFile: true,
		isolatedDeployment: false,
		mounts: [],
	};

	it("runs the retained file without building or pulling", () => {
		const command = buildComposeRunCommand({
			compose,
			runFile: `${ROOT}/versions/run-d2.yml`,
			envCommand: "ENV",
		});
		expect(command).toContain(
			`docker compose -p coach-abc --project-directory ${ROOT}/code/deploy --env-file ${ROOT}/code/deploy/.env -f ${ROOT}/versions/run-d2.yml up -d --no-build --pull never --remove-orphans`,
		);
		expect(command).toContain("ENV");
		expect(command).not.toContain("--build ");
		expect(command).not.toContain("docker network");
	});

	it("resolves from the code root when the stack has mounts, and joins the isolated network", () => {
		const command = buildComposeRunCommand({
			compose: {
				...compose,
				mounts: [{}],
				isolatedDeployment: true,
				createEnvFile: false,
			},
			runFile: "/r.yml",
			envCommand: "",
		});
		expect(command).toContain(`--project-directory ${ROOT}/code -f /r.yml`);
		expect(command).toContain("docker network create --attachable coach-abc");
		expect(command).toContain("docker network connect coach-abc");
	});
});

describe("composeRollbackUnavailableReason", () => {
	it("supports plain docker-compose stacks only", () => {
		expect(
			composeRollbackUnavailableReason({
				composeType: "docker-compose",
				command: "",
			}),
		).toBeNull();
		expect(
			composeRollbackUnavailableReason({ composeType: "stack", command: "" }),
		).toMatch(/Swarm/);
		expect(
			composeRollbackUnavailableReason({
				composeType: "docker-compose",
				command: "compose -f a.yml up -d",
			}),
		).toMatch(/custom compose command/);
	});
});
