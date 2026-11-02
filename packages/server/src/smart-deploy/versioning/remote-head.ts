import { paths } from "@dokploy/server/constants";
import type { Application } from "@dokploy/server/services/application";
import { findSSHKeyById } from "@dokploy/server/services/ssh-key";
import { getBitbucketBranches } from "@dokploy/server/utils/providers/bitbucket";
import { getGiteaBranches } from "@dokploy/server/utils/providers/gitea";
import { getGithubBranches } from "@dokploy/server/utils/providers/github";
import { getGitlabBranches } from "@dokploy/server/utils/providers/gitlab";
import { quote } from "shell-quote";
import { withTimeout } from "../diagnostics/collect/docker-io";
import { runOn, SHA_PATTERN } from "./shell";
import { describeSource } from "./source";

const REMOTE_TIMEOUT_MS = 15_000;

export type RemoteHead =
	| {
			status: "ok";
			sha: string;
			branch: string;
			checkedAt: string;
			method: "provider_api" | "git_ls_remote";
	  }
	| {
			status: "error";
			reason: string;
			checkedAt: string;
			method: "provider_api" | "git_ls_remote";
	  }
	| { status: "not_applicable"; reason: string };

type BranchLike = { name: string; commit: { sha?: string; id?: string } };

const pickBranch = (branches: BranchLike[], branch: string) => {
	const match = branches.find((b) => b.name === branch);
	return match?.commit.sha ?? match?.commit.id;
};

const fromProvider = async (app: Application, branch: string) => {
	switch (app.sourceType) {
		case "github":
			return pickBranch(
				(await getGithubBranches({
					githubId: app.githubId ?? undefined,
					owner: app.owner ?? "",
					repo: app.repository ?? "",
				})) as BranchLike[],
				branch,
			);
		case "gitlab":
			return pickBranch(
				await getGitlabBranches({
					id: app.gitlabProjectId ?? undefined,
					gitlabId: app.gitlabId ?? undefined,
					owner: app.gitlabOwner ?? "",
					repo: app.gitlabRepository ?? "",
				}),
				branch,
			);
		case "gitea":
			return pickBranch(
				(await getGiteaBranches({
					giteaId: app.giteaId ?? undefined,
					owner: app.giteaOwner ?? "",
					repo: app.giteaRepository ?? "",
				})) as BranchLike[],
				branch,
			);
		case "bitbucket":
			return pickBranch(
				await getBitbucketBranches({
					bitbucketId: app.bitbucketId ?? undefined,
					owner: app.bitbucketOwner ?? "",
					repo: app.bitbucketRepositorySlug || app.bitbucketRepository || "",
				}),
				branch,
			);
		default:
			return undefined;
	}
};

const lsRemoteCommand = async (app: Application, serverId: string | null) => {
	const url = app.customGitUrl ?? "";
	const ref = `refs/heads/${app.customGitBranch ?? ""}`;
	const base = `GIT_TERMINAL_PROMPT=0 timeout 15 git ls-remote -- ${quote([url, ref])}`;
	if (!app.customGitSSHKeyId) return base;

	const sshKey = await findSSHKeyById(app.customGitSSHKeyId);
	const knownHosts = `${paths(!!serverId).SSH_PATH}/known_hosts`;
	// Same approach as the clone step, but with a private temp file removed on exit.
	return [
		"set -e",
		"KEY=$(mktemp)",
		'trap "rm -f $KEY" EXIT',
		`printf '%s\\n' ${quote([sshKey.privateKey])} > "$KEY"`,
		'chmod 600 "$KEY"',
		`export GIT_SSH_COMMAND="ssh -i $KEY -o UserKnownHostsFile=${knownHosts} -o StrictHostKeyChecking=accept-new"`,
		base,
	].join("; ");
};

/**
 * Asks the remote for the current head of the deployed branch. Never guesses:
 * any failure is returned as an error, never as a commit.
 */
export const getRemoteHead = async (app: Application): Promise<RemoteHead> => {
	const source = describeSource(app);
	if (!source.isGit) {
		return {
			status: "not_applicable",
			reason: `source "${app.sourceType}" is not a Git repository`,
		};
	}
	const branch = source.branch;
	if (!branch) {
		return { status: "not_applicable", reason: "no branch configured" };
	}

	const checkedAt = new Date().toISOString();
	if (app.sourceType === "git") {
		const serverId = app.buildServerId || app.serverId;
		const result = await runOn(serverId, await lsRemoteCommand(app, serverId));
		const sha = result.stdout.trim().split(/\s+/)[0] ?? "";
		if (result.ok && SHA_PATTERN.test(sha)) {
			return { status: "ok", sha, branch, checkedAt, method: "git_ls_remote" };
		}
		return {
			status: "error",
			// stderr may echo the command, which can contain key material.
			reason: result.ok
				? `branch "${branch}" not found on the remote`
				: "git ls-remote failed (network, authentication or unknown repository)",
			checkedAt,
			method: "git_ls_remote",
		};
	}

	try {
		const sha = await withTimeout(
			fromProvider(app, branch),
			REMOTE_TIMEOUT_MS,
			"provider branch lookup",
		);
		if (sha && SHA_PATTERN.test(sha)) {
			return { status: "ok", sha, branch, checkedAt, method: "provider_api" };
		}
		return {
			status: "error",
			reason: `branch "${branch}" not found through the ${app.sourceType} API`,
			checkedAt,
			method: "provider_api",
		};
	} catch (error) {
		return {
			status: "error",
			reason: `${app.sourceType} API error: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`,
			checkedAt,
			method: "provider_api",
		};
	}
};
