import { quote } from "shell-quote";

/** A full or abbreviated commit SHA, as typed by a user or copied from a Git host. */
export const COMMIT_REF_PATTERN = /^[0-9a-f]{7,40}$/;

export const normalizeCommitRef = (value: string) => value.trim().toLowerCase();

/**
 * Shell lines that move a fresh `--depth 1` clone to `commitSha`, run in the
 * same shell as the clone so they reuse its SSH key (GIT_SSH_COMMAND) and,
 * through `gitAuth`, its token header, which the clone does not persist.
 *
 * A full SHA is fetched alone, which GitHub, GitLab, Gitea and Bitbucket all
 * allow. A short SHA, or a server that refuses it, falls back to the branch's
 * whole history, so the commit must then be on the configured branch.
 */
export const checkoutCommitCommand = ({
	outputPath,
	commitSha,
	gitAuth = "",
	enableSubmodules = false,
}: {
	outputPath: string;
	commitSha?: string | null;
	gitAuth?: string;
	enableSubmodules?: boolean;
}) => {
	if (!commitSha) return "";
	if (!COMMIT_REF_PATTERN.test(commitSha)) {
		return `echo ${quote([`❌ [ERROR] Invalid commit "${commitSha}": expected 7 to 40 hexadecimal characters`])}; exit 1;`;
	}
	const git = `git -C ${quote([outputPath])}${gitAuth ? ` ${gitAuth}` : ""}`;
	const sha = quote([commitSha]);
	const target = quote([`${commitSha}^{commit}`]);
	const exactFetch =
		commitSha.length === 40
			? `${git} fetch --depth 1 origin ${sha} 2>/dev/null`
			: "false";
	return `
echo ${quote([`Checking out commit ${commitSha}`])};
if ! ${exactFetch}; then
	echo "Fetching the branch history to find the commit";
	${git} fetch --unshallow origin || ${git} fetch origin;
fi
if ! dokploy_commit=$(${git} rev-parse --verify --quiet ${target}); then
	echo ${quote([`❌ [ERROR] Commit ${commitSha} was not found in the repository`])};
	exit 1;
fi
${git} -c advice.detachedHead=false checkout --detach "$dokploy_commit";
${enableSubmodules ? `${git} submodule update --init --recursive;` : ""}
echo "Checked out $dokploy_commit: ✅";
`;
};
