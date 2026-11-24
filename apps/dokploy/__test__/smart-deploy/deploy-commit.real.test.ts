import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutCommitCommand } from "@dokploy/server/utils/providers/checkout-commit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.test",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.test",
		},
	}).trim();

describe("REAL checkout of a commit after a shallow clone", () => {
	let root: string;
	let remote: string;
	const commits: string[] = [];

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "deploy-commit-"));
		const work = join(root, "work");
		remote = join(root, "remote.git");
		execFileSync("git", ["init", "-q", "-b", "main", work]);
		for (const version of ["v1", "v2", "v3"]) {
			writeFileSync(join(work, "version.txt"), version);
			git(work, "add", ".");
			git(work, "commit", "-q", "-m", version);
			commits.push(git(work, "rev-parse", "HEAD"));
		}
		execFileSync("git", ["clone", "-q", "--bare", work, remote]);
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const cloneAndCheckout = (name: string, commitSha: string) => {
		const outputPath = join(root, name);
		const script = `set -e;
git clone -q --branch main --depth 1 ${`file://${remote}`} ${outputPath};
${checkoutCommitCommand({ outputPath, commitSha })}`;
		const result = spawnSync("sh", ["-c", script], { encoding: "utf8" });
		return { outputPath, ...result };
	};

	it("checks out an older commit from its full SHA", () => {
		const run = cloneAndCheckout("full", commits[0] as string);
		expect(run.status).toBe(0);
		expect(git(run.outputPath, "rev-parse", "HEAD")).toBe(commits[0]);
		expect(git(run.outputPath, "show", "HEAD:version.txt")).toBe("v1");
	});

	it("checks out an older commit from a short SHA", () => {
		const run = cloneAndCheckout("short", (commits[1] as string).slice(0, 7));
		expect(run.status).toBe(0);
		expect(git(run.outputPath, "rev-parse", "HEAD")).toBe(commits[1]);
	});

	it("fails the deployment on an unknown commit", () => {
		const run = cloneAndCheckout(
			"unknown",
			"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
		);
		expect(run.status).not.toBe(0);
		expect(run.stdout).toContain("was not found in the repository");
		expect(run.stderr).not.toContain("fatal:");
	});
});
