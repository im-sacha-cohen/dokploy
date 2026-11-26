import { findBitbucketById } from "@dokploy/server/services/bitbucket";
import { findGiteaById } from "@dokploy/server/services/gitea";
import { findGithubById } from "@dokploy/server/services/github";
import { findGitlabById } from "@dokploy/server/services/gitlab";
import { getBitbucketHeaders } from "@dokploy/server/utils/providers/bitbucket";
import { refreshGiteaToken } from "@dokploy/server/utils/providers/gitea";
import { authGithub } from "@dokploy/server/utils/providers/github";
import { refreshGitlabToken } from "@dokploy/server/utils/providers/gitlab";
import { withTimeout } from "../diagnostics/collect/docker-io";
import {
	type CommitSource,
	GITEA_PAGE_MAX,
	getJson,
	gitCloneLogCommand,
	listRemoteCommits,
	PROVIDER_TIMEOUT_MS,
	parseGitLog,
	type RemoteCommit,
} from "./commits";
import { runOn, SHA_PATTERN } from "./shell";
import { describeSource } from "./source";

/** Commits of the branch read to name versions: a tag further back is not seen. */
export const HISTORY_LIMIT = 100;
const RELEASES_LIMIT = 30;
const NOTES_MAX = 20_000;

export interface GitTag {
	name: string;
	/** Commit the tag points to (annotated tags are peeled). */
	sha: string;
	date: string | null;
}

export interface GitRelease {
	tag: string;
	name: string | null;
	/** Release notes, Markdown as written on the Git host. */
	notes: string | null;
	publishedAt: string | null;
	prerelease: boolean;
	url: string | null;
}

export type GitVersionData =
	| {
			status: "ok";
			branch: string;
			/** Branch history, newest first, at most HISTORY_LIMIT commits. */
			commits: RemoteCommit[];
			tags: GitTag[];
			releases: GitRelease[];
			/** Releases need a Git host API: none for custom Git URLs and Bitbucket. */
			releasesSupported: boolean;
	  }
	| { status: "error"; reason: string }
	| { status: "not_applicable"; reason: string };

const clip = (text: string | null | undefined) =>
	text ? text.slice(0, NOTES_MAX) : null;

const TAGS_MARKER = "--dokploy-tags--";

/** `git ls-remote --tags` output; `^{}` lines give the commit of annotated tags. */
export const parseLsRemoteTags = (stdout: string): GitTag[] => {
	const bySha = new Map<string, string>();
	const peeled = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const [sha, ref] = line.trim().split(/\s+/);
		if (!sha || !ref?.startsWith("refs/tags/") || !SHA_PATTERN.test(sha)) {
			continue;
		}
		const name = ref.slice("refs/tags/".length);
		if (name.endsWith("^{}")) peeled.set(name.slice(0, -3), sha);
		else bySha.set(name, sha);
	}
	return [...bySha].map(([name, sha]) => ({
		name,
		sha: peeled.get(name) ?? sha,
		date: null,
	}));
};

