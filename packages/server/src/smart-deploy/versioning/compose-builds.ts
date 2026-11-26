import { quote } from "shell-quote";
import { parse } from "yaml";
import { runOn, SHA_PATTERN } from "./shell";
import { sanitizeRepositoryUrl } from "./source";

/** A service whose image Docker builds from a remote Git repository. */
export interface GitBuild {
	service: string;
	url: string;
	/** Branch, tag or commit after `#`; null builds the default branch. */
	ref: string | null;
	/** Folder of the repository used as the build context. */
	subdir: string | null;
}

export type ComposeBuild =
	| ({ kind: "git" } & GitBuild)
	| { kind: "local"; service: string };

/**
 * Docker's remote Git contexts: `https://host/repo.git#ref:dir`,
 * `git@host:repo.git`, `git://…`, `ssh://…`, or `github.com/owner/repo`.
 * A plain https URL without `.git` or `#` is a tarball, not Git.
 */
export const parseGitContext = (context: string) => {
	const value = context.trim();
	const hash = value.indexOf("#");
	const base = hash === -1 ? value : value.slice(0, hash);
	const fragment = hash === -1 ? "" : value.slice(hash + 1);
	const isGit =
		/^(git@|git:\/\/|ssh:\/\/)/.test(base) ||
		(/^https?:\/\//.test(base) && (/\.git\/?$/.test(base) || hash !== -1)) ||
		/^github\.com\//.test(base);
	if (!isGit || !base) return null;
	const [ref = "", subdir = ""] = fragment.split(":");
	return {
		url: /^github\.com\//.test(base) ? `https://${base}` : base,
		ref: ref || null,
		subdir: subdir || null,
	};
};

/** Services of a compose file that build their image, and from where. */
export const composeBuilds = (content: string | null | undefined) => {
	if (!content?.trim()) return [];
	let doc: unknown;
	try {
		doc = parse(content);
	} catch {
		return [];
	}
	const services = (doc as { services?: Record<string, unknown> } | null)
		?.services;
	if (!services || typeof services !== "object") return [];
	const builds: ComposeBuild[] = [];
	for (const [service, spec] of Object.entries(services)) {
		const build = (spec as { build?: unknown } | null)?.build;
		if (build === undefined || build === null) continue;
		const context =
			typeof build === "string"
				? build
				: ((build as { context?: unknown }).context ?? ".");
		const git = typeof context === "string" ? parseGitContext(context) : null;
		builds.push(
			git ? { kind: "git", service, ...git } : { kind: "local", service },
		);
	}
	return builds;
};

/** `user:token@` never reaches the page or the history. */
export const describeGitBuild = (build: GitBuild) =>
	`${sanitizeRepositoryUrl(build.url)}${build.ref ? `#${build.ref}` : ""}`;

/**
 * The commit a ref points to now, or the default branch's name when `ref`
 * is null. Asked right after a build, it is the commit Docker just fetched,
 * unless someone pushed in between.
 */
export const resolveGitRef = async (
	serverId: string | null,
	build: Pick<GitBuild, "url" | "ref">,
): Promise<{ sha: string | null; branch: string | null }> => {
	const target = build.ref ?? "HEAD";
	if (SHA_PATTERN.test(target)) return { sha: target, branch: null };
	const result = await runOn(
		serverId,
		`GIT_TERMINAL_PROMPT=0 timeout 20 git ls-remote --symref ${quote([build.url])} ${quote([target])}`,
	);
	if (!result.ok) return { sha: null, branch: null };
	let sha: string | null = null;
	let branch: string | null = null;
	for (const line of result.stdout.split("\n")) {
		const [left, right] = line.trim().split(/\s+/);
		if (left === "ref:" && right?.startsWith("refs/heads/")) {
			branch = right.slice("refs/heads/".length);
		} else if (left && SHA_PATTERN.test(left) && !sha) {
			// A peeled annotated tag (`^{}`) comes after the tag object.
			sha = left;
		}
		if (left && SHA_PATTERN.test(left) && right?.endsWith("^{}")) sha = left;
	}
	return { sha, branch: branch ?? build.ref };
};
