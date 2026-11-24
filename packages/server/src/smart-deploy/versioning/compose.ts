import { dirname, join } from "node:path";
import { paths } from "@dokploy/server/constants";
import { db } from "@dokploy/server/db";
import {
	type ComposeServiceImage,
	type DeploymentKind,
	deployments,
} from "@dokploy/server/db/schema";
import {
	findComposeById,
	updateCompose,
} from "@dokploy/server/services/compose";
import {
	createDeploymentCompose,
	findDeploymentById,
	updateDeploymentStatus,
} from "@dokploy/server/services/deployment";
import { getCreateEnvFileCommand } from "@dokploy/server/utils/builders/compose";
import {
	addDomainToCompose,
	applyComposeFilePatch,
	getComposePath,
} from "@dokploy/server/utils/docker/domain";
import { encodeBase64 } from "@dokploy/server/utils/docker/utils";
import { withResolvedVaultRefs } from "@dokploy/server/utils/vault";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { quote } from "shell-quote";
import { stringify } from "yaml";
import { safely, updateTracking } from "./capture";
import { runOn, SHA_PATTERN } from "./shell";
import { describeSource } from "./source";

type Compose = Awaited<ReturnType<typeof findComposeById>>;

export const KEPT_COMPOSE_VERSIONS = 5;

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const VERSION_FILE = /^(dpl|run)-[A-Za-z0-9_-]+\.yml$/;

/**
 * Same repository as application versions (`dokploy-versions/<appName>`);
 * app names are unique across services, so the tags never collide.
 */
export const composeImageTag = (
	appName: string,
	deploymentId: string,
	service: string,
) => {
	const tag = `dpl-${deploymentId}-${service}`;
	return TAG.test(tag) ? `dokploy-versions/${appName}:${tag}` : null;
};

const versionsDir = (compose: Pick<Compose, "serverId" | "appName">) =>
	join(paths(!!compose.serverId).COMPOSE_PATH, compose.appName, "versions");

/** The compose file a deployment started from, before Dokploy added its domains. */
export const composeSnapshotPath = (
	compose: Pick<Compose, "serverId" | "appName">,
	deploymentId: string,
) => join(versionsDir(compose), `dpl-${deploymentId}.yml`);

const composeRunPath = (
	compose: Pick<Compose, "serverId" | "appName">,
	deploymentId: string,
) => join(versionsDir(compose), `run-${deploymentId}.yml`);

/** Why a stack cannot be captured and run again, or null when it can. */
export const composeRollbackUnavailableReason = (
	compose: Pick<Compose, "composeType" | "command">,
): string | null => {
	if (compose.composeType !== "docker-compose") {
		return "Rollback is only available for docker-compose stacks, not Swarm stacks";
	}
	if (compose.command?.trim()) {
		return "Rollback is not available with a custom compose command: Dokploy cannot know which files and flags it runs";
	}
	return null;
};

export const isGitCompose = (compose: Pick<Compose, "sourceType">) =>
	compose.sourceType !== "raw";

const sourceOf = (compose: Compose) => describeSource(compose);

/** Parses `service|imageId|image` lines; a scaled service appears once. */
export const parseComposeContainers = (stdout: string) => {
	const services = new Map<string, { imageId: string; image: string }>();
	for (const line of stdout.split("\n")) {
		const [service, imageId, image] = line.trim().split("|");
		if (!service || !IMAGE_ID.test(imageId ?? "") || services.has(service)) {
			continue;
		}
		services.set(service, { imageId: imageId as string, image: image ?? "" });
	}
	return services;
};

const listComposeContainers = async (
	compose: Pick<Compose, "serverId" | "appName">,
	options: { runningOnly: boolean },
) => {
	const filters = [
		`label=com.docker.compose.project=${compose.appName}`,
		"label=com.docker.compose.oneoff=False",
		...(options.runningOnly ? ["status=running"] : []),
	]
		.map((f) => `--filter ${quote([f])}`)
		.join(" ");
	const result = await runOn(
		compose.serverId,
		`ids=$(docker ps -aq ${filters}); [ -z "$ids" ] || docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}|{{.Image}}|{{.Config.Image}}' $ids`,
	);
	return {
		ok: result.ok,
		reason: result.ok ? undefined : result.stderr.slice(0, 200),
		services: parseComposeContainers(result.stdout),
	};
};

