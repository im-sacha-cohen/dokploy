import semver from "semver";
import type { UpdatePolicy } from "../db/schema/auto-update";
import {
	getDokployImage,
	getRegistryImageInfo,
	isCustomDokployImage,
} from "../services/image-update";
import { getDokployImageTag, getUpdateData } from "../services/settings";
import { execAsync } from "../utils/process/execAsync";

export type VersionRule = UpdatePolicy["versionRule"];

export type DokployUpdateCheck =
	| { available: false; currentImage: string }
	| {
			available: true;
			currentImage: string;
			/** `repo:tag@sha256:…`: what was checked is what gets installed. */
			targetImage: string;
			label: string;
			createdAt: Date | null;
			/** False when the version rule forbids this jump. */
			allowed: boolean;
	  };

/**
 * Whether going from `current` to `latest` stays within the rule. `digest`
 * follows a moving tag, so it accepts any version.
 */
export const allowedByVersionRule = (
	rule: VersionRule,
	current: string,
	latest: string,
) => {
	if (rule === "digest" || rule === "major") return true;
	const from = semver.coerce(current);
	const to = semver.coerce(latest);
	if (!from || !to) return false;
	if (from.major !== to.major) return false;
	return rule === "minor" || from.minor === to.minor;
};

export const serviceImage = async () => {
	const { stdout } = await execAsync(
		"docker service inspect dokploy --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'",
	);
	return stdout.trim();
};

const parseDate = (value: string | null) => {
	const date = value ? new Date(value) : null;
	return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** What a scheduled update of Dokploy would install now, if anything. */
export const checkDokployUpdate = async (
	currentVersion: string,
	rule: VersionRule,
): Promise<DokployUpdateCheck> => {
	const currentImage = await serviceImage();
	const currentDigest = currentImage.split("@")[1] ?? "";
	const tag = getDokployImageTag();

	if (isCustomDokployImage()) {
		const image = getDokployImage();
		const latest = await getRegistryImageInfo(`${image}:${tag}`);
		if (latest.digest === currentDigest) {
			return { available: false, currentImage };
		}
		return {
			available: true,
			currentImage,
			targetImage: `${image}:${tag}@${latest.digest}`,
			label: latest.revision ? `${tag} (${latest.revision.slice(0, 7)})` : tag,
			createdAt: parseDate(latest.created),
			allowed: true,
		};
	}

	const data = await getUpdateData(currentVersion);
	if (!data.updateAvailable || !data.latestVersion) {
		return { available: false, currentImage };
	}
	const latest = await getRegistryImageInfo(
		`dokploy/dokploy:${data.latestVersion}`,
	);
	if (latest.digest === currentDigest) {
		return { available: false, currentImage };
	}
	const movingTag = data.latestVersion === tag;
	return {
		available: true,
		currentImage,
		targetImage: `dokploy/dokploy:${data.latestVersion}@${latest.digest}`,
		label: data.latestVersion,
		createdAt: parseDate(latest.created),
		allowed:
			movingTag ||
			allowedByVersionRule(rule, currentVersion, data.latestVersion),
	};
};
