import { paths } from "@dokploy/server/constants";
import { findBitbucketById } from "@dokploy/server/services/bitbucket";
import { findGiteaById } from "@dokploy/server/services/gitea";
import { findGithubById } from "@dokploy/server/services/github";
import { findGitlabById } from "@dokploy/server/services/gitlab";
import { findSSHKeyById } from "@dokploy/server/services/ssh-key";
import { getBitbucketHeaders } from "@dokploy/server/utils/providers/bitbucket";
import { refreshGiteaToken } from "@dokploy/server/utils/providers/gitea";
import { authGithub } from "@dokploy/server/utils/providers/github";
import { refreshGitlabToken } from "@dokploy/server/utils/providers/gitlab";
import { quote } from "shell-quote";
import { withTimeout } from "../diagnostics/collect/docker-io";
import { runOn, SHA_PATTERN } from "./shell";
import { describeSource } from "./source";

export const COMMITS_LIMIT = 30;
/** Gitea caps its pages at 50 items by default. */
export const GITEA_PAGE_MAX = 50;
export const PROVIDER_TIMEOUT_MS = 15_000;

export interface RemoteCommit {
	sha: string;
	/** First line of the commit message. */
	message: string;
	author: string | null;
	date: string | null;
}

export type RemoteCommits =
	| {
			status: "ok";
			branch: string;
			commits: RemoteCommit[];
			method: "provider_api" | "git_clone";
	  }
	| { status: "error"; reason: string }
	| { status: "not_applicable"; reason: string };

/** The source columns applications and compose stacks share. */
export interface CommitSource {
	sourceType: string;
	serverId: string | null;
	buildServerId?: string | null;
	githubId: string | null;
	owner: string | null;
	repository: string | null;
	branch: string | null;
	gitlabId: string | null;
	gitlabProjectId: number | null;
	gitlabOwner: string | null;
	gitlabRepository: string | null;
	gitlabBranch: string | null;
	giteaId: string | null;
	giteaOwner: string | null;
	giteaRepository: string | null;
	giteaBranch: string | null;
	bitbucketId: string | null;
	bitbucketOwner: string | null;
	bitbucketRepository: string | null;
	bitbucketRepositorySlug: string | null;
	bitbucketBranch: string | null;
	customGitUrl: string | null;
	customGitBranch: string | null;
	customGitSSHKeyId: string | null;
}

export const firstLine = (message: string | null | undefined) =>
	(message ?? "").split("\n")[0]?.trim().slice(0, 200) ?? "";

export const getJson = async (url: string, headers: Record<string, string>) => {
	const response = await fetch(url, {
		headers: { Accept: "application/json", ...headers },
	});
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}
	return response.json();
};

const fromProvider = async (
	source: CommitSource,
	branch: string,
	limit: number,
): Promise<RemoteCommit[]> => {
	switch (source.sourceType) {
		case "github": {
			if (!source.githubId) throw new Error("no GitHub provider");
			const octokit = authGithub(await findGithubById(source.githubId));
			const { data } = await octokit.rest.repos.listCommits({
				owner: source.owner ?? "",
				repo: source.repository ?? "",
				sha: branch,
				per_page: limit,
			});
			return data.map((c) => ({
				sha: c.sha,
				message: firstLine(c.commit.message),
				author: c.commit.author?.name ?? c.author?.login ?? null,
				date: c.commit.author?.date ?? c.commit.committer?.date ?? null,
			}));
		}
		case "gitlab": {
			if (!source.gitlabId || !source.gitlabProjectId) {
				throw new Error("no GitLab project");
			}
			await refreshGitlabToken(source.gitlabId);
			const gitlab = await findGitlabById(source.gitlabId);
			const base = (gitlab.gitlabInternalUrl || gitlab.gitlabUrl).replace(
				/\/+$/,
				"",
			);
			const data = (await getJson(
				`${base}/api/v4/projects/${source.gitlabProjectId}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=${limit}`,
				{ Authorization: `Bearer ${gitlab.accessToken}` },
			)) as {
				id: string;
				title?: string;
				message?: string;
				author_name?: string;
				authored_date?: string;
			}[];
			return data.map((c) => ({
				sha: c.id,
				message: firstLine(c.title ?? c.message),
				author: c.author_name ?? null,
				date: c.authored_date ?? null,
			}));
		}
		case "gitea": {
			if (!source.giteaId) throw new Error("no Gitea provider");
			await refreshGiteaToken(source.giteaId);
			const gitea = await findGiteaById(source.giteaId);
			const base = (gitea.giteaInternalUrl || gitea.giteaUrl).replace(
				/\/+$/,
				"",
			);
			const data = (await getJson(
				`${base}/api/v1/repos/${encodeURIComponent(source.giteaOwner ?? "")}/${encodeURIComponent(source.giteaRepository ?? "")}/commits?sha=${encodeURIComponent(branch)}&limit=${Math.min(limit, GITEA_PAGE_MAX)}&stat=false&verification=false&files=false`,
				{ Authorization: `token ${gitea.accessToken}` },
			)) as {
				sha: string;
				commit?: {
					message?: string;
					author?: { name?: string; date?: string };
				};
			}[];
			return data.map((c) => ({
				sha: c.sha,
				message: firstLine(c.commit?.message),
				author: c.commit?.author?.name ?? null,
				date: c.commit?.author?.date ?? null,
			}));
		}
		case "bitbucket": {
			if (!source.bitbucketId) throw new Error("no Bitbucket provider");
			const bitbucket = await findBitbucketById(source.bitbucketId);
			const repo =
				source.bitbucketRepositorySlug || source.bitbucketRepository || "";
			const data = (await getJson(
				`https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(source.bitbucketOwner ?? "")}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}?pagelen=${limit}`,
				getBitbucketHeaders(bitbucket),
			)) as {
				values: {
					hash: string;
					message?: string;
					date?: string;
					author?: { raw?: string; user?: { display_name?: string } };
				}[];
			};
			return data.values.map((c) => ({
				sha: c.hash,
				message: firstLine(c.message),
				author: c.author?.user?.display_name ?? c.author?.raw ?? null,
				date: c.date ?? null,
			}));
		}
		default:
			return [];
	}
};

