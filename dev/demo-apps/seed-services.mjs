// Adds broken-on-purpose databases and a compose stack to the "Smart Deploy
// Demo" project of the LOCAL dev instance (idempotent), to exercise Smart
// Deploy beyond applications:
//   h-pg-upgraded     postgres data created by 16, image switched to 17
//   i-mysql-bad-image image tag that does not exist
//   j-redis-pending   image changed in Dokploy but not deployed
//   k-mongo-stopped   deployed then stopped
//   l-pg-healthy      reference healthy database
//   m-compose-broken  web routed to the wrong port, worker crash-looping on a
//                     missing variable, compose variable without value
// Usage: node dev/demo-apps/seed-services.mjs
import { call, login } from "./api-client.mjs";

const PROJECT_NAME = "Smart Deploy Demo";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const qs = (params) => new URLSearchParams(params).toString();

const COMPOSE_FILE = `services:
  web:
    image: traefik/whoami:v1.10
    command: --port 8081
  worker:
    image: alpine:3.20
    command: ["sh", "-c", "echo starting worker; echo 'Error: QUEUE_URL is not set' >&2; exit 3"]
    restart: always
  api:
    image: traefik/whoami:v1.10
    command: --port 8082
    environment:
      - API_KEY=\${API_KEY}
`;

await login();
const project = (await call("/api/project.all", undefined, "GET")).find(
	(p) => p.name === PROJECT_NAME,
);
if (!project)
	throw new Error(`Run dev/demo-apps/seed.mjs first (${PROJECT_NAME})`);
const environment = project.environments[0];
const environmentId = environment.environmentId;
const existing = (key) => (environment[key] ?? []).map((s) => s.name);

const waitStatus = async (type, id, wanted, timeoutMs = 120_000) => {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const row = await call(
			`/api/${type}.one?${qs({ [`${type}Id`]: id })}`,
			undefined,
			"GET",
		);
		if (wanted.includes(row.applicationStatus)) return row.applicationStatus;
		await wait(3000);
	}
	return "timeout";
};

const createDb = async (type, name, extra) => {
	if (existing(type).includes(name)) {
		console.log(`${name} already exists`);
		return null;
	}
	const created = await call(`/api/${type}.create`, {
		name,
		appName: `demo-${name}`,
		environmentId,
		...extra,
	});
	const id =
		created?.[`${type}Id`] ??
		(await call("/api/project.all", undefined, "GET"))
			.find((p) => p.name === PROJECT_NAME)
			.environments[0][type].find((s) => s.name === name)[`${type}Id`];
	console.log(`created ${name}`);
	return id;
};

const password = () =>
	Math.random().toString(36).slice(2) + Date.now().toString(36);

// h: data written by postgres 16, then the image is switched to 17.
const h = await createDb("postgres", "h-pg-upgraded", {
	databaseName: "app",
	databaseUser: "app",
	databasePassword: password(),
	dockerImage: "postgres:16-alpine",
});
if (h) {
	await call("/api/postgres.deploy", { postgresId: h });
	console.log(
		"  h deployed with 16:",
		await waitStatus("postgres", h, ["done", "error"]),
	);
	await wait(15_000); // let initdb write the data directory
	await call("/api/postgres.update", {
		postgresId: h,
		dockerImage: "postgres:17-alpine",
	});
	await call("/api/postgres.deploy", { postgresId: h });
	console.log(
		"  h redeployed with 17:",
		await waitStatus("postgres", h, ["done", "error"]),
	);
}

const i = await createDb("mysql", "i-mysql-bad-image", {
	databaseName: "app",
	databaseUser: "app",
	databasePassword: password(),
	databaseRootPassword: password(),
	dockerImage: "mysql:9.99-does-not-exist",
});
if (i) {
	await call("/api/mysql.deploy", { mysqlId: i }).catch((e) =>
		console.log("  i deploy error (expected):", e.message.slice(0, 120)),
	);
}

const j = await createDb("redis", "j-redis-pending", {
	databasePassword: password(),
	dockerImage: "redis:7-alpine",
});
if (j) {
	await call("/api/redis.deploy", { redisId: j });
	console.log("  j deployed:", await waitStatus("redis", j, ["done", "error"]));
	await call("/api/redis.update", {
		redisId: j,
		dockerImage: "redis:7.4-alpine",
	});
}

const k = await createDb("mongo", "k-mongo-stopped", {
	databaseUser: "app",
	databasePassword: password(),
	dockerImage: "mongo:7",
});
if (k) {
	await call("/api/mongo.deploy", { mongoId: k });
	console.log("  k deployed:", await waitStatus("mongo", k, ["done", "error"]));
	await call("/api/mongo.stop", { mongoId: k });
	console.log("  k stopped");
}

const l = await createDb("postgres", "l-pg-healthy", {
	databaseName: "app",
	databaseUser: "app",
	databasePassword: password(),
	dockerImage: "postgres:17-alpine",
});
if (l) {
	await call("/api/postgres.deploy", { postgresId: l });
	console.log(
		"  l deployed:",
		await waitStatus("postgres", l, ["done", "error"]),
	);
}

if (existing("compose").includes("m-compose-broken")) {
	console.log("m-compose-broken already exists");
} else {
	const created = await call("/api/compose.create", {
		name: "m-compose-broken",
		appName: "demo-m-compose",
		environmentId,
		composeType: "docker-compose",
	});
	const composeId =
		created?.composeId ??
		(await call("/api/project.all", undefined, "GET"))
			.find((p) => p.name === PROJECT_NAME)
			.environments[0].compose.find((c) => c.name === "m-compose-broken")
			.composeId;
	await call("/api/compose.update", {
		composeId,
		sourceType: "raw",
		composeFile: COMPOSE_FILE,
	});
	await call("/api/domain.create", {
		host: "m-compose.docker.localhost",
		port: 80,
		https: false,
		certificateType: "none",
		composeId,
		serviceName: "web",
		domainType: "compose",
	});
	await call("/api/compose.deploy", { composeId });
	console.log("created and deployed m-compose-broken");
}
console.log(
	"Done. Give the deployments a minute, then run diagnose-services.mjs.",
);
