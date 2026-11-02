import type { DeploymentVerification } from "@dokploy/server/db/schema";
import { runDiagnostics } from "@dokploy/server/smart-deploy/diagnostics/engine";
import type {
	DiagnosticContext,
	TrackedDeploymentFact,
} from "@dokploy/server/smart-deploy/diagnostics/types";
import {
	describeSource,
	sanitizeRepositoryUrl,
} from "@dokploy/server/smart-deploy/versioning/source";
import { computeVerificationStatus } from "@dokploy/server/smart-deploy/versioning/verify";
import { describe, expect, it } from "vitest";

const IMAGE_1 = `sha256:${"1".repeat(64)}`;
const IMAGE_2 = `sha256:${"2".repeat(64)}`;
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const tracked = (
	overrides: Partial<TrackedDeploymentFact>,
): TrackedDeploymentFact => ({
	deploymentId: "dep1",
	createdAt: "2026-11-02T10:00:00.000Z",
	status: "done",
	kind: "deploy_latest",
	imageId: IMAGE_1,
	imageTag: "app:dpl-dep1",
	builtCommitSha: SHA_A,
	...overrides,
});

const context = (overrides: Partial<DiagnosticContext>): DiagnosticContext => ({
	now: new Date("2026-11-02T12:00:00.000Z"),
	target: {
		type: "application",
		id: "app",
		name: "app",
		appName: "app",
		serverId: null,
	},
	config: {
		domains: [],
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
		},
	],
	container: {
		id: "c1",
		imageId: IMAGE_1,
		startedAt: "2026-11-02T11:00:00.000Z",
		uptimeSeconds: 3600,
		health: { status: "healthy", failingStreak: 0 },
	},
	collectionErrors: [],
	...overrides,
});

const codes = (ctx: DiagnosticContext) =>
	runDiagnostics(ctx).findings.map((f) => f.code);

describe("version rules", () => {
	it("GIT_COMMIT_OUTDATED only when the remote head was actually checked", () => {
		const running = tracked({});
		expect(
			codes(
				context({
					version: {
						latest: running,
						running,
						remoteHead: {
							status: "ok",
							sha: SHA_B,
							branch: "main",
							checkedAt: "t",
						},
					},
				}),
			),
		).toEqual(["GIT_COMMIT_OUTDATED"]);
		expect(
			codes(
				context({
					version: {
						latest: running,
						running,
						remoteHead: { status: "error", reason: "network" },
					},
				}),
			),
		).toEqual([]);
		expect(codes(context({ version: { latest: running, running } }))).toEqual(
			[],
		);
		expect(
			codes(
				context({
					version: {
						latest: running,
						running,
						remoteHead: {
							status: "ok",
							sha: SHA_A,
							branch: "main",
							checkedAt: "t",
						},
					},
				}),
			),
		).toEqual([]);
	});

	it("GIT_COMMIT_OUTDATED proposes deploy_latest", () => {
		const running = tracked({});
		const finding = runDiagnostics(
			context({
				version: {
					latest: running,
					running,
					remoteHead: {
						status: "ok",
						sha: SHA_B,
						branch: "main",
						checkedAt: "t",
					},
				},
			}),
		).findings[0];
		expect(finding?.recommendedFix.action).toEqual({ kind: "deploy_latest" });
		expect(finding?.risk).toBe("medium");
	});

	it("IMAGE_VERSION_MISMATCH when the latest successful image is not the running one", () => {
		const latest = tracked({
			deploymentId: "dep2",
			imageId: IMAGE_2,
			imageTag: "app:dpl-dep2",
		});
		const report = runDiagnostics(
			context({ version: { latest, running: tracked({}) } }),
		);
		expect(report.findings.map((f) => f.code)).toEqual([
			"IMAGE_VERSION_MISMATCH",
		]);
		expect(report.findings[0]?.recommendedFix.action).toEqual({
			kind: "redeploy_deployment",
			deploymentId: "dep2",
		});
	});

	it("no IMAGE_VERSION_MISMATCH while a deployment is running or untracked", () => {
		expect(
			codes(
				context({
					version: {
						latest: tracked({ status: "running", imageId: IMAGE_2 }),
						running: null,
					},
				}),
			),
		).toEqual([]);
		expect(
			codes(
				context({
					version: { latest: tracked({ imageId: null }), running: null },
				}),
			),
		).toEqual([]);
	});
});

