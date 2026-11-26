import {
	newerVersionTags,
	parseVersionTag,
	splitImageName,
} from "@dokploy/server/auto-update/app-check";
import {
	getRegistryDigest,
	getRegistryImageInfo,
	listRegistryTags,
	parseImageReference,
	type RegistryCredentials,
} from "@dokploy/server/services/image-update";

const NEWER_LIMIT = 10;
/** Version tags checked to tell which version a moving tag such as `latest` is. */
const RESOLVE_LIMIT = 6;
const HUB_PAGES = 5;

export interface ImageTag {
	tag: string;
	/** When the tag was last pushed, or the image's build date. */
	date: string | null;
	digest: string | null;
}

export type ImageVersions =
	| {
			status: "ok";
			/** Repository, with its registry when there is one. */
			name: string;
			tag: string;
			/** A version tag (`5.82.0`) rather than a moving one (`latest`). */
			isVersion: boolean;
			/** What the tag points to in the registry now. */
			registry: ImageTag;
			/** Version tags the moving tag currently points to, highest first. */
			sameAs: string[];
			/** Newer tags written the same way, highest first. */
			newer: ImageTag[];
			/**
			 * The tag points to another image than the one running: deploying
			 * again pulls it. Null when the running digest is not known.
			 */
			rebuilt: boolean | null;
	  }
	| { status: "error"; reason: string }
	| { status: "not_applicable"; reason: string };

interface HubTag {
	name: string;
	digest?: string;
	last_updated?: string;
	tag_last_pushed?: string;
}

/**
 * Docker Hub's own API: tags with their digest and push date in one list,
 * without the manifest requests the pull rate limit counts.
 */
const hubTags = async (repository: string): Promise<ImageTag[]> => {
	const tags: ImageTag[] = [];
	let url: string | null =
		`https://hub.docker.com/v2/repositories/${repository}/tags/?page_size=100&ordering=last_updated`;
	for (let page = 0; url && page < HUB_PAGES; page++) {
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Docker Hub answered ${response.status}`);
		const body = (await response.json()) as {
			results?: HubTag[];
			next?: string | null;
		};
		for (const t of body.results ?? []) {
			tags.push({
				tag: t.name,
				digest: t.digest ?? null,
				date: t.tag_last_pushed ?? t.last_updated ?? null,
			});
		}
		url = body.next ?? null;
	}
	return tags;
};

const settle = async <T>(promise: Promise<T>): Promise<T | null> =>
	promise.catch(() => null);

/**
 * Where an image tag stands in its registry: newer versions, or for a moving
 * tag, which versions it is and whether it moved since `runningDigest`.
 */
export const getImageVersions = async (
	image: string,
	options: {
		runningDigest?: string | null;
		credentials?: RegistryCredentials;
	} = {},
): Promise<ImageVersions> => {
	const { name, tag } = splitImageName(image);
	if (!tag) {
		return { status: "not_applicable", reason: "pinned to a digest" };
	}
	const ref = parseImageReference(`${name}:${tag}`);
	const { credentials } = options;
	const isVersion = parseVersionTag(tag) !== null;
	try {
		let known: Map<string, ImageTag>;
		if (ref.registry === "registry-1.docker.io" && !credentials) {
			known = new Map((await hubTags(ref.repository)).map((t) => [t.tag, t]));
			// Hub lists the most recently pushed tags first: an old tag may be past them.
			if (!known.has(tag)) {
				const digest = await settle(getRegistryDigest(`${name}:${tag}`));
				known.set(tag, { tag, digest, date: null });
			}
		} else {
			const names = await listRegistryTags(`${name}:${tag}`, credentials);
			known = new Map(
				names.map((t) => [t, { tag: t, digest: null, date: null }]),
			);
		}

		const fill = async (entry: ImageTag, withDate: boolean) => {
			if (entry.digest && (entry.date || !withDate)) return entry;
			if (withDate) {
				const info = await settle(
					getRegistryImageInfo(`${name}:${entry.tag}`, credentials),
				);
				return {
					...entry,
					digest: entry.digest ?? info?.digest ?? null,
					date: entry.date ?? info?.created ?? null,
				};
			}
			const digest = await settle(
				getRegistryDigest(`${name}:${entry.tag}`, credentials),
			);
			return { ...entry, digest };
		};

		const registry = await fill(
			known.get(tag) ?? { tag, digest: null, date: null },
			true,
		);
		if (!registry.digest) {
			return {
				status: "error",
				reason: `${name}:${tag} not found in its registry`,
			};
		}

		const tagNames = [...known.keys()];
		const newer = isVersion
			? await Promise.all(
					newerVersionTags(tag, tagNames)
						.slice(0, NEWER_LIMIT)
						.map((t) => fill(known.get(t) as ImageTag, true)),
				)
			: [];

		let sameAs: string[] = [];
		if (!isVersion) {
			const versions = tagNames
				.filter((t) => {
					const v = parseVersionTag(t);
					return v !== null && v.suffix === "";
				})
				.sort((a, b) => {
					const va = parseVersionTag(a)?.numbers ?? [];
					const vb = parseVersionTag(b)?.numbers ?? [];
					for (let i = 0; i < Math.max(va.length, vb.length); i++) {
						const diff = (vb[i] ?? 0) - (va[i] ?? 0);
						if (diff !== 0) return diff;
					}
					return 0;
				})
				.slice(0, RESOLVE_LIMIT);
			const resolved = await Promise.all(
				versions.map((t) => fill(known.get(t) as ImageTag, false)),
			);
			sameAs = resolved
				.filter((t) => t.digest === registry.digest)
				.map((t) => t.tag);
		}

		const running = options.runningDigest ?? null;
		return {
			status: "ok",
			name,
			tag,
			isVersion,
			registry,
			sameAs,
			newer,
			rebuilt: running ? running !== registry.digest : null,
		};
	} catch (error) {
		return {
			status: "error",
			reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
		};
	}
};