const fromProvider = async (
	source: CommitSource,
): Promise<{ tags: GitTag[]; releases: GitRelease[] }> => {
	switch (source.sourceType) {
		case "github": {
			if (!source.githubId) throw new Error("no GitHub provider");
			const octokit = authGithub(await findGithubById(source.githubId));
			const repo = { owner: source.owner ?? "", repo: source.repository ?? "" };
			const [tags, releases] = await Promise.all([
				octokit.rest.repos.listTags({ ...repo, per_page: 100 }),
				octokit.rest.repos.listReleases({ ...repo, per_page: RELEASES_LIMIT }),
			]);
			return {
				tags: tags.data.map((t) => ({
					name: t.name,
					sha: t.commit.sha,
					date: null,
				})),
				releases: releases.data
					.filter((r) => !r.draft)
					.map((r) => ({
						tag: r.tag_name,
						name: r.name ?? null,
						notes: clip(r.body),
						publishedAt: r.published_at ?? null,
						prerelease: r.prerelease,
						url: r.html_url,
					})),
			};
		}
		case "gitlab": {
			if (!source.gitlabId || !source.gitlabProjectId) {
				throw new Error("no GitLab project");
			}
			await refreshGitlabToken(source.gitlabId);
			const gitlab = await findGitlabById(source.gitlabId);
			const base = `${(gitlab.gitlabInternalUrl || gitlab.gitlabUrl).replace(/\/+$/, "")}/api/v4/projects/${source.gitlabProjectId}`;
			const headers = { Authorization: `Bearer ${gitlab.accessToken}` };
			const [tags, releases] = (await Promise.all([
				getJson(`${base}/repository/tags?per_page=100`, headers),
				getJson(`${base}/releases?per_page=${RELEASES_LIMIT}`, headers),
			])) as [
				{
					name: string;
					commit?: { id?: string; committed_date?: string };
				}[],
				{
					tag_name: string;
					name?: string;
					description?: string;
					released_at?: string;
					upcoming_release?: boolean;
					_links?: { self?: string };
				}[],
			];
			return {
				tags: tags.map((t) => ({
					name: t.name,
					sha: t.commit?.id ?? "",
					date: t.commit?.committed_date ?? null,
				})),
				releases: releases.map((r) => ({
					tag: r.tag_name,
					name: r.name ?? null,
					notes: clip(r.description),
					publishedAt: r.released_at ?? null,
					prerelease: !!r.upcoming_release,
					url: r._links?.self ?? null,
				})),
			};
		}
		case "gitea": {
			if (!source.giteaId) throw new Error("no Gitea provider");
			await refreshGiteaToken(source.giteaId);
			const gitea = await findGiteaById(source.giteaId);
			const base = `${(gitea.giteaInternalUrl || gitea.giteaUrl).replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(source.giteaOwner ?? "")}/${encodeURIComponent(source.giteaRepository ?? "")}`;
			const headers = { Authorization: `token ${gitea.accessToken}` };
			const [tags, releases] = (await Promise.all([
				getJson(`${base}/tags?limit=${GITEA_PAGE_MAX}`, headers),
				getJson(`${base}/releases?limit=${RELEASES_LIMIT}`, headers),
			])) as [
				{ name: string; commit?: { sha?: string; created?: string } }[],
				{
					tag_name: string;
					name?: string;
					body?: string;
					published_at?: string;
					draft?: boolean;
					prerelease?: boolean;
					html_url?: string;
				}[],
			];
			return {
				tags: tags.map((t) => ({
					name: t.name,
					sha: t.commit?.sha ?? "",
					date: t.commit?.created ?? null,
				})),
				releases: releases
					.filter((r) => !r.draft)
					.map((r) => ({
						tag: r.tag_name,
						name: r.name ?? null,
						notes: clip(r.body),
						publishedAt: r.published_at ?? null,
						prerelease: !!r.prerelease,
						url: r.html_url ?? null,
					})),
			};
		}
		case "bitbucket": {
			if (!source.bitbucketId) throw new Error("no Bitbucket provider");
			const bitbucket = await findBitbucketById(source.bitbucketId);
			const repo =
				source.bitbucketRepositorySlug || source.bitbucketRepository || "";
			const data = (await getJson(
				`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(source.bitbucketOwner ?? "")}/${encodeURIComponent(repo)}/refs/tags?pagelen=100&sort=-target.date`,
				getBitbucketHeaders(bitbucket),
			)) as {
				values: { name: string; target?: { hash?: string; date?: string } }[];
			};
			return {
				tags: data.values.map((t) => ({
					name: t.name,
					sha: t.target?.hash ?? "",
					date: t.target?.date ?? null,
				})),
				releases: [],
			};
		}
		default:
			return { tags: [], releases: [] };
	}
};

