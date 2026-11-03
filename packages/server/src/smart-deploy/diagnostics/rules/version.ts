import type { Finding, Rule } from "../types";

const short = (sha: string | null | undefined) =>
	sha ? sha.slice(0, 7) : "unknown";

export const imageVersionMismatchRule: Rule = (ctx) => {
	const latest = ctx.version?.latest;
	const runningImage = ctx.container?.imageId;
	// Only conclude when the latest deployment finished and recorded its image.
	if (!latest || latest.status !== "done" || !latest.imageId || !runningImage) {
		return null;
	}
	if (runningImage === latest.imageId) return null;

	const running = ctx.version?.running;
	const evidence: Finding["evidence"] = [
		{
			source: "deployment",
			summary: `Last deployment ${latest.deploymentId} ("done"): image ${latest.imageId.slice(7, 19)}, commit ${short(latest.builtCommitSha)}`,
		},
		{
			source: "docker_container",
			summary: `Running container image: ${runningImage.slice(7, 19)}${running ? ` (deployment ${running.deploymentId}, commit ${short(running.builtCommitSha)})` : " (matches no tracked deployment)"}`,
		},
	];

	return {
		code: "IMAGE_VERSION_MISMATCH",
		title: "Container is not running the latest deployment's image",
		description:
			"The last deployment is marked done, but the active container runs a different image.",
		severity: "error",
		confidence: "high",
		evidence,
		probableCause:
			"The service update was not applied (tasks of the new version failed, Swarm rolled back automatically) or the image was changed after the deployment.",
		recommendedFix: latest.imageTag
			? {
					summary: `Redeploy the image of deployment ${latest.deploymentId} and check the logs if it does not start.`,
					action: {
						kind: "redeploy_deployment",
						deploymentId: latest.deploymentId,
					},
				}
			: { summary: "Deploy again and check the service logs." },
		risk: "low",
		autoFixable: !!latest.imageTag,
	};
};

export const gitCommitOutdatedRule: Rule = (ctx) => {
	const head = ctx.version?.remoteHead;
	const running = ctx.version?.running;
	if (head?.status !== "ok" || !running?.builtCommitSha) return null;
	if (running.builtCommitSha === head.sha) return null;

	return {
		code: "GIT_COMMIT_OUTDATED",
		title: `Deployed version is not the latest commit on ${head.branch}`,
		description: `The container runs ${short(running.builtCommitSha)}; branch ${head.branch} points to ${short(head.sha)} (checked at ${head.checkedAt}).`,
		severity: "warning",
		confidence: "high",
		evidence: [
			{
				source: "deployment",
				summary: `Commit built by deployment ${running.deploymentId} (running image): ${running.builtCommitSha}`,
			},
			{
				source: "repository",
				summary: `Remote head of ${head.branch}: ${head.sha}`,
			},
		],
		probableCause:
			"Commits were pushed since the last deployment, or an older deployment was restored.",
		recommendedFix: {
			summary: `Deploy the latest commit (${short(head.sha)}) with "Deploy Latest".`,
			action: { kind: "deploy_latest" },
		},
		risk: "medium",
		autoFixable: true,
	};
};
