// Creates the "Smart Deploy Demo" project with demo apps A–G on a LOCAL Dokploy
// dev instance, through the public REST API (same code paths as the UI).
//
// Usage (from the host):
//   node dev/demo-apps/seed.mjs [--deploy]
// Reads DOKPLOY_DEV_URL, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD from dev/.env.
// On a fresh instance, the first account becomes the owner (test account only).
import { call, login } from "./api-client.mjs";

const deploy = process.argv.includes("--deploy");
const GIT = "http://127.0.0.1:4040";
const PROJECT_NAME = "Smart Deploy Demo";

const apps = [
	{ key: "a-healthy", domainPort: 3000, note: "normal deployment" },
	{
		key: "b-wrong-port",
		domainPort: 80,
		note: "app listens on 3000, domain routed to 80",
	},
	{ key: "c-crash-loop", domainPort: 3000, note: "exits at startup" },
	{
		key: "d-missing-env",
		domainPort: 3000,
		note: "DATABASE_URL / SESSION_SECRET not set",
	},
	{
		key: "e-outdated",
		domainPort: 3000,
		note: "run e-outdated-push-v2.sh after deploying",
	},
	{
		key: "g-localhost-bind",
		domainPort: 3000,
		note: "listens on 127.0.0.1 only",
	},
];

async function main() {
	await login();
	const projects = await call("/api/project.all", undefined, "GET");
	if (projects.some((p) => p.name === PROJECT_NAME)) {
		console.log(`Project "${PROJECT_NAME}" already exists, nothing to do.`);
		return;
	}

	const created = await call("/api/project.create", {
		name: PROJECT_NAME,
		description: "Demo apps for diagnostics and version tracking",
	});
	const environmentId = created.environment?.environmentId;
	if (!environmentId)
		throw new Error(
			`Unexpected project.create response: ${JSON.stringify(created)}`,
		);

	for (const app of apps) {
		const { applicationId, appName } = await call("/api/application.create", {
			name: app.key,
			appName: `demo-${app.key}`,
			description: app.note,
			environmentId,
		});
		await call("/api/application.saveGitProvider", {
			applicationId,
			customGitUrl: `${GIT}/${app.key}.git`,
			customGitBranch: "main",
			customGitBuildPath: "/",
			watchPaths: [],
		});
		await call("/api/application.saveBuildType", {
			applicationId,
			buildType: "dockerfile",
			dockerfile: "Dockerfile",
			dockerContextPath: "",
			dockerBuildStage: "",
			herokuVersion: null,
			railpackVersion: null,
		});
		await call("/api/domain.create", {
			host: `${app.key}.docker.localhost`,
			port: app.domainPort,
			https: false,
			certificateType: "none",
			applicationId,
			domainType: "application",
		});
		console.log(`created ${app.key} (${appName})`);
		if (deploy) await call("/api/application.deploy", { applicationId });
	}

	const { composeId } = await call("/api/compose.create", {
		name: "f-compose",
		appName: "demo-f-compose",
		description: "web + redis with healthchecks",
		environmentId,
		composeType: "docker-compose",
	});
	await call("/api/compose.update", {
		composeId,
		sourceType: "git",
		customGitUrl: `${GIT}/f-compose.git`,
		customGitBranch: "main",
		composePath: "./docker-compose.yml",
	});
	await call("/api/domain.create", {
		host: "f-compose.docker.localhost",
		port: 3000,
		https: false,
		certificateType: "none",
		composeId,
		serviceName: "web",
		domainType: "compose",
	});
	console.log("created f-compose");
	if (deploy) await call("/api/compose.deploy", { composeId });

	console.log(
		"Done. Apps are reachable at http://<name>.docker.localhost:<DOKPLOY_DEV_HTTP_PORT> once deployed.",
	);
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
