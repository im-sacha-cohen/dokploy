import { newerVersionTags } from "@dokploy/server/auto-update/app-check";
import {
	composeBuilds,
	parseGitContext,
} from "@dokploy/server/smart-deploy/versioning/compose-builds";
import { getImageVersions } from "@dokploy/server/smart-deploy/versioning/image-versions";
import {
	compareTagsDesc,
	describeCommit,
	type GitVersionData,
	newerThan,
	parseLsRemoteTags,
} from "@dokploy/server/smart-deploy/versioning/releases";
import { afterEach, describe, expect, it, vi } from "vitest";

const sha = (n: number) => n.toString(16).padStart(40, "0");

// Branch history, newest first: c(0) is the head.
const commits = Array.from({ length: 8 }, (_, i) => ({
	sha: sha(100 - i),
	message: `commit ${8 - i}`,
	author: "dev",
	date: `2026-11-${String(20 - i).padStart(2, "0")}T10:00:00Z`,
}));
const c = (i: number) => commits[i]?.sha as string;

const data = (
	overrides: Partial<Extract<GitVersionData, { status: "ok" }>> = {},
): Extract<GitVersionData, { status: "ok" }> => ({
	status: "ok",
	branch: "main",
	commits,
	tags: [
		{ name: "v1.2.0", sha: c(1), date: null },
		{ name: "v1.1.0", sha: c(4), date: null },
		{ name: "v1.0.0", sha: c(7), date: null },
	],
	releases: [
		{
			tag: "v1.2.0",
			name: "Spring",
			notes: "## New\n- things",
			publishedAt: "2026-11-19T12:00:00Z",
			prerelease: false,
			url: "https://x/v1.2.0",
		},
		{
			tag: "v1.1.0",
			name: null,
			notes: "fixes",
			publishedAt: "2026-11-16T12:00:00Z",
			prerelease: false,
			url: null,
		},
		{
			tag: "v1.0.0",
			name: null,
			notes: null,
			publishedAt: "2026-11-13T12:00:00Z",
			prerelease: false,
			url: null,
		},
	],
	releasesSupported: true,
	...overrides,
});

describe("Git version names", () => {
	it("reads ls-remote tags, using the commit of annotated tags", () => {
		const out = [
			`${sha(1)}\trefs/tags/v1.0.0`,
			`${sha(2)}\trefs/tags/v2.0.0`,
			`${sha(3)}\trefs/tags/v2.0.0^{}`,
			`${sha(4)}\trefs/heads/main`,
			"garbage",
		].join("\n");
		expect(parseLsRemoteTags(out)).toEqual([
			{ name: "v1.0.0", sha: sha(1), date: null },
			{ name: "v2.0.0", sha: sha(3), date: null },
		]);
	});

	it("sorts versions numerically, releases before their pre-releases", () => {
		expect(
			["v1.9.0", "v1.10.0", "v1.10.0-rc1", "nightly", "v2"].sort(
				compareTagsDesc,
			),
		).toEqual(["v2", "v1.10.0", "v1.10.0-rc1", "v1.9.0", "nightly"]);
	});

	it("names a tagged commit by its tag", () => {
		expect(describeCommit(c(4), data()).label).toBe("v1.1.0");
	});

	it("names a later commit by the tag before it plus the commits since", () => {
		expect(describeCommit(c(2), data())).toMatchObject({
			tag: "v1.1.0",
			distance: 2,
			label: "v1.1.0 + 2 commits",
		});
		expect(describeCommit(c(0), data()).label).toBe("v1.2.0 + 1 commit");
	});

	it("keeps the short SHA when no tag is found, rather than guessing", () => {
		expect(describeCommit(sha(5), data()).label).toBe(
			`main @ ${sha(5).slice(0, 7)}`,
		);
		expect(describeCommit(c(0), data({ tags: [] })).label).toBe(
			`main @ ${c(0).slice(0, 7)}`,
		);
	});
});

describe("What came after the running version", () => {
	it("lists the newer releases and commits, not the running one", () => {
		const newer = newerThan(c(4), data(), commits[4]?.date ?? null);
		expect(newer.versions.map((v) => v.tag)).toEqual(["v1.2.0"]);
		expect(newer.versions[0]).toMatchObject({
			notes: "## New\n- things",
			sha: c(1),
			onBranch: true,
		});
		expect(newer.commits.map((x) => x.sha)).toEqual([c(0), c(1), c(2), c(3)]);
		expect(newer.moreCommits).toBe(false);
	});

	it("has nothing newer at the head", () => {
		const newer = newerThan(c(0), data(), commits[0]?.date ?? null);
		expect(newer.versions).toEqual([]);
		expect(newer.commits).toEqual([]);
	});

	it("counts a release off the branch as newer only when dated after", () => {
		const offBranch = data({
			tags: [...data().tags, { name: "v1.1.1", sha: sha(999), date: null }],
			releases: [
				...data().releases,
				{
					tag: "v1.1.1",
					name: null,
					notes: "backport",
					publishedAt: "2026-11-18T00:00:00Z",
					prerelease: false,
					url: null,
				},
			],
		});
		const tags = newerThan(c(4), offBranch, commits[4]?.date ?? null).versions;
		expect(tags.map((v) => v.tag)).toEqual(["v1.2.0", "v1.1.1"]);
		expect(tags.find((v) => v.tag === "v1.1.1")?.onBranch).toBe(false);
	});

	it("says there are more commits when the running one is older than those read", () => {
		const newer = newerThan(sha(5), data(), "2026-10-01T00:00:00Z");
		expect(newer.moreCommits).toBe(true);
		expect(newer.commits).toHaveLength(commits.length);
		expect(newer.versions.map((v) => v.tag)).toEqual([
			"v1.2.0",
			"v1.1.0",
			"v1.0.0",
		]);
	});

	it("uses tags when the Git host has no releases", () => {
		const newer = newerThan(
			c(7),
			data({ releases: [], releasesSupported: false }),
			commits[7]?.date ?? null,
		);
		expect(newer.versions.map((v) => [v.tag, v.notes])).toEqual([
			["v1.2.0", null],
			["v1.1.0", null],
		]);
	});
});