/** Branch history, tags and releases: what versions are named from. */
export const getGitVersionData = async (
	source: CommitSource,
): Promise<GitVersionData> => {
	const described = describeSource(source);
	if (!described.isGit) {
		return { status: "not_applicable", reason: "not a Git repository" };
	}
	const branch = described.branch;
	if (!branch)
		return { status: "not_applicable", reason: "no branch configured" };

	if (source.sourceType === "git") {
		const serverId = source.buildServerId || source.serverId;
		const result = await runOn(
			serverId,
			await gitCloneLogCommand(source, branch, serverId, HISTORY_LIMIT, [
				`echo ${TAGS_MARKER}`,
				`GIT_TERMINAL_PROMPT=0 timeout 30 git -C "$DIR/repo" ls-remote --tags origin`,
			]),
		);
		const [log = "", tags = ""] = result.stdout.split(TAGS_MARKER);
		const commits = parseGitLog(log);
		if (!result.ok || commits.length === 0) {
			return {
				status: "error",
				// stderr may echo the command, which can contain key material.
				reason: "git clone failed (network, authentication or unknown branch)",
			};
		}
		return {
			status: "ok",
			branch,
			commits,
			tags: parseLsRemoteTags(tags),
			releases: [],
			releasesSupported: false,
		};
	}

	const [history, refs] = await Promise.all([
		listRemoteCommits(source, HISTORY_LIMIT),
		withTimeout(
			fromProvider(source),
			PROVIDER_TIMEOUT_MS,
			"provider tags",
		).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		),
	]);
	if (history.status !== "ok") return history;
	if (!refs.ok) {
		const message =
			refs.error instanceof Error
				? refs.error.message.slice(0, 200)
				: "unknown";
		return {
			status: "error",
			reason: `${source.sourceType} API error while reading tags: ${message}`,
		};
	}
	return {
		status: "ok",
		branch,
		commits: history.commits,
		tags: refs.value.tags.filter((t) => SHA_PATTERN.test(t.sha)),
		releases: refs.value.releases,
		releasesSupported: source.sourceType !== "bitbucket",
	};
};

interface ParsedVersion {
	numbers: number[];
	pre: boolean;
}

const parseVersion = (tag: string): ParsedVersion | null => {
	const match = /^[^\d]*(\d+(?:\.\d+)*)(.*)$/.exec(tag);
	if (!match?.[1]) return null;
	return {
		numbers: match[1].split(".").map(Number),
		pre: /^[-.]?(alpha|beta|rc|pre|dev|canary|next|nightly)/i.test(
			match[2] ?? "",
		),
	};
};

/** Newer version first; tags that are not versions sort last, by name. */
export const compareTagsDesc = (a: string, b: string) => {
	const va = parseVersion(a);
	const vb = parseVersion(b);
	if (!va || !vb) return va ? -1 : vb ? 1 : b.localeCompare(a);
	for (let i = 0; i < Math.max(va.numbers.length, vb.numbers.length); i++) {
		const diff = (vb.numbers[i] ?? 0) - (va.numbers[i] ?? 0);
		if (diff !== 0) return diff;
	}
	if (va.pre !== vb.pre) return va.pre ? 1 : -1;
	return b.localeCompare(a);
};

export interface CommitVersion {
	sha: string;
	/** Tag on this commit, or the nearest one before it on the branch. */
	tag: string | null;
	/** Commits between `tag` and `sha`; 0 when the tag is on the commit. */
	distance: number | null;
	/** "v1.4.2", "v1.4.2 + 3 commits" or "main @ abc1234". */
	label: string;
}

const tagsBySha = (tags: GitTag[]) => {
	const map = new Map<string, string>();
	for (const tag of [...tags].sort((a, b) => compareTagsDesc(a.name, b.name))) {
		if (!map.has(tag.sha)) map.set(tag.sha, tag.name);
	}
	return map;
};

/**
 * Names a commit from the tags of its branch. Only the commits read
 * (HISTORY_LIMIT) are walked: past them, the commit keeps its short SHA
 * rather than a guessed version.
 */