const FIELD = "\x1f";

export const parseGitLog = (stdout: string): RemoteCommit[] =>
	stdout
		.split("\n")
		.map((line) => line.split(FIELD))
		.filter(([sha]) => SHA_PATTERN.test(sha ?? ""))
		.map(([sha, author, date, message]) => ({
			sha: sha as string,
			author: author || null,
			date: date || null,
			message: firstLine(message),
		}));

/**
 * A custom Git remote has no API: a bare, blob-less clone of the last commits
 * into a temporary folder, deleted on exit, with the configured SSH key.
 */
export const gitCloneLogCommand = async (
	source: CommitSource,
	branch: string,
	serverId: string | null,
	limit: number,
	extra: string[] = [],
) => {
	const lines = ["set -e", "DIR=$(mktemp -d)", 'trap "rm -rf $DIR" EXIT'];
	if (source.customGitSSHKeyId) {
		const sshKey = await findSSHKeyById(source.customGitSSHKeyId);
		const knownHosts = `${paths(!!serverId).SSH_PATH}/known_hosts`;
		lines.push(
			`printf '%s\\n' ${quote([sshKey.privateKey])} > "$DIR/key"`,
			'chmod 600 "$DIR/key"',
			`export GIT_SSH_COMMAND="ssh -i $DIR/key -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=accept-new"`,
		);
	}
	lines.push(
		`GIT_TERMINAL_PROMPT=0 timeout 30 git clone -q --bare --single-branch --depth ${limit} --filter=blob:none --branch ${quote([branch])} -- ${quote([source.customGitUrl ?? ""])} "$DIR/repo"`,
		`git -C "$DIR/repo" log -${limit} --format='%H%x1f%an%x1f%aI%x1f%s'`,
		...extra,
	);
	return lines.join("; ");
};

/** The last commits of the configured branch, newest first. Never guesses. */
export const listRemoteCommits = async (
	source: CommitSource,
	limit = COMMITS_LIMIT,
): Promise<RemoteCommits> => {
	const described = describeSource(source);
	if (!described.isGit) {
		return {
			status: "not_applicable",
			reason: `source "${source.sourceType}" is not a Git repository`,
		};
	}
	const branch = described.branch;
	if (!branch) {
		return { status: "not_applicable", reason: "no branch configured" };
	}

	if (source.sourceType === "git") {
		const serverId = source.buildServerId || source.serverId;
		const result = await runOn(
			serverId,
			await gitCloneLogCommand(source, branch, serverId, limit),
		);
		const commits = parseGitLog(result.stdout);
		if (result.ok && commits.length > 0) {
			return { status: "ok", branch, commits, method: "git_clone" };
		}
		return {
			status: "error",
			// stderr may echo the command, which can contain key material.
			reason: "git clone failed (network, authentication or unknown branch)",
		};
	}

	try {
		const commits = await withTimeout(
			fromProvider(source, branch, limit),
			PROVIDER_TIMEOUT_MS,
			"provider commit list",
		);
		return {
			status: "ok",
			branch,
			commits: commits.filter((c) => SHA_PATTERN.test(c.sha)),
			method: "provider_api",
		};
	} catch (error) {
		return {
			status: "error",
			reason: `${source.sourceType} API error: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
		};
	}
};
