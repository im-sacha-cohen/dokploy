import { describe, expect, it, vi } from "vitest";

vi.mock("@dokploy/server/services/github", () => ({
	findGithubById: vi.fn(async () => ({
		githubId: "gh-1",
		githubUrl: "https://github.com",
		githubAppId: 1,
		githubPrivateKey: "key",
		githubInstallationId: "42",
	})),
}));
vi.mock("@octokit/auth-app", () => ({ createAppAuth: vi.fn() }));
vi.mock("octokit", () => ({
	Octokit: class {
		auth = async () => ({ token: "gh-token" });
	},
}));

const { checkoutCommitCommand, COMMIT_REF_PATTERN, normalizeCommitRef } =
	await import("@dokploy/server/utils/providers/checkout-commit");
const { cloneGithubRepository } = await import(
	"@dokploy/server/utils/providers/github"
);

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("checkoutCommitCommand", () => {
	it("adds nothing without a commit", () => {
		expect(checkoutCommitCommand({ outputPath: "/code" })).toBe("");
		expect(
			checkoutCommitCommand({ outputPath: "/code", commitSha: null }),
		).toBe("");
	});

	it("fetches a full SHA alone, then checks it out detached", () => {
		const command = checkoutCommitCommand({
			outputPath: "/code",
			commitSha: SHA,
		});
		expect(command).toContain(`git -C /code fetch --depth 1 origin ${SHA}`);
		expect(command).toContain(`rev-parse --verify --quiet ${SHA}\\^\\{commit\\}`);
		expect(command).toContain('checkout --detach "$dokploy_commit"');
		expect(command).toContain("fetch --unshallow origin");
	});

	it("goes straight to the branch history for a short SHA", () => {
		const command = checkoutCommitCommand({
			outputPath: "/code",
			commitSha: "abc1234",
		});
		expect(command).not.toContain("--depth 1 origin abc1234");
		expect(command).toContain("if ! false; then");
	});

	it("refuses anything that is not a hexadecimal SHA", () => {
		for (const bad of [
			"main",
			"abc12",
			"abc1234; rm -rf /",
			"$(id)",
			"ABC1234",
		]) {
			const command = checkoutCommitCommand({
				outputPath: "/code",
				commitSha: bad,
			});
			expect(command).toMatch(/^echo .*Invalid commit.*; exit 1;$/);
			expect(command).not.toContain("git ");
		}
	});

	it("reuses the token header and updates submodules", () => {
		const command = checkoutCommitCommand({
			outputPath: "/code",
			commitSha: SHA,
			gitAuth:
				"-c 'http.https://github.com/.extraHeader=Authorization: Basic x'",
			enableSubmodules: true,
		});
		expect(command).toContain(
			"git -C /code -c 'http.https://github.com/.extraHeader=Authorization: Basic x' fetch --depth 1",
		);
		expect(command).toContain("submodule update --init --recursive");
	});

	it("normalizes what users paste", () => {
		expect(normalizeCommitRef("  ABC1234\n")).toBe("abc1234");
		expect(COMMIT_REF_PATTERN.test("abc1234")).toBe(true);
		expect(COMMIT_REF_PATTERN.test("a".repeat(41))).toBe(false);
	});
});

describe("clone with a commit", () => {
	it("fetches the commit with the same host-scoped token header as the clone", async () => {
		const command = (
			await cloneGithubRepository({
				appName: "my-app",
				owner: "acme",
				repository: "web",
				branch: "main",
				githubId: "gh-1",
				enableSubmodules: false,
				serverId: null,
				commitSha: SHA,
			})
		).replace(/\\/g, "");
		const header = `http.https://github.com/.extraHeader=Authorization: Basic ${Buffer.from("oauth2:gh-token").toString("base64")}`;
		expect(command).toContain(`${header}' fetch --depth 1 origin ${SHA}`);
		expect(command).not.toContain("gh-token@");
	});

	it("is unchanged without a commit", async () => {
		const command = await cloneGithubRepository({
			appName: "my-app",
			owner: "acme",
			repository: "web",
			branch: "main",
			githubId: "gh-1",
			enableSubmodules: false,
			serverId: null,
		});
		expect(command).not.toContain("checkout --detach");
	});
});