export const describeCommit = (
	sha: string,
	data: Pick<
		Extract<GitVersionData, { status: "ok" }>,
		"branch" | "commits" | "tags"
	>,
): CommitVersion => {
	const byCommit = tagsBySha(data.tags);
	const plain = `${data.branch} @ ${sha.slice(0, 7)}`;
	const exact = byCommit.get(sha);
	if (exact) return { sha, tag: exact, distance: 0, label: exact };
	const start = data.commits.findIndex((c) => c.sha === sha);
	if (start === -1) return { sha, tag: null, distance: null, label: plain };
	for (let i = start + 1; i < data.commits.length; i++) {
		const tag = byCommit.get(data.commits[i]?.sha ?? "");
		if (tag) {
			const distance = i - start;
			return {
				sha,
				tag,
				distance,
				label: `${tag} + ${distance} commit${distance > 1 ? "s" : ""}`,
			};
		}
	}
	return { sha, tag: null, distance: null, label: plain };
};

export interface NewerGitVersion {
	tag: string;
	sha: string | null;
	name: string | null;
	notes: string | null;
	date: string | null;
	prerelease: boolean;
	url: string | null;
	/** On the configured branch, so deploying it keeps the branch's history. */
	onBranch: boolean;
}

export interface GitNewer {
	/** Commits after the running one, newest first. */
	commits: RemoteCommit[];
	/** The running commit is older than the commits read: there are more. */
	moreCommits: boolean;
	/** Releases, or tags when the host has no releases, after the running one. */
	versions: NewerGitVersion[];
}

/**
 * What came after `currentSha` on the branch. A tag counts as newer when its
 * commit comes after the running one on the branch, or, for a tag off the
 * branch (release branches), when it is dated after the running commit.
 */
export const newerThan = (
	currentSha: string | null,
	data: Extract<GitVersionData, { status: "ok" }>,
	currentDate: string | null,
): GitNewer => {
	const index = currentSha
		? data.commits.findIndex((c) => c.sha === currentSha)
		: -1;
	const known = index !== -1;
	const since = currentDate ? Date.parse(currentDate) : Number.NaN;
	// Without the running commit, the commits dated after it was deployed.
	const commits = known
		? data.commits.slice(0, index)
		: !currentSha && Number.isFinite(since)
			? data.commits.filter((c) => !c.date || Date.parse(c.date) > since)
			: data.commits;
	const position = new Map(data.commits.map((c, i) => [c.sha, i]));
	const shaOf = new Map(data.tags.map((t) => [t.name, t.sha]));
	const currentTag = currentSha ? tagsBySha(data.tags).get(currentSha) : null;

	const candidates: NewerGitVersion[] = data.releasesSupported
		? data.releases.map((r) => ({
				tag: r.tag,
				sha: shaOf.get(r.tag) ?? null,
				name: r.name,
				notes: r.notes,
				date: r.publishedAt,
				prerelease: r.prerelease,
				url: r.url,
				onBranch: false,
			}))
		: data.tags.map((t) => ({
				tag: t.name,
				sha: t.sha,
				name: null,
				notes: null,
				date: t.date ?? data.commits.find((c) => c.sha === t.sha)?.date ?? null,
				prerelease: parseVersion(t.name)?.pre ?? false,
				url: null,
				onBranch: false,
			}));

	const versions = candidates
		.map((v) => ({
			...v,
			onBranch: v.sha !== null && position.has(v.sha),
		}))
		.filter((v) => {
			if (v.tag === currentTag) return false;
			const at = v.sha === null ? undefined : position.get(v.sha);
			if (at !== undefined && known) return at < index;
			const date = v.date ? Date.parse(v.date) : Number.NaN;
			if (Number.isFinite(since) && Number.isFinite(date)) return date > since;
			// Nothing runs, or it runs from before the commits read: on the branch is newer.
			return at !== undefined;
		})
		.sort((a, b) => compareTagsDesc(a.tag, b.tag))
		.slice(0, RELEASES_LIMIT);

	return {
		commits,
		moreCommits: !!currentSha && !known,
		versions,
	};
};
