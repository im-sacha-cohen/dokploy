// Real check of the fork-aware Update button against GHCR and Docker Swarm.
// A probe service (0 replicas: nothing is pulled or started) is created from
// an older build of the fork, the update check must offer the latest build,
// the same `docker service update --image` as the button moves the probe to
// it, and the check must then say up to date. The probe is removed at the end.
// Usage, inside the devbox (tsx for the TypeScript import, network for GHCR):
//   docker exec dokploy-devbox sh -c 'cd /workspace && apps/dokploy/node_modules/.bin/tsx dev/demo-apps/fork-update-e2e.mjs [old-tag]'
import { execFileSync } from "node:child_process";
import {
	getCustomImageUpdateData,
	getRegistryImageInfo,
} from "../../packages/server/src/services/image-update.ts";

const IMAGE = "ghcr.io/im-sacha-cohen/dokploy";
const TAG = "smart-deploy";
const OLD_TAG = process.argv[2] ?? "smart-deploy-0099e31";
const PROBE = "dokploy-update-probe";
process.env.DOKPLOY_IMAGE = IMAGE;

const results = [];
const check = (name, ok, detail = "") => {
	results.push(ok);
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
};
const docker = (...args) => execFileSync("docker", args).toString().trim();
const probeDigest = () =>
	docker(
		"service",
		"inspect",
		PROBE,
		"--format",
		"{{.Spec.TaskTemplate.ContainerSpec.Image}}",
	).split("@")[1];

try {
	const latest = await getRegistryImageInfo(`${IMAGE}:${TAG}`);
	check(
		"GHCR answers anonymously with digest and commit",
		latest.digest.startsWith("sha256:") && !!latest.revision,
		`${latest.digest.slice(0, 19)}… commit ${latest.revision?.slice(0, 7)}`,
	);

	docker(
		"service",
		"create",
		"--detach",
		"--name",
		PROBE,
		"--replicas",
		"0",
		`${IMAGE}:${OLD_TAG}`,
	);
	const oldDigest = probeDigest();
	check("Swarm pins the old build by digest", !!oldDigest, oldDigest);

	const before = await getCustomImageUpdateData(TAG, oldDigest);
	check(
		"update offered on the old build, with both commits",
		before.updateAvailable &&
			before.latestVersion === TAG &&
			!!before.currentRevision &&
			before.latestRevision === latest.revision,
		`${before.currentRevision?.slice(0, 7)} → ${before.latestRevision?.slice(0, 7)}, ${before.sourceUrl}`,
	);

	// Same command as settings.updateServer, on the probe instead of `dokploy`.
	docker(
		"service",
		"update",
		"--detach",
		"--force",
		"--image",
		`${IMAGE}:${before.latestVersion}`,
		PROBE,
	);
	const newDigest = probeDigest();
	check(
		"the button's command moves the service to the digest the check saw",
		newDigest === latest.digest,
		newDigest,
	);

	const after = await getCustomImageUpdateData(TAG, newDigest);
	check("then: up to date", after.updateAvailable === false);
} catch (error) {
	check("scenario runs without exception", false, error.stack);
} finally {
	try {
		docker("service", "rm", PROBE);
	} catch {}
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