export const trackComposeStart = (
	deploymentId: string,
	compose: Compose,
	kind: DeploymentKind,
	requestedCommitSha?: string | null,
) =>
	safely("trackComposeStart", async () => {
		const source = sourceOf(compose);
		await updateTracking(deploymentId, {
			kind,
			sourceRepository: source.repository,
			sourceBranch: source.branch,
			requestedCommitSha: requestedCommitSha ?? null,
		});
	});

/**
 * Keeps the compose file exactly as `addDomainToCompose` is about to read it
 * (raw content, compose-file patch, or the file on disk), so a rollback can
 * redo the same domain and isolation processing with today's domains.
 */
export const snapshotComposeSource = (deploymentId: string, compose: Compose) =>
	safely("snapshotComposeSource", async () => {
		if (composeRollbackUnavailableReason(compose)) return;
		let content: string | null = null;
		if (compose.sourceType === "raw") {
			content = compose.composeFile;
		} else {
			const patched = await applyComposeFilePatch(compose);
			if (patched) {
				content = stringify(patched, { lineWidth: 1000 });
			} else {
				const read = await runOn(
					compose.serverId,
					`cat ${quote([getComposePath(compose)])}`,
				);
				if (read.ok) content = read.stdout;
			}
		}
		if (!content?.trim()) return;
		const target = composeSnapshotPath(compose, deploymentId);
		await runOn(
			compose.serverId,
			`mkdir -p ${quote([versionsDir(compose)])} && echo ${quote([encodeBase64(content)])} | base64 -d > ${quote([target])}`,
		);
	});

/**
 * Called once `docker compose up` succeeded: records the image each service
 * runs, tags it so it survives later deploys, and the commit of the clone.
 */
export const trackComposeArtifacts = (deploymentId: string, compose: Compose) =>
	safely("trackComposeArtifacts", async () => {
		const data: Parameters<typeof updateTracking>[1] = {};
		if (isGitCompose(compose)) {
			const codeDir = join(
				paths(!!compose.serverId).COMPOSE_PATH,
				compose.appName,
				"code",
			);
			const head = await runOn(
				compose.serverId,
				`git -C ${quote([codeDir])} rev-parse HEAD`,
			);
			const sha = head.stdout.trim();
			if (SHA_PATTERN.test(sha)) {
				data.builtCommitSha = sha;
				data.fetchedCommitSha = sha;
			}
		}

		if (!composeRollbackUnavailableReason(compose)) {
			const containers = await listComposeContainers(compose, {
				runningOnly: false,
			});
			const images: ComposeServiceImage[] = [];
			for (const [service, { imageId, image }] of containers.services) {
				const tag = composeImageTag(compose.appName, deploymentId, service);
				const tagged = tag
					? await runOn(compose.serverId, `docker tag ${quote([imageId, tag])}`)
					: null;
				images.push({
					service,
					image,
					imageId,
					tag: tagged?.ok ? tag : null,
				});
			}
			if (images.length > 0) data.composeImages = images;
		}

		await updateTracking(deploymentId, data);
		if (data.composeImages) await pruneComposeVersions(compose);
	});

/**
 * Keeps the images and compose files of the last KEPT_COMPOSE_VERSIONS
 * captured deployments. Images are untagged, never forced, so one still in
 * use stays on disk; rows deleted by Dokploy's own cleanup are covered too
 * because the actual tags and files are listed.
 */
export const pruneComposeVersions = (
	compose: Pick<Compose, "composeId" | "serverId" | "appName">,
) =>
	safely("pruneComposeVersions", async () => {
		const rows = await db
			.select({
				deploymentId: deployments.deploymentId,
				composeImages: deployments.composeImages,
			})
			.from(deployments)
			.where(
				and(
					eq(deployments.composeId, compose.composeId),
					isNotNull(deployments.composeImages),
				),
			)
			.orderBy(desc(deployments.createdAt));

		const kept = rows.slice(0, KEPT_COMPOSE_VERSIONS);
		const keptTags = new Set(
			kept.flatMap((r) => (r.composeImages ?? []).map((s) => s.tag)),
		);
		const keptFiles = new Set(
			kept.flatMap((r) => [
				`dpl-${r.deploymentId}.yml`,
				`run-${r.deploymentId}.yml`,
			]),
		);

		for (const row of rows.slice(KEPT_COMPOSE_VERSIONS)) {
			const images = row.composeImages ?? [];
			if (images.some((s) => s.tag && !keptTags.has(s.tag))) {
				await updateTracking(row.deploymentId, {
					composeImages: images.map((s) =>
						s.tag && keptTags.has(s.tag) ? s : { ...s, tag: null },
					),
				});
			}
		}

		const listed = await runOn(
			compose.serverId,
			`docker image ls ${quote([`dokploy-versions/${compose.appName}`])} --format '{{.Repository}}:{{.Tag}}'`,
		);
		const ownPrefix = `dokploy-versions/${compose.appName}:dpl-`;
		for (const tag of listed.stdout.split("\n").map((l) => l.trim())) {
			if (tag.startsWith(ownPrefix) && !keptTags.has(tag)) {
				await runOn(compose.serverId, `docker image rm ${quote([tag])}`);
			}
		}

		const files = await runOn(
			compose.serverId,
			`ls -1 ${quote([versionsDir(compose)])} 2>/dev/null || true`,
		);
		const stale = files.stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((name) => VERSION_FILE.test(name) && !keptFiles.has(name));
		if (stale.length > 0) {
			await runOn(
				compose.serverId,
				`rm -f ${stale.map((name) => quote([join(versionsDir(compose), name)])).join(" ")}`,
			);
		}
	});

