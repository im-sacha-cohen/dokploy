import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import type { UpdatePolicy } from "../db/schema/auto-update";
import { deployments } from "../db/schema/deployment";
import {
	getRegistryImageInfo,
	listRegistryTags,
	type RegistryCredentials,
} from "../services/image-update";

export interface ImageName {
	/** Repository, with its registry when there is one. */
	name: string;
	tag: string | null;
	digest: string | null;
}

export const splitImageName = (image: string): ImageName => {
	const [nameAndTag = "", digest] = image.trim().split("@");
	const colon = nameAndTag.lastIndexOf(":");
	// A colon before the last slash is a registry port, not a tag.
	const hasTag = colon > nameAndTag.lastIndexOf("/");
	return {
		name: hasTag ? nameAndTag.slice(0, colon) : nameAndTag,
		tag: hasTag ? nameAndTag.slice(colon + 1) : digest ? null : "latest",
		digest: digest ?? null,
	};
};

interface VersionTag {
	prefix: string;
	numbers: number[];
	suffix: string;
}

export const parseVersionTag = (tag: string): VersionTag | null => {
	const match = /^(v?)(\d+)(?:\.(\d+))?(?:\.(\d+))?([-_+][\w.-]*)?$/.exec(tag);
	if (!match) return null;
	return {
		prefix: match[1] ?? "",
		numbers: [match[2], match[3], match[4]]
			.filter((part): part is string => part !== undefined)
			.map(Number),
		suffix: match[5] ?? "",
	};
};

const compareNumbers = (a: number[], b: number[]) => {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const diff = (a[i] ?? 0) - (b[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
};

/**
 * The highest tag above `current` that the rule allows. Only tags written
 * the same way count: same `v` prefix, same number of parts, same suffix
 * (`1.25.3-alpine` moves to `1.25.4-alpine`, never to `1.25.4` or `1.26`).
 */
export const pickVersionTag = (
	current: string,
	tags: string[],
	rule: Exclude<UpdatePolicy["versionRule"], "digest">,
) => {
	const from = parseVersionTag(current);
	if (!from) return null;
	const fixed = rule === "patch" ? 2 : rule === "minor" ? 1 : 0;
	let best: { tag: string; numbers: number[] } | null = null;
	for (const tag of tags) {
		const candidate = parseVersionTag(tag);
		if (
			!candidate ||
			candidate.prefix !== from.prefix ||
			candidate.suffix !== from.suffix ||
			candidate.numbers.length !== from.numbers.length ||
			compareNumbers(candidate.numbers, from.numbers) <= 0
		) {
			continue;
		}
		if (
			from.numbers
				.slice(0, fixed)
				.some((part, i) => candidate.numbers[i] !== part)
		) {
			continue;
		}
		if (!best || compareNumbers(candidate.numbers, best.numbers) > 0) {
			best = { tag, numbers: candidate.numbers };
		}
	}
	return best?.tag ?? null;
};

/** Tags above `current` written the same way (see pickVersionTag), highest first. */
export const newerVersionTags = (current: string, tags: string[]) => {
	const from = parseVersionTag(current);
	if (!from) return [];
	return tags
		.map((tag) => ({ tag, version: parseVersionTag(tag) }))
		.filter(
			(c): c is { tag: string; version: VersionTag } =>
				!!c.version &&
				c.version.prefix === from.prefix &&
				c.version.suffix === from.suffix &&
				c.version.numbers.length === from.numbers.length &&
				compareNumbers(c.version.numbers, from.numbers) > 0,
		)
		.sort((a, b) => compareNumbers(b.version.numbers, a.version.numbers))
		.map((c) => c.tag);
};

export type ApplicationUpdateCheck =
	| { available: false; reason?: string }
	| {
			available: true;
			currentImage: string;
			/** The image that ran, pinned to its digest: what a put-back deploys. */
			currentPinned: string;
			/** Set as the application's image before deploying. */
			targetImage: string;
			/** `targetImage` with the digest checked, for the history. */
			targetPinned: string;
			label: string;
			createdAt: Date | null;
	  };

interface CheckedApplication {
	applicationId: string;
	dockerImage: string | null;
	username: string | null;
	password: string | null;
}

const lastDeployedDigest = async (applicationId: string) => {
	const [last] = await db
		.select({ imageDigest: deployments.imageDigest })
		.from(deployments)
		.where(
			and(
				eq(deployments.applicationId, applicationId),
				eq(deployments.status, "done"),
			),
		)
		.orderBy(desc(deployments.createdAt))
		.limit(1);
	return last?.imageDigest?.split("@")[1] ?? null;
};

const parseDate = (value: string | null) => {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** What a scheduled update of this image application would deploy, if anything. */
export const checkApplicationUpdate = async (
	application: CheckedApplication,
	rule: UpdatePolicy["versionRule"],
): Promise<ApplicationUpdateCheck> => {
	if (!application.dockerImage) {
		return { available: false, reason: "The application has no image." };
	}
	const current = splitImageName(application.dockerImage);
	if (!current.tag) {
		return {
			available: false,
			reason: "The image is pinned to a digest without a tag.",
		};
	}
	const currentDigest =
		current.digest ?? (await lastDeployedDigest(application.applicationId));
	if (!currentDigest) {
		return {
			available: false,
			reason: "The application has no successful deployment to compare with.",
		};
	}
	const credentials: RegistryCredentials | undefined =
		application.username && application.password
			? { username: application.username, password: application.password }
			: undefined;

	let tag = current.tag;
	if (rule !== "digest") {
		const tags = await listRegistryTags(`${current.name}:${tag}`, credentials);
		const newer = pickVersionTag(tag, tags, rule);
		if (!newer) return { available: false };
		tag = newer;
	}
	const latest = await getRegistryImageInfo(
		`${current.name}:${tag}`,
		credentials,
	);
	if (latest.digest === currentDigest) return { available: false };
	return {
		available: true,
		currentImage: application.dockerImage,
		currentPinned: `${current.name}:${current.tag}@${currentDigest}`,
		targetImage: `${current.name}:${tag}`,
		targetPinned: `${current.name}:${tag}@${latest.digest}`,
		label: tag,
		createdAt: parseDate(latest.created),
	};
};