const verification = (
	stages: Partial<DeploymentVerification["stages"]>,
): DeploymentVerification => ({
	startedAt: "t",
	stages: {
		build: { status: "passed" },
		containerCreated: { status: "passed" },
		containerRunning: { status: "passed" },
		healthy: { status: "passed" },
		reachable: { status: "passed" },
		...stages,
	},
});

describe("computeVerificationStatus", () => {
	it("distinguishes each level", () => {
		expect(computeVerificationStatus(verification({}))).toBe("healthy");
		expect(
			computeVerificationStatus(
				verification({ healthy: { status: "not_applicable" } }),
			),
		).toBe("running");
		expect(
			computeVerificationStatus(
				verification({ reachable: { status: "failed" } }),
			),
		).toBe("degraded");
		expect(
			computeVerificationStatus(
				verification({ healthy: { status: "failed" } }),
			),
		).toBe("degraded");
		expect(
			computeVerificationStatus(
				verification({ containerRunning: { status: "failed" } }),
			),
		).toBe("failed");
		expect(
			computeVerificationStatus(verification({ build: { status: "failed" } })),
		).toBe("failed");
		expect(
			computeVerificationStatus(
				verification({ containerRunning: { status: "skipped" } }),
			),
		).toBe("unknown");
	});

	it("never reports healthy when reachability could not be checked", () => {
		expect(
			computeVerificationStatus(
				verification({ reachable: { status: "skipped" } }),
			),
		).toBe("running");
	});
});

describe("source description", () => {
	it("strips credentials from repository URLs", () => {
		expect(
			sanitizeRepositoryUrl("https://user:ghp_secret@github.com/org/repo.git"),
		).toBe("https://github.com/org/repo.git");
		expect(sanitizeRepositoryUrl("http://127.0.0.1:4040/e.git")).toBe(
			"http://127.0.0.1:4040/e.git",
		);
		expect(sanitizeRepositoryUrl("git@github.com:org/repo.git")).toBe(
			"git@github.com:org/repo.git",
		);
	});

	it("describes git and non-git sources", () => {
		const base = {
			owner: null,
			repository: null,
			branch: null,
			gitlabOwner: null,
			gitlabRepository: null,
			gitlabBranch: null,
			giteaOwner: null,
			giteaRepository: null,
			giteaBranch: null,
			bitbucketOwner: null,
			bitbucketRepository: null,
			bitbucketRepositorySlug: null,
			bitbucketBranch: null,
			customGitUrl: null,
			customGitBranch: null,
			dockerImage: null,
		};
		expect(
			describeSource({
				...base,
				sourceType: "github",
				owner: "org",
				repository: "repo",
				branch: "main",
			}),
		).toEqual({ repository: "github:org/repo", branch: "main", isGit: true });
		expect(
			describeSource({
				...base,
				sourceType: "git",
				customGitUrl: "https://u:p@h/r.git",
				customGitBranch: "dev",
			}),
		).toEqual({ repository: "https://h/r.git", branch: "dev", isGit: true });
		expect(
			describeSource({ ...base, sourceType: "docker", dockerImage: "nginx:1" })
				.isGit,
		).toBe(false);
	});
});

describe("verdict and version freshness", () => {
	it("an outdated but working app stays healthy", () => {
		const running = tracked({});
		const report = runDiagnostics(
			context({
				version: {
					latest: running,
					running,
					remoteHead: {
						status: "ok",
						sha: SHA_B,
						branch: "main",
						checkedAt: "t",
					},
				},
			}),
		);
		expect(report.findings.map((f) => f.code)).toEqual(["GIT_COMMIT_OUTDATED"]);
		expect(report.verdict).toBe("healthy");
	});
});
