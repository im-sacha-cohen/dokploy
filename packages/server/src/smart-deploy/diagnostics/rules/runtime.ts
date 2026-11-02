import {
	describeExitCode,
	extractMissingEnvNames,
	selectBuildErrorLines,
} from "../log-patterns";
import { externallyReachablePorts, isLoopback } from "../proc-net";
import type { DiagnosticContext, Finding, Rule, TaskFact } from "../types";

const CRASH_WINDOW_MS = 10 * 60 * 1000;
/** Before this, an app that is not yet listening may simply still be booting. */
export const LISTEN_GRACE_SECONDS = 20;

const FAILED_STATES = new Set(["failed", "rejected"]);

export const recentFailedTasks = (ctx: DiagnosticContext): TaskFact[] =>
	(ctx.tasks ?? []).filter(
		(task) =>
			FAILED_STATES.has(task.state) &&
			ctx.now.getTime() - new Date(task.timestamp).getTime() <= CRASH_WINDOW_MS,
	);

export const runningTasks = (ctx: DiagnosticContext): TaskFact[] =>
	(ctx.tasks ?? []).filter((task) => task.state === "running");

const isListeningSettled = (ctx: DiagnosticContext) =>
	!!ctx.container &&
	ctx.container.uptimeSeconds >= LISTEN_GRACE_SECONDS &&
	ctx.listening !== undefined;

