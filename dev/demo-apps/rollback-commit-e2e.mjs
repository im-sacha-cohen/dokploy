// End-to-end check of compose rollbacks and commit deploys, against the real
// Docker daemon of the devbox:
//   A. raw compose: deploy v1, v2, roll back to v1 (retained images), redeploy v2;
//   B. Git compose: deploy the head (v2), then deploy commit v1 from a short SHA;
//   C. application: deploy the head, then deploy commit v1 from a full SHA.
// Every service is deleted at the end, unless KEEP=1 (to look at them in the UI).
// Usage, inside the devbox:
//   docker exec dokploy-devbox sh -c 'cd /workspace && DOKPLOY_DEV_URL=http://127.0.0.1:3000 node dev/demo-apps/rollback-commit-e2e.mjs'
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { call, login } from "./api-client.mjs";

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (path, params) =>
	call(`/api/${path}?${new URLSearchParams(params)}`, undefined, "GET");
const page = (host) => {
	try {
		return execFileSync("curl", [
			"-s",
			"-m",
			"5",
			"-H",
			`Host: ${host}`,
			"http://127.0.0.1/",
		])
			.toString()
			.trim();
	} catch (error) {
		return `curl failed: ${error.status}`;
	}
};
const pageEventually = async (host, expected) => {
	let body = "";
	for (let i = 0; i < 20; i++) {
		body = page(host);
		if (body === expected) break;
		await wait(1500);
	}
	return body;
};

const checkPage = async (name, host, expected) => {
	const body = await pageEventually(host, expected);
	check(name, body === expected, body.slice(0, 80));
};

const composeFile = (version) => `services:
  web:
    build:
      dockerfile_inline: |
        FROM nginx:alpine
        RUN echo "${version}" > /usr/share/nginx/html/index.html
  cache:
    image: redis:7-alpine
`;

const GIT_ROOT = "/workspace/dev/demo-apps/.repos";
const REPO = "rollback-commit-e2e";
const createRepo = () => {
	const work = mkdtempSync(join(tmpdir(), "rollback-e2e-"));
	const git = (...args) =>
		execFileSync("git", [
			"-C",
			work,
			"-c",
			"user.name=E2E",
			"-c",
			"user.email=e2e@dokploy.test",
			...args,
		])
			.toString()
			.trim();
	git("init", "-q", "-b", "main");
	const shas = [];
	for (const version of ["v1", "v2"]) {
		writeFileSync(
			join(work, "docker-compose.yml"),
			composeFile(`git-${version}`),
		);
		writeFileSync(
			join(work, "Dockerfile"),
			`FROM nginx:alpine\nRUN echo "app-${version}" > /usr/share/nginx/html/index.html\n`,
		);
		git("add", "-A");
		git("commit", "-q", "-m", version);
		shas.push(git("rev-parse", "HEAD"));
	}
	rmSync(join(GIT_ROOT, `${REPO}.git`), { recursive: true, force: true });
	execFileSync("git", [
		"clone",
		"-q",
		"--bare",
		work,
		join(GIT_ROOT, `${REPO}.git`),
	]);
	rmSync(work, { recursive: true, force: true });
	return shas;
};

/** Waits for a new compose deployment (newer than `after`) to finish. */
const settleCompose = async (composeId, after) => {
	for (let i = 0; i < 120; i++) {
		await wait(2000);
		const status = await get("smartDeploy.getComposeVersions", { composeId });
		const latest = status.history[0];
		if (
			latest &&
			latest.deploymentId !== after &&
			["done", "error"].includes(latest.status)
		) {
			return { status, latest };
		}
	}
	throw new Error("compose deployment did not finish");
};

const settleApplication = async (applicationId, after) => {
	for (let i = 0; i < 150; i++) {
		await wait(2000);
		const status = await get("smartDeploy.getVersionStatus", {
			applicationId,
			checkRemote: false,
		});
		const latest = status.history[0];
		if (
			latest &&
			latest.deploymentId !== after &&
			["done", "error"].includes(latest.status)
		) {
			return { status, latest };
		}
	}
	throw new Error("application deployment did not finish");
};

