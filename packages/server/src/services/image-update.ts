/**
 * Updates for a Dokploy image other than the official `dokploy/dokploy` (a
 * fork published on GHCR, for instance). The official check compares semver
 * tags on Docker Hub; a fork has a single moving tag instead, so an update
 * is a different digest behind that tag.
 */

export const OFFICIAL_DOKPLOY_IMAGE = "dokploy/dokploy";

/** Image repository the `dokploy` service runs, without tag. */
export const getDokployImage = () =>
	process.env.DOKPLOY_IMAGE?.trim() || OFFICIAL_DOKPLOY_IMAGE;

export const isCustomDokployImage = () =>
	getDokployImage() !== OFFICIAL_DOKPLOY_IMAGE;

export interface ImageReference {
	registry: string;
	repository: string;
	/** Tag or `sha256:` digest. */
	reference: string;
}

export const parseImageReference = (image: string): ImageReference => {
	const [name = "", digest] = image.split("@");
	const tagStart = name.lastIndexOf(":");
	// A colon followed by a slash is a registry port, not a tag.
	const hasTag = tagStart !== -1 && !name.slice(tagStart).includes("/");
	const path = hasTag ? name.slice(0, tagStart) : name;
	const tag = hasTag ? name.slice(tagStart + 1) : "latest";
	const first = path.split("/")[0] ?? "";
	const hasRegistry =
		path.includes("/") &&
		(first.includes(".") || first.includes(":") || first === "localhost");
	const registry = hasRegistry ? first : "registry-1.docker.io";
	let repository = hasRegistry ? path.slice(first.length + 1) : path;
	if (!hasRegistry && !repository.includes("/")) {
		repository = `library/${repository}`;
	}
	return { registry, repository, reference: digest ?? tag };
};

const MANIFEST_TYPES = [
	"application/vnd.oci.image.index.v1+json",
	"application/vnd.docker.distribution.manifest.list.v2+json",
	"application/vnd.oci.image.manifest.v1+json",
	"application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const parseBearerChallenge = (header: string | null) => {
	if (!header?.toLowerCase().startsWith("bearer ")) return null;
	const params = Object.fromEntries(
		[...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);
	return params.realm ? params : null;
};

/**
 * Anonymous registry client: public images only, which is how a fork is
 * meant to be published. A private image answers 401 and the check gives up.
 */
const registryFetch = async (
	ref: ImageReference,
	path: string,
	accept?: string,
) => {
	const url = `https://${ref.registry}/v2/${ref.repository}/${path}`;
	const headers: Record<string, string> = accept ? { accept } : {};
	const signal = AbortSignal.timeout(15_000);
	let response = await fetch(url, { headers, signal });
	const challenge =
		response.status === 401
			? parseBearerChallenge(response.headers.get("www-authenticate"))
			: null;
	if (challenge) {
		const tokenUrl = new URL(challenge.realm as string);
		if (challenge.service) {
			tokenUrl.searchParams.set("service", challenge.service);
		}
		tokenUrl.searchParams.set(
			"scope",
			challenge.scope ?? `repository:${ref.repository}:pull`,
		);
		const tokenResponse = await fetch(tokenUrl, { signal });
		if (tokenResponse.ok) {
			const { token, access_token } = (await tokenResponse.json()) as {
				token?: string;
				access_token?: string;
			};
			response = await fetch(url, {
				headers: {
					...headers,
					authorization: `Bearer ${token ?? access_token}`,
				},
				signal,
			});
		}
	}
	if (!response.ok) {
		throw new Error(`${ref.registry} answered ${response.status} for ${path}`);
	}
	return response;
};

const NODE_ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

export interface RegistryImageInfo {
	/** Digest the tag points to (the multi-arch index when there is one). */
	digest: string;
	revision: string | null;
	source: string | null;
}

export const getRegistryImageInfo = async (
	image: string,
): Promise<RegistryImageInfo> => {
	const ref = parseImageReference(image);
	const response = await registryFetch(
		ref,
		`manifests/${ref.reference}`,
		MANIFEST_TYPES,
	);
	const digest =
		response.headers.get("docker-content-digest") ??
		(ref.reference.startsWith("sha256:") ? ref.reference : "");
	if (!digest) throw new Error(`${ref.registry} returned no digest`);

	// Labels are optional extras: the digest alone decides the update.
	try {
		let manifest = (await response.json()) as {
			manifests?: {
				digest: string;
				platform?: { os?: string; architecture?: string };
			}[];
			config?: { digest: string };
		};
		if (manifest.manifests) {
			const arch = NODE_ARCH[process.arch] ?? process.arch;
			const entry =
				manifest.manifests.find(
					(m) => m.platform?.os === "linux" && m.platform.architecture === arch,
				) ??
				manifest.manifests.find((m) => m.platform?.os === "linux") ??
				manifest.manifests[0];
			if (!entry) return { digest, revision: null, source: null };
			manifest = await (
				await registryFetch(ref, `manifests/${entry.digest}`, MANIFEST_TYPES)
			).json();
		}
		if (!manifest.config) return { digest, revision: null, source: null };
		const config = (await (
			await registryFetch(ref, `blobs/${manifest.config.digest}`)
		).json()) as { config?: { Labels?: Record<string, string> } };
		const labels = config.config?.Labels ?? {};
		return {
			digest,
			revision: labels["org.opencontainers.image.revision"] ?? null,
			source: labels["org.opencontainers.image.source"] ?? null,
		};
	} catch {
		return { digest, revision: null, source: null };
	}
};

export interface CustomImageUpdateData {
	latestVersion: string;
	updateAvailable: boolean;
	image: string;
	currentRevision: string | null;
	latestRevision: string | null;
	sourceUrl: string | null;
}

/** Compares the digest the service runs with the one behind the tag now. */
export const getCustomImageUpdateData = async (
	tag: string,
	currentDigest: string,
): Promise<CustomImageUpdateData> => {
	const image = getDokployImage();
	const [latest, current] = await Promise.all([
		getRegistryImageInfo(`${image}:${tag}`),
		getRegistryImageInfo(`${image}@${currentDigest}`).catch(() => null),
	]);
	return {
		latestVersion: tag,
		updateAvailable: latest.digest !== currentDigest,
		image,
		currentRevision: current?.revision ?? null,
		latestRevision: latest.revision,
		sourceUrl: latest.source ?? current?.source ?? null,
	};
};
