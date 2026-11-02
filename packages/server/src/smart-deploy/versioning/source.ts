import type { Application } from "@dokploy/server/services/application";

export interface SourceDescription {
	repository: string | null;
	branch: string | null;
	isGit: boolean;
}

/** Removes credentials so a repository URL can be stored and displayed. */
export const sanitizeRepositoryUrl = (url: string): string => {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		// scp-like SSH syntax (git@host:org/repo.git) carries no secret.
		return url.replace(/^[^@\s]+:[^@\s]+@/, "");
	}
};

type SourceFields = Pick<
	Application,
	| "sourceType"
	| "owner"
	| "repository"
	| "branch"
	| "gitlabOwner"
	| "gitlabRepository"
	| "gitlabBranch"
	| "giteaOwner"
	| "giteaRepository"
	| "giteaBranch"
	| "bitbucketOwner"
	| "bitbucketRepository"
	| "bitbucketRepositorySlug"
	| "bitbucketBranch"
	| "customGitUrl"
	| "customGitBranch"
	| "dockerImage"
>;

export const describeSource = (app: SourceFields): SourceDescription => {
	switch (app.sourceType) {
		case "github":
			return {
				repository:
					app.owner && app.repository
						? `github:${app.owner}/${app.repository}`
						: null,
				branch: app.branch,
				isGit: true,
			};
		case "gitlab":
			return {
				repository:
					app.gitlabOwner && app.gitlabRepository
						? `gitlab:${app.gitlabOwner}/${app.gitlabRepository}`
						: null,
				branch: app.gitlabBranch,
				isGit: true,
			};
		case "gitea":
			return {
				repository:
					app.giteaOwner && app.giteaRepository
						? `gitea:${app.giteaOwner}/${app.giteaRepository}`
						: null,
				branch: app.giteaBranch,
				isGit: true,
			};
		case "bitbucket":
			return {
				repository: app.bitbucketOwner
					? `bitbucket:${app.bitbucketOwner}/${app.bitbucketRepositorySlug || app.bitbucketRepository}`
					: null,
				branch: app.bitbucketBranch,
				isGit: true,
			};
		case "git":
			return {
				repository: app.customGitUrl
					? sanitizeRepositoryUrl(app.customGitUrl)
					: null,
				branch: app.customGitBranch,
				isGit: true,
			};
		case "docker":
			return { repository: app.dockerImage, branch: null, isGit: false };
		default:
			return { repository: null, branch: null, isGit: false };
	}
};