export interface ComposeVersion {
	deploymentId: string;
	createdAt: string;
	title: string;
	kind: string | null;
	status: string | null;
	requestedCommitSha: string | null;
	builtCommitSha: string | null;
	sourceDeploymentId: string | null;
	/**
	 * When the version this row runs was first built: its own date, or for a
	 * rollback or redeploy, the date of the deployment it ran again.
	 */
	versionCreatedAt: string;
	services: {
		service: string;
		image: string;
		imageId: string;
		retained: boolean;
	}[];
	/** Whether this deployment's images can be run again without rebuilding. */
	redeployable: boolean;
}

export interface ComposeVersionStatus {
	composeId: string;
	source: ReturnType<typeof describeSource>;
	/** Deploying a specific commit needs a Git source. */
	canDeployCommit: boolean;
	rollbackUnavailableReason: string | null;
	live: {
		collected: boolean;
		reason?: string;
		services: { service: string; imageId: string; image: string }[];
	};
	/** The deployment whose recorded images are exactly the running ones. */
	currentDeploymentId: string | null;
	history: ComposeVersion[];
}

type DeploymentRow = typeof deployments.$inferSelect;

/** Follows rollback/redeploy rows back to the build they ran again. */
export const versionCreatedAt = (
	row: Pick<DeploymentRow, "deploymentId" | "createdAt" | "sourceDeploymentId">,
	byId: Map<
		string,
		Pick<DeploymentRow, "deploymentId" | "createdAt" | "sourceDeploymentId">
	>,
) => {
	let current = row;
	for (let hop = 0; hop < 20 && current.sourceDeploymentId; hop++) {
		const next = byId.get(current.sourceDeploymentId);
		if (!next) break;
		current = next;
	}
	return current.createdAt;
};

const toComposeVersion = (
	d: DeploymentRow,
	unavailable: string | null,
	byId: Map<string, DeploymentRow>,
): ComposeVersion => {
	const images = d.composeImages ?? [];
	return {
		deploymentId: d.deploymentId,
		createdAt: d.createdAt,
		versionCreatedAt: versionCreatedAt(d, byId),
		title: d.title,
		kind: d.kind,
		status: d.status,
		requestedCommitSha: d.requestedCommitSha,
		builtCommitSha: d.builtCommitSha,
		sourceDeploymentId: d.sourceDeploymentId,
		services: images.map((s) => ({
			service: s.service,
			image: s.image,
			imageId: s.imageId,
			retained: !!s.tag,
		})),
		redeployable:
			!unavailable &&
			d.status === "done" &&
			images.length > 0 &&
			images.every((s) => !!s.tag),
	};
};

/**
 * Every running service runs the image this deployment recorded for it.
 * Recorded services that are not running (one-shot jobs that exited) are
 * not counted against it.
 */
export const matchesRunning = (
	images: Pick<ComposeServiceImage, "service" | "imageId">[],
	running: Map<string, { imageId: string }>,
) => {
	if (images.length === 0 || running.size === 0) return false;
	const recorded = new Map(images.map((s) => [s.service, s.imageId]));
	return [...running].every(
		([service, { imageId }]) => recorded.get(service) === imageId,
	);
};

