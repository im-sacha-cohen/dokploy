import { splitImageName } from "@dokploy/server/auto-update/app-check";
import { db } from "@dokploy/server/db";
import { deployments } from "@dokploy/server/db/schema";
import { findApplicationById } from "@dokploy/server/services/application";
import { findComposeById } from "@dokploy/server/services/compose";
import type { RegistryCredentials } from "@dokploy/server/services/image-update";
import { desc, eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { CommitSource } from "./commits";
import { getComposeVersionStatus, isGitCompose } from "./compose";
import { getImageVersions, type ImageVersions } from "./image-versions";
import {
	describeCommit,
	type GitVersionData,
	getGitVersionData,
	newerThan,
} from "./releases";
import { runOn } from "./shell";
import { getVersionStatus } from "./status";

const CACHE_TTL_MS = 10 * 60 * 1000;
const PAST_LIMIT = 20;

export type VersionChange = "same" | "newer" | "unknown";

export interface VersionLine {
	label: string;
	detail: string | null;
	date: string | null;
	sha: string | null;
}

export type DeployAction =
	| { kind: "commit"; sha: string }
	| { kind: "image"; image: string };

export interface NewerItem {
	key: string;
	kind: "release" | "tag" | "commit" | "image_tag";
	label: string;
	date: string | null;
	/** Release notes, Markdown. */
	notes: string | null;
	url: string | null;
	prerelease: boolean;
	author: string | null;
	sha: string | null;
	/** How to deploy exactly this version, when Dokploy can. */
	deploy: DeployAction | null;
}

export interface ImageLine {
	/** Compose service, null for an application. */
	service: string | null;
	image: string;
	/** "5.82.0", or "latest (5.83.0)" when the moving tag is a known version. */
	label: string;
	isVersion: boolean;
	/** The tag was pushed again since the running image was pulled. */
	rebuilt: boolean | null;
	registryDate: string | null;
	newer: NewerItem[];
	error: string | null;
}

export interface PastItem {
	deploymentId: string;
	createdAt: string;
	label: string;
	detail: string | null;
	status: string | null;
	verificationStatus: string | null;
	current: boolean;
	redeployable: boolean;
}

export interface ServiceVersionHistory {
	serviceType: "application" | "compose";
	/** Where versions come from: Git commits and tags, or image tags. */
	sourceKind: "git" | "image" | "compose_file";
	current: VersionLine | null;
	/** What the Deploy button installs. */
	next: {
		label: string;
		change: VersionChange;
		reason: string | null;
		newerReleases: number;
		newerCommits: number;
		newerImages: number;
	};
	/** Releases (or tags) after the running version, highest first. */
	releases: NewerItem[];
	/** Commits after the running one, newest first. */
	commits: NewerItem[];
	moreCommits: boolean;
	/** Git releases need a Git host API (GitHub, GitLab, Gitea). */
	releasesSupported: boolean;
	images: ImageLine[];
	past: PastItem[];
	/** Sources that could not be read, in plain words. */
	problems: string[];
	checkedAt: string;
}

const globalForHistory = globalThis as unknown as {
	__dokployVersionHistory?: Map<
		string,
		{ at: number; stamp: string; value: Promise<ServiceVersionHistory> }
	>;
};

const cache = () => {
	globalForHistory.__dokployVersionHistory ??= new Map();
	return globalForHistory.__dokployVersionHistory;
};

const plural = (count: number, word: string) =>
	`${count} ${word}${count > 1 ? "s" : ""}`;

interface GitPart {
	current: VersionLine | null;
	next: { label: string; change: VersionChange };
	releases: NewerItem[];
	commits: NewerItem[];
	moreCommits: boolean;
	releasesSupported: boolean;
	labelOf: (sha: string | null) => string | null;
}

const gitPart = (
	data: Extract<GitVersionData, { status: "ok" }>,
	currentSha: string | null,
	currentDeployedAt: string | null,
): GitPart => {
	const currentCommit = currentSha
		? data.commits.find((c) => c.sha === currentSha)
		: undefined;
	const newer = newerThan(
		currentSha,
		data,
		currentCommit?.date ?? currentDeployedAt,
	);
	const head = data.commits[0];
	const describe = (sha: string) => describeCommit(sha, data).label;
	return {
		current: currentSha
			? {
					label: describe(currentSha),
					detail: currentCommit?.message ?? null,
					date: currentCommit?.date ?? currentDeployedAt,
					sha: currentSha,
				}
			: null,
		next: head
			? {
					label: describe(head.sha),
					change: !currentSha
						? "unknown"
						: head.sha === currentSha
							? "same"
							: "newer",
				}
			: { label: data.branch, change: "unknown" },
		releases: newer.versions.map((v) => ({
			key: `tag:${v.tag}`,
			kind: data.releasesSupported ? "release" : "tag",
			label: v.name && v.name !== v.tag ? `${v.tag} — ${v.name}` : v.tag,
			date: v.date,
			notes: v.notes,
			url: v.url,
			prerelease: v.prerelease,
			author: null,
			sha: v.sha,
			deploy: v.sha ? { kind: "commit", sha: v.sha } : null,
		})),
		commits: newer.commits.map((c) => ({
			key: `commit:${c.sha}`,
			kind: "commit",
			label: c.message || c.sha.slice(0, 7),
			date: c.date,
			notes: null,
			url: null,
			prerelease: false,
			author: c.author,
			sha: c.sha,
			deploy: { kind: "commit", sha: c.sha },
		})),
		moreCommits: newer.moreCommits,
		releasesSupported: data.releasesSupported,
		labelOf: (sha) => (sha ? describe(sha) : null),
	};
};

const imageLine = (
	service: string | null,
	image: string,
	versions: ImageVersions,
	deployable: boolean,
): ImageLine => {
	if (versions.status !== "ok") {
		return {
			service,
			image,
			label: splitImageName(image).tag ?? image,
			isVersion: false,
			rebuilt: null,
			registryDate: null,
			newer: [],
			error: versions.reason,
		};
	}
	const label =
		!versions.isVersion && versions.sameAs[0]
			? `${versions.tag} (${versions.sameAs[0]})`
			: versions.tag;
	return {
		service,
		image,
		label,
		isVersion: versions.isVersion,
		rebuilt: versions.rebuilt,
		registryDate: versions.registry.date,
		newer: versions.newer.map((t) => ({
			key: `image:${service ?? ""}:${t.tag}`,
			kind: "image_tag",
			label: t.tag,
			date: t.date,
			notes: null,
			url: null,
			prerelease: false,
			author: null,
			sha: null,
			deploy: deployable
				? { kind: "image", image: `${versions.name}:${t.tag}` }
				: null,
		})),
		error: null,
	};
};

const describeGitProblem = (data: GitVersionData) =>
	data.status === "error" ? `Git: ${data.reason}` : null;

const buildApplicationHistory = async (
	applicationId: string,
): Promise<ServiceVersionHistory> => {
	const application = await findApplicationById(applicationId);
	const status = await getVersionStatus(applicationId, { checkRemote: false });
	const problems: string[] = [];
	const byId = new Map(application.deployments.map((d) => [d.deploymentId, d]));
	const currentId = status.current?.deploymentId ?? null;

	const past = (label: (id: string) => string | null): PastItem[] =>
		status.history.slice(0, PAST_LIMIT).map((d) => ({
			deploymentId: d.deploymentId,
			createdAt: d.createdAt,
			label: label(d.deploymentId) ?? d.title,
			detail: d.title,
			status: d.status,
			verificationStatus: d.verificationStatus,
			current: d.deploymentId === currentId,
			redeployable: d.redeployable,
		}));

	if (application.sourceType === "docker") {
		const image = application.dockerImage ?? "";
		const runningDigest = status.current?.imageDigest?.split("@")[1] ?? null;
		const credentials: RegistryCredentials | undefined =
			application.username && application.password
				? { username: application.username, password: application.password }
				: undefined;
		const versions = image
			? await getImageVersions(image, { runningDigest, credentials })
			: ({ status: "not_applicable", reason: "no image" } as const);
		const line = imageLine(null, image, versions, true);
		if (line.error) problems.push(`Registry: ${line.error}`);
		const change: VersionChange =
			line.rebuilt === true
				? "newer"
				: line.rebuilt === false
					? "same"
					: "unknown";
		return {
			serviceType: "application",
			sourceKind: "image",
			current: status.current
				? {
						label:
							line.rebuilt === true
								? `${splitImageName(image).tag ?? image} (an older build)`
								: line.label,
						detail: image,
						date: status.current.createdAt,
						sha: null,
					}
				: null,
			next: {
				label: line.label,
				change,
				reason:
					change === "newer"
						? `The tag was pushed again${line.registryDate ? ` on ${line.registryDate.slice(0, 10)}` : ""}: deploying pulls the new build.`
						: change === "same"
							? "Deploying pulls the same image again."
							: null,
				newerReleases: 0,
				newerCommits: 0,
				newerImages: line.newer.length,
			},
			releases: [],
			commits: [],
			moreCommits: false,
			releasesSupported: false,
			images: [line],
			past: past((id) => {
				const row = byId.get(id);
				return row?.sourceImage ?? null;
			}),
			problems,
			checkedAt: new Date().toISOString(),
		};
	}

	if (!status.source.isGit) {
		return {
			serviceType: "application",
			sourceKind: "git",
			current: null,
			next: {
				label: "the uploaded files",
				change: "unknown",
				reason: "This source has no versions Dokploy can read.",
				newerReleases: 0,
				newerCommits: 0,
				newerImages: 0,
			},
			releases: [],
			commits: [],
			moreCommits: false,
			releasesSupported: false,
			images: [],
			past: past(() => null),
			problems,
			checkedAt: new Date().toISOString(),
		};
	}

	const data = await getGitVersionData(application as unknown as CommitSource);
	const currentSha =
		status.runningCommitSha ?? status.current?.builtCommitSha ?? null;
	const problem = describeGitProblem(data);
	if (problem) problems.push(problem);
	const git =
		data.status === "ok"
			? gitPart(data, currentSha, status.current?.createdAt ?? null)
			: null;
	return {
		serviceType: "application",
		sourceKind: "git",
		current:
			git?.current ??
			(currentSha
				? {
						label: `${status.source.branch ?? "commit"} @ ${currentSha.slice(0, 7)}`,
						detail: null,
						date: status.current?.createdAt ?? null,
						sha: currentSha,
					}
				: null),
		next: {
			label: git?.next.label ?? status.source.branch ?? "the branch",
			change: git?.next.change ?? "unknown",
			reason:
				status.currentMatch === "latest_successful"
					? "The running image matches no recorded deployment: the running version is the last successful deployment's."
					: null,
			newerReleases: git?.releases.length ?? 0,
			newerCommits: git?.commits.length ?? 0,
			newerImages: 0,
		},
		releases: git?.releases ?? [],
		commits: git?.commits ?? [],
		moreCommits: git?.moreCommits ?? false,
		releasesSupported: git?.releasesSupported ?? false,
		images: [],
		past: past(
			(id) => git?.labelOf(byId.get(id)?.builtCommitSha ?? null) ?? null,
		),
		problems,
		checkedAt: new Date().toISOString(),
	};
};

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** Registry digests of local images, keyed by image ID then repository. */
const repoDigests = async (serverId: string | null, imageIds: string[]) => {
	const ids = imageIds.filter((id) => IMAGE_ID.test(id));
	const result = new Map<string, Map<string, string>>();
	if (ids.length === 0) return result;
	const out = await runOn(
		serverId,
		`docker image inspect --format '{{.Id}}|{{json .RepoDigests}}' ${quote(ids)}`,
	);
	for (const line of out.stdout.split("\n")) {
		const [id, json] = line.trim().split("|");
		if (!id || !json) continue;
		try {
			const byRepo = new Map<string, string>();
			for (const ref of (JSON.parse(json) as string[] | null) ?? []) {
				const [repo, digest] = ref.split("@");
				if (repo && digest) byRepo.set(repo, digest);
			}
			result.set(id, byRepo);
		} catch {}
	}
	return result;
};

/** `docker.io/library/ghost`, `library/ghost` and `ghost` are one repository. */
const normalizeRepo = (name: string) =>
	name
		.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "")
		.replace(/^library\//, "");

const buildComposeHistory = async (
	composeId: string,
): Promise<ServiceVersionHistory> => {
	const compose = await findComposeById(composeId);
	const status = await getComposeVersionStatus(composeId);
	const problems: string[] = [];
	const current =
		status.history.find((d) => d.deploymentId === status.currentDeploymentId) ??
		status.history.find((d) => d.status === "done") ??
		null;
	const isGit = isGitCompose(compose);

	const data = isGit
		? await getGitVersionData(compose as unknown as CommitSource)
		: null;
	const problem = data ? describeGitProblem(data) : null;
	if (problem) problems.push(problem);
	const currentSha = current?.builtCommitSha ?? null;
	const git =
		data?.status === "ok"
			? gitPart(data, currentSha, current?.createdAt ?? null)
			: null;

	// Images Dokploy built from the stack's own Dockerfiles have no registry.
	const services = (
		status.live.collected && status.live.services.length > 0
			? status.live.services
			: (current?.services ?? [])
	).filter(
		(s) =>
			s.image &&
			!s.image.startsWith("sha256:") &&
			!s.image.startsWith(`${compose.appName}-`) &&
			!s.image.startsWith(`${compose.appName}_`),
	);
	const digests = await repoDigests(
		compose.serverId,
		services.map((s) => s.imageId),
	);
	const images = await Promise.all(
		services.map(async (s) => {
			const repo = normalizeRepo(splitImageName(s.image).name);
			const running =
				[...(digests.get(s.imageId) ?? new Map())].find(
					([r]) => normalizeRepo(r) === repo,
				)?.[1] ?? null;
			return imageLine(
				s.service,
				s.image,
				await getImageVersions(s.image, { runningDigest: running }),
				false,
			);
		}),
	);
	for (const line of images) {
		if (line.error) problems.push(`${line.service}: ${line.error}`);
	}

	const rebuilt = images.filter((i) => i.rebuilt === true);
	const newerImages = images.reduce((n, i) => n + i.newer.length, 0);
	let change: VersionChange = git?.next.change ?? (isGit ? "unknown" : "same");
	if (rebuilt.length > 0) change = "newer";
	const reasons = [
		rebuilt.length > 0
			? `${plural(rebuilt.length, "image")} pushed again since they were pulled (${rebuilt.map((i) => i.service).join(", ")}): deploying pulls the new builds.`
			: null,
		!isGit ? "Same compose file: the same image tags." : null,
	].filter(Boolean);

	const servicesLabel = (list: { service: string; image: string }[]) =>
		list
			.map((s) => `${s.service}: ${splitImageName(s.image).tag ?? s.image}`)
			.join(", ");

	return {
		serviceType: "compose",
		sourceKind: isGit ? "git" : "compose_file",
		current:
			git?.current ??
			(current
				? {
						label: servicesLabel(current.services) || "compose file",
						detail: null,
						date: current.versionCreatedAt,
						sha: currentSha,
					}
				: null),
		next: {
			label: git?.next.label ?? "the current compose file",
			change,
			reason: reasons.join(" ") || null,
			newerReleases: git?.releases.length ?? 0,
			newerCommits: git?.commits.length ?? 0,
			newerImages,
		},
		releases: git?.releases ?? [],
		commits: git?.commits ?? [],
		moreCommits: git?.moreCommits ?? false,
		releasesSupported: git?.releasesSupported ?? false,
		images,
		past: status.history.slice(0, PAST_LIMIT).map((d) => ({
			deploymentId: d.deploymentId,
			createdAt: d.createdAt,
			label:
				git?.labelOf(d.builtCommitSha) ??
				(servicesLabel(d.services) || d.title),
			detail: d.title,
			status: d.status,
			verificationStatus: null,
			current: d.deploymentId === status.currentDeploymentId,
			redeployable: d.redeployable,
		})),
		problems,
		checkedAt: new Date().toISOString(),
	};
};

/** Changes when a deployment starts or ends, so the cache follows deploys. */
const latestDeploymentStamp = async (
	serviceType: ServiceVersionHistory["serviceType"],
	serviceId: string,
) => {
	const [row] = await db
		.select({ id: deployments.deploymentId, status: deployments.status })
		.from(deployments)
		.where(
			serviceType === "application"
				? eq(deployments.applicationId, serviceId)
				: eq(deployments.composeId, serviceId),
		)
		.orderBy(desc(deployments.createdAt))
		.limit(1);
	return row ? `${row.id}:${row.status}` : "none";
};

/**
 * Version history of an application or a compose stack: what runs, what ran
 * before, what was published after and what Deploy installs. Git hosts and
 * registries are asked at most every 10 minutes per service, unless `force`
 * or a deployment started or ended since.
 */
export const getServiceVersionHistory = async (
	serviceType: ServiceVersionHistory["serviceType"],
	serviceId: string,
	options: { force?: boolean } = {},
): Promise<ServiceVersionHistory> => {
	const key = `${serviceType}:${serviceId}`;
	const stamp = await latestDeploymentStamp(serviceType, serviceId);
	const cached = cache().get(key);
	if (
		!options.force &&
		cached &&
		cached.stamp === stamp &&
		Date.now() - cached.at < CACHE_TTL_MS
	) {
		return cached.value;
	}
	const value =
		serviceType === "application"
			? buildApplicationHistory(serviceId)
			: buildComposeHistory(serviceId);
	cache().set(key, { at: Date.now(), stamp, value });
	value.catch(() => cache().delete(key));
	return value;
};