await login();
const demo = (await call("/api/project.all", undefined, "GET")).find(
	(p) => p.name === "Smart Deploy Demo",
);
const environmentId = demo.environments[0].environmentId;
const cleanup = [];

try {
	// A. Raw compose
	const raw = await call("/api/compose.create", {
		name: "rollback-raw-e2e",
		environmentId,
		composeType: "docker-compose",
	});
	cleanup.push(() =>
		call("/api/compose.delete", {
			composeId: raw.composeId,
			deleteVolumes: true,
		}),
	);
	const rawHost = "rollback-raw-e2e.docker.localhost";
	await call("/api/domain.create", {
		host: rawHost,
		port: 80,
		https: false,
		certificateType: "none",
		composeId: raw.composeId,
		serviceName: "web",
		domainType: "compose",
	});

	await call("/api/compose.update", {
		composeId: raw.composeId,
		sourceType: "raw",
		composePath: "./docker-compose.yml",
		composeFile: composeFile("raw-v1"),
	});
	await call("/api/compose.deploy", { composeId: raw.composeId });
	const v1 = await settleCompose(raw.composeId, null);
	check("A1 raw v1 deployed", v1.latest.status === "done", v1.latest.status);
	await checkPage("A1 page serves v1", rawHost, "raw-v1");
	check(
		"A1 both services recorded and kept",
		v1.latest.services
			.map((s) => s.service)
			.sort()
			.join(",") === "cache,web" && v1.latest.services.every((s) => s.retained),
		JSON.stringify(v1.latest.services.map((s) => s.service)),
	);
	check(
		"A1 v1 is the running version",
		v1.status.currentDeploymentId === v1.latest.deploymentId,
	);

	await call("/api/compose.update", {
		composeId: raw.composeId,
		composeFile: composeFile("raw-v2"),
	});
	await call("/api/compose.deploy", { composeId: raw.composeId });
	const v2 = await settleCompose(raw.composeId, v1.latest.deploymentId);
	check("A2 raw v2 deployed", v2.latest.status === "done");
	await checkPage("A2 page serves v2", rawHost, "raw-v2");
	check(
		"A2 v2 is running, v1 can be rolled back to",
		v2.status.currentDeploymentId === v2.latest.deploymentId &&
			v2.status.history.find((d) => d.deploymentId === v1.latest.deploymentId)
				?.redeployable === true,
	);

	await call("/api/smartDeploy.redeployComposeVersion", {
		deploymentId: v1.latest.deploymentId,
	});
	const back = await settleCompose(raw.composeId, v2.latest.deploymentId);
	check(
		"A3 rollback finished",
		back.latest.status === "done",
		back.latest.status,
	);
	check(
		"A3 recorded as a rollback of v1",
		back.latest.kind === "rollback" &&
			back.latest.sourceDeploymentId === v1.latest.deploymentId,
		`${back.latest.kind}`,
	);
	await checkPage("A3 page serves v1 again", rawHost, "raw-v1");
	check(
		"A3 the rollback is the running version",
		back.status.currentDeploymentId === back.latest.deploymentId,
	);
	const webV1 = v1.latest.services.find((s) => s.service === "web").imageId;
	const live = back.status.live.services.find((s) => s.service === "web");
	check(
		"A3 web runs the exact v1 image",
		live?.imageId === webV1,
		live?.imageId,
	);
	const appName = (await get("compose.one", { composeId: raw.composeId }))
		.appName;
	const config = execFileSync("docker", [
		"compose",
		"-p",
		appName,
		"ps",
		"--format",
		"{{.Service}} {{.Image}}",
	]).toString();
	check(
		"A3 compose runs the retained tags",
		/web dokploy-versions\//.test(config),
		config.trim(),
	);

	await call("/api/smartDeploy.redeployComposeVersion", {
		deploymentId: v2.latest.deploymentId,
	});
	const forward = await settleCompose(raw.composeId, back.latest.deploymentId);
	check(
		"A4 redeploy of v2 (newer than the running one) is a redeploy",
		forward.latest.status === "done" && forward.latest.kind === "redeploy",
		`${forward.latest.status} ${forward.latest.kind}`,
	);
	await checkPage("A4 page serves v2", rawHost, "raw-v2");

	let previous = forward.latest.deploymentId;
	for (const version of ["raw-v3", "raw-v4", "raw-v5", "raw-v6"]) {
		await call("/api/compose.update", {
			composeId: raw.composeId,
			composeFile: composeFile(version),
		});
		await call("/api/compose.deploy", { composeId: raw.composeId });
		previous = (await settleCompose(raw.composeId, previous)).latest
			.deploymentId;
	}
	const pruned = await get("smartDeploy.getComposeVersions", {
		composeId: raw.composeId,
	});
	const tags = execFileSync("docker", [
		"image",
		"ls",
		`dokploy-versions/${appName}`,
		"--format",
		"{{.Tag}}",
	])
		.toString()
		.trim()
		.split("\n")
		.filter(Boolean);
	const files = execFileSync("sh", [
		"-c",
		`ls /workspace/apps/dokploy/.docker/compose/${appName}/versions`,
	])
		.toString()
		.trim()
		.split("\n");
	check(
		"A6 only the last 5 captured deployments keep images",
		tags.length === 10 &&
			pruned.history.find((d) => d.deploymentId === v1.latest.deploymentId)
				?.redeployable === false &&
			pruned.history.find((d) => d.deploymentId === back.latest.deploymentId)
				?.redeployable === false &&
			pruned.history.find((d) => d.deploymentId === forward.latest.deploymentId)
				?.redeployable === true,
		`${tags.length} tags`,
	);
	check(
		"A6 compose files of pruned deployments are deleted",
		!files.includes(`dpl-${v1.latest.deploymentId}.yml`) &&
			files.includes(`dpl-${forward.latest.deploymentId}.yml`) &&
			files.length <= 10,
		files.join(" "),
	);

	let refused = false;
	try {
		await call("/api/smartDeploy.deployComposeCommit", {
			composeId: raw.composeId,
			commitSha: "abcdef1",
		});
	} catch (error) {
		refused = error.status === 400;
	}
	check("A5 commit deploy refused for a raw compose", refused);

	// B. Git compose
	const [sha1, sha2] = createRepo();
	const gitCompose = await call("/api/compose.create", {
		name: "rollback-git-e2e",
		environmentId,
		composeType: "docker-compose",
	});
	cleanup.push(() =>
		call("/api/compose.delete", {
			composeId: gitCompose.composeId,
			deleteVolumes: true,
		}),
	);
	const gitHost = "rollback-git-e2e.docker.localhost";
	await call("/api/compose.update", {
		composeId: gitCompose.composeId,
		sourceType: "git",
		customGitUrl: `http://127.0.0.1:4040/${REPO}.git`,
		customGitBranch: "main",
		composePath: "./docker-compose.yml",
	});
	await call("/api/domain.create", {
		host: gitHost,
		port: 80,
		https: false,
		certificateType: "none",
		composeId: gitCompose.composeId,
		serviceName: "web",
		domainType: "compose",
	});
	await call("/api/compose.deploy", { composeId: gitCompose.composeId });
	const head = await settleCompose(gitCompose.composeId, null);
	check(
		"B1 Git compose head deployed",
		head.latest.status === "done" && head.latest.builtCommitSha === sha2,
		head.latest.builtCommitSha,
	);
	await checkPage("B1 page serves git-v2", gitHost, "git-v2");

	const listed = await get("smartDeploy.listCommits", {
		serviceType: "compose",
		serviceId: gitCompose.composeId,
	});
	check(
		"B2 the branch's commits are listed, newest first",
		listed.status === "ok" &&
			listed.commits.map((c) => c.sha).join(",") === `${sha2},${sha1}` &&
			listed.commits[0].message === "v2",
		JSON.stringify(listed).slice(0, 160),
	);

	let badSha = false;
	try {
		await call("/api/smartDeploy.deployComposeCommit", {
			composeId: gitCompose.composeId,
			commitSha: "main; id",
		});
	} catch (error) {
		badSha = error.status === 400;
	}
	check("B2 a non-SHA is refused", badSha);

	await call("/api/smartDeploy.deployComposeCommit", {
		composeId: gitCompose.composeId,
		commitSha: sha1.slice(0, 7),
	});
	const old = await settleCompose(
		gitCompose.composeId,
		head.latest.deploymentId,
	);
	check(
		"B3 commit v1 deployed from a short SHA",
		old.latest.status === "done" &&
			old.latest.kind === "deploy_commit" &&
			old.latest.builtCommitSha === sha1,
		`${old.latest.status} ${old.latest.kind} ${old.latest.builtCommitSha}`,
	);
	await checkPage("B3 page serves git-v1", gitHost, "git-v1");

	await call("/api/smartDeploy.deployComposeCommit", {
		composeId: gitCompose.composeId,
		commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
	});
	const missing = await settleCompose(
		gitCompose.composeId,
		old.latest.deploymentId,
	);
	check(
		"B4 an unknown commit fails the deployment",
		missing.latest.status === "error",
	);
	await checkPage("B4 the running version is untouched", gitHost, "git-v1");

	// C. Application
	const app = await call("/api/application.create", {
		name: "commit-app-e2e",
		environmentId,
	});
	cleanup.push(() =>
		call("/api/application.delete", { applicationId: app.applicationId }),
	);
	await call("/api/application.saveGitProvider", {
		applicationId: app.applicationId,
		customGitUrl: `http://127.0.0.1:4040/${REPO}.git`,
		customGitBranch: "main",
		customGitBuildPath: "/",
		watchPaths: [],
	});
	await call("/api/application.saveBuildType", {
		applicationId: app.applicationId,
		buildType: "dockerfile",
		dockerfile: "Dockerfile",
		dockerContextPath: "",
		dockerBuildStage: "",
		herokuVersion: null,
		railpackVersion: null,
	});
	const appHost = "commit-app-e2e.docker.localhost";
	await call("/api/domain.create", {
		host: appHost,
		port: 80,
		https: false,
		certificateType: "none",
		applicationId: app.applicationId,
		domainType: "application",
	});
	await call("/api/application.deploy", { applicationId: app.applicationId });
	const appHead = await settleApplication(app.applicationId, null);
	check(
		"C1 application head deployed",
		appHead.latest.status === "done" && appHead.latest.builtCommitSha === sha2,
	);
	await checkPage("C1 page serves app-v2", appHost, "app-v2");

	await call("/api/smartDeploy.deployCommit", {
		applicationId: app.applicationId,
		commitSha: sha1.toUpperCase(),
	});
	const appOld = await settleApplication(
		app.applicationId,
		appHead.latest.deploymentId,
	);
	check(
		"C2 commit v1 deployed from a full SHA",
		appOld.latest.status === "done" &&
			appOld.latest.kind === "deploy_commit" &&
			appOld.latest.requestedCommitSha === sha1 &&
			appOld.latest.builtCommitSha === sha1,
		`${appOld.latest.kind} ${appOld.latest.builtCommitSha}`,
	);
	await checkPage("C2 page serves app-v1", appHost, "app-v1");
} catch (error) {
	check("scenario runs without exception", false, error.stack);
} finally {
	if (process.env.KEEP) cleanup.length = 0;
	for (const step of cleanup.reverse()) {
		await step().catch((error) => console.log(`cleanup: ${error.message}`));
	}
	if (!process.env.KEEP) {
		rmSync(join(GIT_ROOT, `${REPO}.git`), { recursive: true, force: true });
	}
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