export const getComposeVersionStatus = async (
	composeId: string,
): Promise<ComposeVersionStatus> => {
	const compose = await findComposeById(composeId);
	const unavailable = composeRollbackUnavailableReason(compose);
	const [live, rows] = await Promise.all([
		listComposeContainers(compose, { runningOnly: true }),
		db.query.deployments.findMany({
			where: eq(deployments.composeId, composeId),
			orderBy: desc(deployments.createdAt),
			limit: 20,
		}),
	]);
	const current = live.ok
		? rows.find(
				(d) =>
					d.status === "done" &&
					matchesRunning(d.composeImages ?? [], live.services),
			)
		: undefined;
	return {
		composeId,
		source: sourceOf(compose),
		canDeployCommit: isGitCompose(compose),
		rollbackUnavailableReason: unavailable,
		live: {
			collected: live.ok,
			reason: live.reason,
			services: [...live.services].map(([service, v]) => ({ service, ...v })),
		},
		currentDeploymentId: current?.deploymentId ?? null,
		history: rows.map((d) =>
			toComposeVersion(
				d,
				unavailable,
				new Map(rows.map((r) => [r.deploymentId, r])),
			),
		),
	};
};

export const assertComposeRedeployable = async (sourceDeploymentId: string) => {
	const source = await findDeploymentById(sourceDeploymentId);
	if (!source.composeId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "This is not a compose deployment",
		});
	}
	const compose = await findComposeById(source.composeId);
	const unavailable = composeRollbackUnavailableReason(compose);
	if (unavailable) {
		throw new TRPCError({ code: "BAD_REQUEST", message: unavailable });
	}
	const images = source.composeImages ?? [];
	if (
		source.status !== "done" ||
		images.length === 0 ||
		images.some((s) => !s.tag)
	) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: `This deployment has no retained images (only the last ${KEPT_COMPOSE_VERSIONS} successful deployments are kept)`,
		});
	}
	return { source, compose };
};

/** Applies the retained images to a parsed compose file; returns services left untouched. */
export const pinComposeImages = (
	spec: { services?: Record<string, Record<string, unknown>> },
	images: ComposeServiceImage[],
) => {
	const pinned = new Set<string>();
	for (const { service, tag } of images) {
		const definition = spec.services?.[service];
		if (!definition || !tag) continue;
		definition.image = tag;
		// `pull_policy: always|build` would override `--pull never`/`--no-build`.
		delete definition.pull_policy;
		pinned.add(service);
	}
	return Object.keys(spec.services ?? {}).filter((s) => !pinned.has(s));
};

export const buildComposeRunCommand = ({
	compose,
	runFile,
	envCommand,
}: {
	compose: Pick<
		Compose,
		| "serverId"
		| "appName"
		| "sourceType"
		| "composePath"
		| "createEnvFile"
		| "isolatedDeployment"
	> & { mounts: unknown[] };
	runFile: string;
	envCommand: string;
}) => {
	const codeDir = join(
		paths(!!compose.serverId).COMPOSE_PATH,
		compose.appName,
		"code",
	);
	const composeRel =
		compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
	// Mirrors createCommand: relative paths resolve from the code root when the
	// stack has mounts, otherwise from the compose file's folder.
	const projectDir =
		compose.mounts.length > 0 ? codeDir : dirname(join(codeDir, composeRel));
	const envFileFlag = compose.createEnvFile
		? `--env-file ${quote([join(codeDir, dirname(composeRel), ".env")])} `
		: "";
	const network = quote([compose.appName]);
	return `set -e;
mkdir -p ${quote([projectDir])};
${envCommand}
cd ${quote([projectDir])};
${compose.isolatedDeployment ? `docker network inspect ${network} >/dev/null 2>&1 || docker network create --attachable ${network};` : ""}
env -i PATH="$PATH" HOME="$HOME" docker compose -p ${quote([compose.appName])} --project-directory ${quote([projectDir])} ${envFileFlag}-f ${quote([runFile])} up -d --no-build --pull never --remove-orphans 2>&1;
${compose.isolatedDeployment ? `docker network connect ${network} $(docker ps --filter "name=dokploy-traefik" -q) >/dev/null 2>&1 || true;` : ""}
`;
};

const appendLog = (serverId: string | null, logPath: string, line: string) =>
	runOn(serverId, `echo ${quote([line])} >> ${quote([logPath])}`);

/**
 * Runs again the exact images of an earlier compose deployment, with the
 * compose file it started from and today's domains and environment. Nothing
 * is fetched, pulled or built.
 */
