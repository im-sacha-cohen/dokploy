import type { Finding, Rule } from "../types";

const short = (sha: string | null | undefined) =>
	sha ? sha.slice(0, 7) : "inconnu";

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
			summary: `Dernier déploiement ${latest.deploymentId} (« done ») : image ${latest.imageId.slice(7, 19)}, commit ${short(latest.builtCommitSha)}`,
		},
		{
			source: "docker_container",
			summary: `Image du conteneur en cours d'exécution : ${runningImage.slice(7, 19)}${running ? ` (déploiement ${running.deploymentId}, commit ${short(running.builtCommitSha)})` : " (ne correspond à aucun déploiement suivi)"}`,
		},
	];

	return {
		code: "IMAGE_VERSION_MISMATCH",
		title: "Le conteneur n'exécute pas l'image du dernier déploiement",
		description:
			"Le dernier déploiement est marqué terminé, mais le conteneur actif tourne avec une autre image.",
		severity: "error",
		confidence: "high",
		evidence,
		probableCause:
			"La mise à jour du service n'a pas été appliquée (tâches de la nouvelle version en échec, retour arrière automatique de Swarm) ou l'image a été modifiée après le déploiement.",
		recommendedFix: latest.imageTag
			? {
					summary: `Redéployer l'image du déploiement ${latest.deploymentId} et vérifier les logs si elle ne démarre pas.`,
					action: {
						kind: "redeploy_deployment",
						deploymentId: latest.deploymentId,
					},
				}
			: { summary: "Relancer un déploiement et vérifier les logs du service." },
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
		title: `La version déployée n'est pas le dernier commit de ${head.branch}`,
		description: `Le conteneur exécute ${short(running.builtCommitSha)} ; la branche ${head.branch} pointe sur ${short(head.sha)} (vérifié le ${head.checkedAt}).`,
		severity: "warning",
		confidence: "high",
		evidence: [
			{
				source: "deployment",
				summary: `Commit construit par le déploiement ${running.deploymentId} (image en cours d'exécution) : ${running.builtCommitSha}`,
			},
			{
				source: "repository",
				summary: `Tête distante de ${head.branch} : ${head.sha}`,
			},
		],
		probableCause:
			"Des commits ont été poussés depuis le dernier déploiement, ou un déploiement plus ancien a été restauré.",
		recommendedFix: {
			summary: `Déployer le dernier commit (${short(head.sha)}) avec « Deploy Latest ».`,
			action: { kind: "deploy_latest" },
		},
		risk: "medium",
		autoFixable: true,
	};
};
