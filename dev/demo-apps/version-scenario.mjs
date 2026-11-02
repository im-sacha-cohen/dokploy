// Plays scenario E end to end on the LOCAL dev instance and checks that each
// deployment action records what it really did.
//   deploy latest → push v(n+1) → outdated → deploy latest → rollback → restart → rebuild
// Usage: node dev/demo-apps/version-scenario.mjs
import { execFileSync } from "node:child_process";
import http from "node:http";
import { call, login } from "./api-client.mjs";

const HTTP_PORT = Number(process.env.DOKPLOY_DEV_HTTP_PORT || 8880);
const results = [];
const check = (step, ok, detail) => {
	results.push({ step, ok, detail });
	console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const get = (path, params) =>
	call(`/api/${path}?${new URLSearchParams(params)}`, undefined, "GET");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchApp = (host) =>
	new Promise((resolve) => {
		const req = http.get(
			{
				host: "127.0.0.1",
				port: HTTP_PORT,
				path: "/",
				headers: { host },
				timeout: 5000,
			},
			(res) => {
				let body = "";
				res.on("data", (c) => (body += c));
				res.on("end", () =>
					resolve({ status: res.statusCode, body: body.trim() }),
				);
			},
		);
		req.on("error", (e) => resolve({ status: 0, body: e.message }));
	});

const deploymentsOf = async (applicationId) =>
	(await get("deployment.all", { applicationId })).sort((a, b) =>
		b.createdAt.localeCompare(a.createdAt),
	);

/** Waits for a new deployment row to finish and its verification to settle. */
const waitForNewDeployment = async (applicationId, previousIds) => {
	const deadline = Date.now() + 10 * 60 * 1000;
	while (Date.now() < deadline) {
		const fresh = (await deploymentsOf(applicationId)).find(
			(d) => !previousIds.has(d.deploymentId),
		);
		const settled =
			fresh &&
			fresh.status !== "running" &&
			!["pending", "verifying", null].includes(fresh.verificationStatus);
		if (settled) return fresh;
		await sleep(3000);
	}
	throw new Error("Timed out waiting for the deployment and its verification");
};

const runAction = async (applicationId, label, action) => {
	const before = new Set(
		(await deploymentsOf(applicationId)).map((d) => d.deploymentId),
	);
	await action();
	const d = await waitForNewDeployment(applicationId, before);
	console.log(
		`   ${label}: kind=${d.kind} status=${d.status} verification=${d.verificationStatus} built=${d.builtCommitSha?.slice(0, 7) ?? "-"} fetched=${d.fetchedCommitSha?.slice(0, 7) ?? "-"} requested=${d.requestedCommitSha?.slice(0, 7) ?? "-"} image=${d.imageId?.slice(7, 19) ?? "-"} tag=${d.imageTag ?? "-"}`,
	);
	return d;
};

await login();
const projects = await call("/api/project.all", undefined, "GET");
const app = projects
	.find((p) => p.name === "Smart Deploy Demo")
	?.environments.flatMap((e) => e.applications ?? [])
	.find((a) => a.name === "e-outdated");
if (!app) throw new Error("e-outdated not found: run seed.mjs first");
const { applicationId } = app;
const domain = (await get("domain.byApplicationId", { applicationId }))[0]
	?.host;

// 1. Deploy latest
const d1 = await runAction(applicationId, "deploy latest #1", () =>
	call("/api/application.deploy", { applicationId }),
);
check(
	"1. deploy latest enregistre kind=deploy_latest",
	d1.kind === "deploy_latest",
);
check(
	"1. commit demandé = récupéré = construit",
	!!d1.requestedCommitSha &&
		d1.requestedCommitSha === d1.fetchedCommitSha &&
		d1.fetchedCommitSha === d1.builtCommitSha,
	d1.builtCommitSha,
);
check(
	"1. image taguée par déploiement",
	d1.imageTag?.endsWith(`:dpl-${d1.deploymentId}`),
	d1.imageTag,
);
check(
	"1. vérification healthy",
	d1.verificationStatus === "healthy",
	JSON.stringify(d1.verification?.stages),
);
const v1Body = (await fetchApp(domain)).body;
let status = await get("smartDeploy.getVersionStatus", { applicationId });
check(
	"1. statut de version up_to_date (image exacte)",
	status.versionState === "up_to_date" && status.currentMatch === "image_match",
	status.versionReason,
);

// 2. Push a new commit without deploying
const pushed = execFileSync("docker", [
	"exec",
	"dokploy-devbox",
	"/workspace/dev/demo-apps/e-outdated-push-v2.sh",
])
	.toString()
	.trim();
console.log(`   ${pushed}`);
status = await get("smartDeploy.getVersionStatus", { applicationId });
check(
	"2. après push : outdated, commit distant vérifié",
	status.versionState === "outdated" &&
		status.latestRemote.status === "ok" &&
		status.latestRemote.sha !== d1.builtCommitSha,
	status.versionReason,
);
check(
	"2. action recommandée deploy_latest",
	status.recommendedAction === "deploy_latest",
);
const diag = await get("smartDeploy.diagnoseApplication", { applicationId });
check(
	"2. diagnostic GIT_COMMIT_OUTDATED",
	diag.findings.some((f) => f.code === "GIT_COMMIT_OUTDATED"),
	diag.findings.map((f) => f.code).join(", "),
);
const remoteSha = status.latestRemote.sha;

// 3. Deploy latest again
const d3 = await runAction(applicationId, "deploy latest #2", () =>
	call("/api/application.deploy", { applicationId }),
);
check(
	"3. nouveau commit construit = commit distant",
	d3.builtCommitSha === remoteSha,
);
check("3. nouvelle image", d3.imageId && d3.imageId !== d1.imageId);
const v2Body = (await fetchApp(domain)).body;
check(
	"3. l'application sert la nouvelle version",
	v2Body !== v1Body,
	`${v1Body} → ${v2Body}`,
);
status = await get("smartDeploy.getVersionStatus", { applicationId });
check(
	"3. statut up_to_date",
	status.versionState === "up_to_date",
	status.versionReason,
);

// 4. Roll back to the first deployment's image (no fetch, no build)
const d4 = await runAction(applicationId, "rollback", () =>
	call("/api/smartDeploy.redeployVersion", { deploymentId: d1.deploymentId }),
);
check(
	"4. kind=rollback, source = déploiement 1",
	d4.kind === "rollback" && d4.sourceDeploymentId === d1.deploymentId,
);
check("4. aucune récupération Git", d4.fetchedCommitSha === null);
check("4. même image que le déploiement 1", d4.imageId === d1.imageId);
check(
	"4. image réellement exécutée = image 1",
	d4.runningImageId === d1.imageId,
	d4.runningImageId,
);
check(
	"4. l'application sert l'ancienne version",
	(await fetchApp(domain)).body === v1Body,
);
status = await get("smartDeploy.getVersionStatus", { applicationId });
check(
	"4. statut outdated après rollback",
	status.versionState === "outdated" &&
		status.current?.deploymentId === d4.deploymentId,
	status.versionReason,
);

// 5. Restart keeps the running version
const d5 = await runAction(applicationId, "restart", () =>
	call("/api/smartDeploy.restartApplication", { applicationId }),
);
check(
	"5. kind=restart, même image",
	d5.kind === "restart" && d5.runningImageId === d1.imageId,
);
check("5. version servie inchangée", (await fetchApp(domain)).body === v1Body);

// 6. Rebuild: rebuilds the code directory without fetching
const d6 = await runAction(applicationId, "rebuild", () =>
	call("/api/application.redeploy", { applicationId }),
);
check(
	"6. kind=rebuild, aucune récupération Git",
	d6.kind === "rebuild" && d6.fetchedCommitSha === null,
);
check(
	"6. commit construit explicite (dossier de code = dernier clone)",
	d6.builtCommitSha === remoteSha,
	d6.builtCommitSha,
);

const failed = results.filter((r) => !r.ok);
console.log(
	`\n${results.length - failed.length}/${results.length} vérifications réussies`,
);
process.exitCode = failed.length ? 1 : 0;