export const redeployComposeVersion = async ({
	sourceDeploymentId,
}: {
	sourceDeploymentId: string;
}) => {
	const { source, compose } =
		await assertComposeRedeployable(sourceDeploymentId);
	const serverId = compose.serverId;
	const images = source.composeImages as ComposeServiceImage[];

	const status = await getComposeVersionStatus(compose.composeId);
	const running =
		status.history.find((d) => d.deploymentId === status.currentDeploymentId) ??
		status.history.find((d) => d.status === "done");
	const sourceVersionAt =
		status.history.find((d) => d.deploymentId === source.deploymentId)
			?.versionCreatedAt ?? source.createdAt;
	const kind: DeploymentKind =
		running && sourceVersionAt < running.versionCreatedAt
			? "rollback"
			: "redeploy";
	const version = source.builtCommitSha?.slice(0, 7) ?? source.deploymentId;

	const deployment = await createDeploymentCompose({
		composeId: compose.composeId,
		title: `${kind === "rollback" ? "Rollback" : "Redeploy"} to ${version}`,
		description: "Retained images (no fetch, no pull, no build)",
	});
	await updateTracking(deployment.deploymentId, {
		kind,
		sourceDeploymentId: source.deploymentId,
		sourceRepository: source.sourceRepository,
		sourceBranch: source.sourceBranch,
		requestedCommitSha: source.builtCommitSha,
		builtCommitSha: source.builtCommitSha,
		composeImages: images,
	});

	const log = (line: string) => appendLog(serverId, deployment.logPath, line);
	try {
		for (const image of images) {
			const inspect = await runOn(
				serverId,
				`docker image inspect ${quote([image.tag as string])} --format '{{.Id}}'`,
			);
			if (!inspect.ok || inspect.stdout.trim() !== image.imageId) {
				throw new Error(
					`Image ${image.tag} of service ${image.service} is missing or no longer matches ${image.imageId}`,
				);
			}
		}

		const snapshotPath = composeSnapshotPath(compose, source.deploymentId);
		const snapshot = await runOn(serverId, `cat ${quote([snapshotPath])}`);
		if (!snapshot.ok || !snapshot.stdout.trim()) {
			throw new Error(
				"The compose file of this deployment is no longer on the server",
			);
		}

		// Raw keeps addDomainToCompose from reading the current file or patch.
		const spec = await addDomainToCompose(
			{ ...compose, sourceType: "raw", composeFile: snapshot.stdout },
			compose.domains,
		);
		if (!spec) throw new Error("The retained compose file could not be read");
		const untouched = pinComposeImages(
			spec as { services?: Record<string, Record<string, unknown>> },
			images,
		);

		const runFile = composeRunPath(compose, deployment.deploymentId);
		const resolved = await withResolvedVaultRefs(compose);
		await log(
			`Running ${images.length} retained image(s) from deployment ${source.deploymentId}: ${images.map((i) => i.service).join(", ")}`,
		);
		if (untouched.length > 0) {
			await log(
				`Services without a retained image (run as declared, never pulled): ${untouched.join(", ")}`,
			);
		}
		const command = `mkdir -p ${quote([versionsDir(compose)])};
echo ${quote([encodeBase64(stringify(spec, { lineWidth: 1000 }))])} | base64 -d > ${quote([runFile])};
cp ${quote([snapshotPath, composeSnapshotPath(compose, deployment.deploymentId)])};
${buildComposeRunCommand({
	compose,
	runFile,
	envCommand: compose.createEnvFile ? getCreateEnvFileCommand(resolved) : "",
})}`;
		const run = await runOn(
			serverId,
			`(${command}) >> ${quote([deployment.logPath])} 2>&1`,
		);
		if (!run.ok)
			throw new Error("docker compose up failed (see the log above)");

		const live = await listComposeContainers(compose, { runningOnly: false });
		const mismatched = images.filter(
			(i) => live.services.get(i.service)?.imageId !== i.imageId,
		);
		for (const image of images) {
			await log(
				`${mismatched.includes(image) ? "❌" : "✅"} ${image.service}: ${live.services.get(image.service)?.imageId ?? "no container"} (expected ${image.imageId})`,
			);
		}
		if (mismatched.length > 0) {
			throw new Error(
				`Not running the retained image: ${mismatched.map((i) => i.service).join(", ")}`,
			);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(compose.composeId, { composeStatus: "done" });
		await log("Docker Compose rolled back: ✅");
		await pruneComposeVersions(compose);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await log(`❌ ${message}`);
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(compose.composeId, { composeStatus: "error" });
		throw error;
	}
	return deployment;
};
