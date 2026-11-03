import { findMariadbById } from "@dokploy/server/services/mariadb";
import { findMongoById } from "@dokploy/server/services/mongo";
import { findMySqlById } from "@dokploy/server/services/mysql";
import { findPostgresById } from "@dokploy/server/services/postgres";
import { findRedisById } from "@dokploy/server/services/redis";
import { getEnvironmentVariablesObject } from "@dokploy/server/utils/docker/utils";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import type Dockerode from "dockerode";
import { parseEnvFileKeys } from "../log-patterns";
import { createRedactor, type Redactor, redactLines } from "../redact";
import type { DatabaseType, DiagnosticContext } from "../types";
import { demuxDockerOutput, withTimeout } from "./docker-io";
import {
	collectSwarmService,
	errorMessage,
	isNotFound,
	LOG_TAIL_LINES,
} from "./swarm";

export const DATABASE_DEFAULT_PORTS: Record<DatabaseType, number> = {
	postgres: 5432,
	mysql: 3306,
	mariadb: 3306,
	mongo: 27017,
	redis: 6379,
};

const loaders = {
	postgres: findPostgresById,
	mysql: findMySqlById,
	mariadb: findMariadbById,
	mongo: findMongoById,
	redis: findRedisById,
} satisfies Record<DatabaseType, (id: string) => Promise<unknown>>;

export interface DatabaseRow {
	name: string;
	appName: string;
	serverId: string | null;
	dockerImage: string;
	externalPort: number | null;
	env: string | null;
	databasePassword?: string | null;
	databaseRootPassword?: string | null;
	environment: {
		env: string | null;
		project: { organizationId: string; env: string | null };
	};
}

/**
 * When the image is not on the server, asks the registry whether it exists:
 * Dokploy fails before creating the service when the pull fails, so no task
 * carries the error. Returns the registry's refusal, or null.
 */
const checkImageAvailability = async (
	docker: Dockerode,
	image: string,
): Promise<string | null> => {
	try {
		await docker.getImage(image).inspect();
		return null;
	} catch (error) {
		if (!isNotFound(error)) return null;
	}
	try {
		await withTimeout(
			(
				docker.getImage(image) as unknown as {
					distribution: () => Promise<unknown>;
				}
			).distribution(),
			8_000,
			"registry",
		);
		return null;
	} catch (error) {
		// A timeout says nothing about the image.
		return /timed out/.test(errorMessage(error)) ? null : errorMessage(error);
	}
};

/**
 * Swarm rolls a failed update back to the previous image, and the failure
 * then scrolls out of the service logs: read the tasks that ran `image`.
 */
const collectAttemptLogs = async (
	docker: Dockerode,
	serviceName: string,
	image: string,
	redact: Redactor,
) => {
	const tasks = await docker.listTasks({
		filters: JSON.stringify({ service: [serviceName] }),
	});
	const attempts = tasks
		.filter((t) => t.Spec?.ContainerSpec?.Image?.split("@")[0] === image)
		.sort((a, b) => (b.UpdatedAt ?? "").localeCompare(a.UpdatedAt ?? ""))
		.slice(0, 2);
	const lines: string[] = [];
	for (const task of attempts) {
		const raw = (await withTimeout(
			(
				docker.getTask(task.ID) as unknown as {
					logs: (opts: object) => Promise<Buffer | string>;
				}
			).logs({ stdout: true, stderr: true, tail: LOG_TAIL_LINES }),
			10_000,
			"task logs",
		)) as Buffer | string;
		const text = Buffer.isBuffer(raw) ? demuxDockerOutput(raw) : String(raw);
		lines.push(...redactLines(text.split("\n"), redact, LOG_TAIL_LINES));
	}
	return lines;
};

export const loadDatabase = async (type: DatabaseType, id: string) =>
	(await loaders[type](id)) as unknown as DatabaseRow;

/** Read-only facts about a database service (Swarm service named appName). */
export const collectDatabaseContext = async (
	type: DatabaseType,
	id: string,
	options: { now?: Date } = {},
): Promise<DiagnosticContext> => {
	const db = await loadDatabase(type, id);
	const now = options.now ?? new Date();
	let env: Record<string, string> = {};
	try {
		env = getEnvironmentVariablesObject(
			db.env,
			db.environment.project.env,
			db.environment.env,
		);
	} catch {
		env = Object.fromEntries(
			parseEnvFileKeys(db.env ?? "").map((key) => [key, ""]),
		);
	}
	const redact = createRedactor({
		...env,
		...(db.databasePassword ? { databasePassword: db.databasePassword } : {}),
		...(db.databaseRootPassword
			? { databaseRootPassword: db.databaseRootPassword }
			: {}),
	});

	const ctx: DiagnosticContext = {
		now,
		target: {
			type,
			id,
			name: db.name,
			appName: db.appName,
			serverId: db.serverId ?? null,
		},
		config: {
			domains: [],
			publishedPorts: [],
			envKeys: Object.keys(env),
			swarmHealthcheckConfigured: false,
		},
		database: {
			engine: type,
			defaultPort: DATABASE_DEFAULT_PORTS[type],
			externalPort: db.externalPort ?? null,
			configuredImage: db.dockerImage,
		},
		collectionErrors: [],
	};

	try {
		const docker = await getRemoteDocker(db.serverId);
		const { publishedPorts } = await collectSwarmService(
			docker,
			db.appName,
			ctx,
			redact,
		);
		ctx.config.publishedPorts = publishedPorts.map((p) => ({
			publishedPort: p.published,
			targetPort: p.target,
			protocol: "tcp",
		}));
		const runningImage = ctx.service?.image?.split("@")[0];
		if (runningImage && runningImage !== db.dockerImage) {
			try {
				ctx.previousAttemptLogs = await collectAttemptLogs(
					docker,
					db.appName,
					db.dockerImage,
					redact,
				);
			} catch (error) {
				ctx.collectionErrors.push({
					source: "application_logs",
					message: errorMessage(error),
				});
			}
		}
		if (!ctx.container) {
			const unavailable = await checkImageAvailability(docker, db.dockerImage);
			if (unavailable && ctx.database)
				ctx.database.imageUnavailable = unavailable;
		}
	} catch (error) {
		ctx.collectionErrors.push({
			source: "docker_service",
			message: errorMessage(error),
		});
	}
	return ctx;
};