export const buildFailedRule: Rule = (ctx) => {
	const deployment = ctx.latestDeployment;
	if (deployment?.status !== "error") return null;

	const logLines = selectBuildErrorLines(deployment.logTail ?? []);
	return {
		code: "BUILD_FAILED",
		title: "Le dernier déploiement a échoué",
		description:
			"Le dernier déploiement s'est terminé en erreur. Le conteneur en cours d'exécution, s'il existe, provient d'un déploiement précédent.",
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: "deployment",
				summary: `Déploiement ${deployment.deploymentId} du ${deployment.createdAt} : statut « error »${deployment.errorMessage ? ` (${deployment.errorMessage.slice(0, 200)})` : ""}`,
			},
			...(logLines.length
				? [
						{
							source: "build_logs" as const,
							summary: "Dernières lignes pertinentes du log de build",
							excerpt: logLines,
						},
					]
				: []),
		],
		probableCause:
			"Erreur pendant le clonage, l'installation des dépendances, la compilation ou la construction de l'image (voir les lignes de log).",
		recommendedFix: {
			summary:
				"Corriger l'erreur indiquée dans le log de build, puis relancer un déploiement.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const crashLoopRule: Rule = (ctx) => {
	if (!ctx.tasks) return null;
	const failed = recentFailedTasks(ctx);
	const running = runningTasks(ctx);
	if (failed.length < 2) return null;
	if (running.length > 0 && failed.length < 3) return null;

	const exitCodes = [
		...new Set(failed.map((t) => t.exitCode).filter((c) => c !== undefined)),
	] as number[];
	const healthKills = failed.filter((t) => /unhealthy/i.test(t.error ?? ""));
	const flapping = running.length > 0;

	const evidence: Finding["evidence"] = [
		{
			source: "docker_task",
			summary: `${failed.length} tâches en échec sur les 10 dernières minutes, ${running.length} en cours d'exécution`,
			excerpt: failed
				.slice(0, 5)
				.map(
					(t) => `${t.timestamp} ${t.state}${t.error ? ` : ${t.error}` : ""}`,
				),
		},
	];
	if (ctx.logs?.length) {
		evidence.push({
			source: "application_logs",
			summary: "Dernières lignes de log de l'application",
			excerpt: ctx.logs.slice(-10),
		});
	}

	const causes = exitCodes.map((code) => `${code} : ${describeExitCode(code)}`);
	const probableCause =
		healthKills.length > 0
			? "Swarm remplace les conteneurs déclarés « unhealthy » par le healthcheck."
			: causes.length > 0
				? `L'application s'arrête au démarrage (code de sortie ${causes.join(" ; ")}).`
				: "L'application s'arrête au démarrage.";

	return {
		code: "CONTAINER_CRASH_LOOP",
		title: flapping
			? "Le conteneur redémarre régulièrement"
			: "Le conteneur redémarre en boucle",
		description: flapping
			? "Une tâche tourne actuellement, mais plusieurs tâches ont échoué récemment."
			: "Aucune tâche ne reste en cours d'exécution : Swarm relance le conteneur toutes les quelques secondes.",
		severity: flapping ? "warning" : "critical",
		confidence: flapping ? "medium" : "high",
		evidence,
		probableCause,
		recommendedFix: {
			summary:
				"Lire les logs de l'application pour identifier l'erreur de démarrage, la corriger puis redéployer.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const missingEnvRule: Rule = (ctx) => {
	const configured = new Set(ctx.config.envKeys);
	const fromLogs = ctx.logs ? extractMissingEnvNames(ctx.logs) : null;
	const logMissing = (fromLogs?.names ?? []).filter((n) => !configured.has(n));
	const exampleMissing = (ctx.envExampleKeys ?? []).filter(
		(key) => !configured.has(key) && !logMissing.includes(key),
	);

	if (logMissing.length === 0 && exampleMissing.length === 0) return null;

	const isFailing = recentFailedTasks(ctx).length > 0;
	const keys = [...logMissing, ...exampleMissing];
	const evidence: Finding["evidence"] = [];

	if (logMissing.length > 0 && fromLogs) {
		evidence.push({
			source: "application_logs",
			summary: `L'application signale des variables manquantes : ${logMissing.join(", ")}`,
			excerpt: fromLogs.matchedLines,
		});
	}
	if (exampleMissing.length > 0) {
		evidence.push({
			source: "repository",
			summary: `Déclarées dans .env.example mais absentes de la configuration : ${exampleMissing.join(", ")}`,
		});
	}
	evidence.push({
		source: "dokploy_config",
		summary: `${ctx.config.envKeys.length} variable(s) configurée(s) dans Dokploy (noms uniquement, valeurs jamais incluses dans le rapport)`,
	});

	const confidence =
		logMissing.length > 0 ? "high" : isFailing ? "medium" : "low";

	return {
		code: "MISSING_ENVIRONMENT_VARIABLE",
		title:
			keys.length > 1
				? "Variables d'environnement manquantes"
				: "Variable d'environnement manquante",
		description: `Variables attendues par l'application mais absentes de la configuration Dokploy : ${keys.join(", ")}.`,
		severity: logMissing.length > 0 ? "critical" : isFailing ? "error" : "info",
		confidence,
		evidence,
		probableCause:
			logMissing.length > 0
				? "L'application refuse de démarrer sans ces variables."
				: "Le dépôt documente ces variables ; elles ne sont pas définies dans Dokploy.",
		recommendedFix: {
			summary: `Définir ${keys.join(", ")} dans l'onglet Environment de l'application, puis redéployer.`,
			action: { kind: "set_environment_variables", keys },
		},
		risk: "low",
		// Values are secrets only the user can provide.
		autoFixable: false,
	};
};

export const healthcheckRule: Rule = (ctx) => {
	const health = ctx.container?.health;
	const killedByHealth = recentFailedTasks(ctx).filter((t) =>
		/unhealthy/i.test(t.error ?? ""),
	);
	if (health?.status !== "unhealthy" && killedByHealth.length === 0)
		return null;

	const evidence: Finding["evidence"] = [];
	if (health?.status === "unhealthy") {
		evidence.push({
			source: "docker_container",
			summary: `Healthcheck en échec ${health.failingStreak} fois de suite${health.lastExitCode !== undefined ? ` (dernier code ${health.lastExitCode})` : ""}`,
			excerpt: health.lastOutput,
		});
	}
	if (killedByHealth.length > 0) {
		evidence.push({
			source: "docker_task",
			summary: `${killedByHealth.length} tâche(s) arrêtée(s) par Swarm pour cause de healthcheck`,
		});
	}

	return {
		code: "HEALTHCHECK_FAILED",
		title: "Le healthcheck échoue",
		description: "Le conteneur tourne mais sa commande de healthcheck échoue.",
		severity: "error",
		confidence: "high",
		evidence,
		probableCause:
			"Le chemin ou le port testé par le healthcheck ne répond pas, ou l'outil utilisé (curl, wget) est absent de l'image.",
		recommendedFix: {
			summary:
				"Vérifier la commande HEALTHCHECK (Dockerfile ou Swarm Settings) : port, chemin, présence de l'outil dans l'image.",
		},
		risk: "low",
		autoFixable: false,
	};
};

export const notListeningRule: Rule = (ctx) => {
	if (!isListeningSettled(ctx) || !ctx.listening) return null;
	if (ctx.listening.length > 0) return null;

	return {
		code: "APPLICATION_NOT_LISTENING",
		title: "L'application n'écoute sur aucun port",
		description: `Le conteneur tourne depuis ${ctx.container?.uptimeSeconds}s mais aucun socket TCP n'est en écoute.`,
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: "listening_sockets",
				summary:
					"Aucun socket TCP en état LISTEN dans le namespace réseau du conteneur",
			},
		],
		probableCause:
			"La commande de démarrage ne lance pas de serveur (worker, script terminé, mauvais point d'entrée) ou le serveur attend une ressource avant d'écouter.",
		recommendedFix: {
			summary:
				"Vérifier la commande de démarrage et les logs ; s'il s'agit d'un worker sans HTTP, retirer le domaine associé.",
		},
		risk: "none",
		autoFixable: false,
	};
};

export const localhostBindRule: Rule = (ctx) => {
	if (!isListeningSettled(ctx) || !ctx.listening?.length) return null;
	if (externallyReachablePorts(ctx.listening).length > 0) return null;

	const loopback = ctx.listening.filter((s) => isLoopback(s.address));
	return {
		code: "APPLICATION_LISTENING_ON_LOCALHOST",
		title: "L'application n'écoute que sur localhost",
		description: `L'application écoute sur ${loopback.map((s) => `${s.address}:${s.port}`).join(", ")} : ces adresses ne sont joignables que depuis le conteneur lui-même, pas par Traefik.`,
		severity: "critical",
		confidence: "high",
		evidence: [
			{
				source: "listening_sockets",
				summary: "Sockets en écoute dans le conteneur",
				excerpt: ctx.listening.map(
					(s) => `${s.address}:${s.port} (${s.family})`,
				),
			},
		],
		probableCause:
			"Le serveur est lié à 127.0.0.1 (valeur par défaut de nombreux serveurs de développement).",
		recommendedFix: {
			summary:
				'Faire écouter l\'application sur 0.0.0.0 (par exemple HOST=0.0.0.0, --host 0.0.0.0 ou listen(port, "0.0.0.0")), puis redéployer.',
		},
		risk: "low",
		autoFixable: false,
	};
};