describe("Image tags", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("lists newer tags written the same way, highest first", () => {
		expect(
			newerVersionTags("1.25.3-alpine", [
				"1.25.4-alpine",
				"1.26.0-alpine",
				"1.25.4",
				"1.25.2-alpine",
				"latest",
			]),
		).toEqual(["1.26.0-alpine", "1.25.4-alpine"]);
	});

	const hub = (
		results: { name: string; digest: string; tag_last_pushed: string }[],
	) =>
		vi.fn(async (url: string | URL) => {
			if (String(url).startsWith("https://hub.docker.com/")) {
				return new Response(JSON.stringify({ results, next: null }));
			}
			throw new Error(`unexpected request ${String(url)}`);
		});

	it("reads newer versions and their dates from Docker Hub", async () => {
		vi.stubGlobal(
			"fetch",
			hub([
				{
					name: "5.83.0",
					digest: "sha256:c",
					tag_last_pushed: "2026-11-20T00:00:00Z",
				},
				{
					name: "5.82.1",
					digest: "sha256:b",
					tag_last_pushed: "2026-11-10T00:00:00Z",
				},
				{
					name: "5.82.0",
					digest: "sha256:a",
					tag_last_pushed: "2026-11-01T00:00:00Z",
				},
				{
					name: "latest",
					digest: "sha256:c",
					tag_last_pushed: "2026-11-20T00:00:00Z",
				},
			]),
		);
		const result = await getImageVersions("ghost:5.82.0", {
			runningDigest: "sha256:a",
		});
		expect(result).toMatchObject({
			status: "ok",
			isVersion: true,
			rebuilt: false,
			newer: [
				{ tag: "5.83.0", date: "2026-11-20T00:00:00Z" },
				{ tag: "5.82.1", date: "2026-11-10T00:00:00Z" },
			],
		});
	});

	it("tells which version latest is, and that it moved since it was pulled", async () => {
		vi.stubGlobal(
			"fetch",
			hub([
				{
					name: "latest",
					digest: "sha256:c",
					tag_last_pushed: "2026-11-20T00:00:00Z",
				},
				{
					name: "5.83.0",
					digest: "sha256:c",
					tag_last_pushed: "2026-11-20T00:00:00Z",
				},
				{
					name: "5.82.0",
					digest: "sha256:a",
					tag_last_pushed: "2026-11-01T00:00:00Z",
				},
			]),
		);
		const result = await getImageVersions("ghost", {
			runningDigest: "sha256:a",
		});
		expect(result).toMatchObject({
			status: "ok",
			tag: "latest",
			isVersion: false,
			sameAs: ["5.83.0"],
			rebuilt: true,
			newer: [],
		});
	});

	it("does not apply to an image pinned by digest only", async () => {
		expect(
			await getImageVersions(`ghost@sha256:${"a".repeat(64)}`),
		).toMatchObject({
			status: "not_applicable",
		});
	});
});

describe("Compose services built from Git", () => {
	it("reads Docker's remote Git contexts", () => {
		expect(
			parseGitContext(
				"https://github.com/im-sacha-cohen/sftpgo.git#feat/console-ui",
			),
		).toEqual({
			url: "https://github.com/im-sacha-cohen/sftpgo.git",
			ref: "feat/console-ui",
			subdir: null,
		});
		expect(parseGitContext("https://github.com/a/b.git#v1.2.0:docker")).toEqual(
			{
				url: "https://github.com/a/b.git",
				ref: "v1.2.0",
				subdir: "docker",
			},
		);
		expect(parseGitContext("git@github.com:a/b.git")).toMatchObject({
			ref: null,
		});
		expect(parseGitContext("github.com/a/b")).toMatchObject({
			url: "https://github.com/a/b",
		});
	});

	it("does not take local folders or tarballs for Git", () => {
		expect(parseGitContext(".")).toBeNull();
		expect(parseGitContext("./app")).toBeNull();
		expect(parseGitContext("https://example.com/context.tar.gz")).toBeNull();
	});

	it("lists which services build, and from where", () => {
		const file = [
			"services:",
			"  sftpgo:",
			"    build:",
			"      context: https://github.com/im-sacha-cohen/sftpgo.git#feat/console-ui",
			"    image: sftpgo-console:latest",
			"  web:",
			"    build: ./web",
			"  db:",
			"    image: postgres:16",
		].join("\n");
		expect(composeBuilds(file)).toEqual([
			{
				kind: "git",
				service: "sftpgo",
				url: "https://github.com/im-sacha-cohen/sftpgo.git",
				ref: "feat/console-ui",
				subdir: null,
			},
			{ kind: "local", service: "web" },
		]);
		expect(composeBuilds("not: [valid")).toEqual([]);
	});

	it("without the built commit, counts the commits dated after the deployment", () => {
		const newer = newerThan(null, data(), "2026-11-17T12:00:00Z");
		expect(newer.commits.map((x) => x.sha)).toEqual([c(0), c(1), c(2)]);
		expect(newer.moreCommits).toBe(false);
	});
});
