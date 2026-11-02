import { externallyReachablePorts } from "../proc-net";
import type { DomainFact, Finding, ProbeResult, Rule } from "../types";
import { LISTEN_GRACE_SECONDS } from "./runtime";

const describeProbe = (probe: ProbeResult) =>
	`${probe.kind === "router" ? "Traefik → domaine" : "Traefik → service"} ${probe.target} : ${
		probe.httpStatus !== undefined
			? `HTTP ${probe.httpStatus}`
			: (probe.error ?? "échec")
	}${probe.detail ? ` (${probe.detail})` : ""}`;

const pickCandidatePort = (reachable: number[], exposed: number[]) => {
	if (reachable.length === 1) return reachable[0];
	const exposedAndListening = reachable.filter((p) => exposed.includes(p));
	return exposedAndListening.length === 1 ? exposedAndListening[0] : undefined;
};

const domainLabel = (domain: DomainFact) =>
	`${domain.https ? "https" : "http"}://${domain.host}${domain.path && domain.path !== "/" ? domain.path : ""}`;

export const portMismatchRule: Rule = (ctx) => {
	const findings: Finding[] = [];
	const exposed = ctx.imageExposedPorts ?? [];
	const listeningKnown =
		ctx.listening !== undefined &&
		!!ctx.container &&
		ctx.container.uptimeSeconds >= LISTEN_GRACE_SECONDS;
	const reachable = listeningKnown
		? externallyReachablePorts(ctx.listening ?? [])
		: [];

	for (const domain of ctx.config.domains) {
		if (domain.port === null) continue;

		if (listeningKnown && reachable.length > 0) {
			if (reachable.includes(domain.port)) continue;
			const candidate = pickCandidatePort(reachable, exposed);
			findings.push({
				code: "PORT_MISMATCH",
				title: `Le domaine ${domain.host} cible le port ${domain.port}, mais l'application écoute sur ${reachable.join(", ")}`,
				description: `Traefik envoie les requêtes de ${domainLabel(domain)} vers le port ${domain.port} du service, où rien n'écoute.`,
				severity: "critical",
				confidence: "high",
				evidence: [
					{
						source: "dokploy_config",
						summary: `Port du domaine ${domain.host} : ${domain.port}`,
					},
					{
						source: "listening_sockets",
						summary: `Ports en écoute (hors localhost) : ${reachable.join(", ")}`,
						excerpt: (ctx.listening ?? []).map((s) => `${s.address}:${s.port}`),
					},
					...(exposed.length
						? [
								{
									source: "docker_image" as const,
									summary: `EXPOSE dans l'image : ${exposed.join(", ")}`,
								},
							]
						: []),
				],
				probableCause:
					"Le port configuré sur le domaine ne correspond pas au port d'écoute réel de l'application.",
				recommendedFix: candidate
					? {
							summary: `Changer le port du domaine ${domain.host} de ${domain.port} à ${candidate}.`,
							action: {
								kind: "update_domain_port",
								domainId: domain.domainId,
								host: domain.host,
								port: candidate,
							},
						}
					: {
							summary: `Choisir parmi les ports en écoute (${reachable.join(", ")}) celui qui sert HTTP et l'indiquer sur le domaine.`,
						},
				risk: "low",
				autoFixable: candidate !== undefined,
			});
			continue;
		}

		if (
			!listeningKnown &&
			exposed.length > 0 &&
			!exposed.includes(domain.port)
		) {
			const candidate = exposed.length === 1 ? exposed[0] : undefined;
			findings.push({
				code: "PORT_MISMATCH",
				title: `Le domaine ${domain.host} cible le port ${domain.port}, l'image expose ${exposed.join(", ")}`,
				description:
					"Le port du domaine ne figure pas parmi les ports EXPOSE de l'image. Les ports réellement en écoute n'ont pas pu être vérifiés.",
				severity: "warning",
				confidence: "medium",
				evidence: [
					{
						source: "dokploy_config",
						summary: `Port du domaine ${domain.host} : ${domain.port}`,
					},
					{
						source: "docker_image",
						summary: `EXPOSE dans l'image : ${exposed.join(", ")}`,
					},
				],
				probableCause:
					"EXPOSE est indicatif : l'application peut écouter ailleurs. À confirmer une fois le conteneur démarré.",
				recommendedFix: candidate
					? {
							summary: `Vérifier le port d'écoute ; s'il s'agit bien de ${candidate}, l'indiquer sur le domaine.`,
							action: {
								kind: "update_domain_port",
								domainId: domain.domainId,
								host: domain.host,
								port: candidate,
							},
						}
					: { summary: "Vérifier le port d'écoute de l'application." },
				risk: "low",
				autoFixable: false,
			});
		}
	}

	if (listeningKnown && reachable.length > 0) {
		for (const published of ctx.config.publishedPorts) {
			if (
				published.protocol !== "tcp" ||
				reachable.includes(published.targetPort)
			) {
				continue;
			}
			findings.push({
				code: "PORT_MISMATCH",
				title: `Le port publié ${published.publishedPort} cible le port ${published.targetPort}, où rien n'écoute`,
				description:
					"Un port publié sur l'hôte pointe vers un port du conteneur qui n'est pas en écoute.",
				severity: "warning",
				confidence: "high",
				evidence: [
					{
						source: "dokploy_config",
						summary: `Port publié ${published.publishedPort} → ${published.targetPort}/${published.protocol}`,
					},
					{
						source: "listening_sockets",
						summary: `Ports en écoute (hors localhost) : ${reachable.join(", ")}`,
					},
				],
				probableCause:
					"Le port cible (Target Port) de la publication ne correspond pas au port d'écoute.",
				recommendedFix: {
					summary:
						"Corriger le Target Port dans Advanced → Ports. Ne publier un port sur l'hôte que si un accès hors Traefik est nécessaire.",
				},
				risk: "medium",
				autoFixable: false,
			});
		}
	}

	return findings;
};

const BAD_GATEWAY = new Set([502, 503, 504]);

export const reverseProxyRule: Rule = (ctx) => {
	if (!ctx.probes?.length) return null;
	const findings: Finding[] = [];

	for (const domain of ctx.config.domains) {
		const router = ctx.probes.find(
			(p) => p.kind === "router" && p.domainId === domain.domainId,
		);
		const backend = ctx.probes.find(
			(p) => p.kind === "backend" && p.domainId === domain.domainId,
		);

		const routerBadGateway =
			router?.httpStatus !== undefined && BAD_GATEWAY.has(router.httpStatus);
		const backendDown =
			backend !== undefined && !backend.ok && backend.httpStatus === undefined;
		const routerMissing = router?.httpStatus === 404 && backend?.ok === true;

		if (!routerBadGateway && !backendDown && !routerMissing) continue;

		const evidence = [router, backend]
			.filter((p): p is ProbeResult => p !== undefined)
			.map((p) => ({
				source: "proxy_probe" as const,
				summary: describeProbe(p),
			}));

		findings.push({
			code: "REVERSE_PROXY_UNREACHABLE",
			title: routerMissing
				? `Traefik ne route pas ${domain.host}`
				: `Traefik ne parvient pas à joindre l'application pour ${domain.host}`,
			description: routerMissing
				? "Le service répond directement, mais Traefik renvoie 404 pour ce domaine : aucun routeur ne correspond."
				: `Les requêtes vers ${domainLabel(domain)} échouent entre Traefik et le service ${ctx.target.appName}.`,
			severity: "critical",
			confidence: "high",
			evidence,
			probableCause: routerMissing
				? "La configuration dynamique Traefik du domaine est absente ou invalide (fichier non généré, règle Host incorrecte)."
				: "Le service ne répond pas sur le port configuré (cause précisée par les autres constats s'il y en a).",
			recommendedFix: routerMissing
				? {
						summary:
							"Ouvrir le domaine dans Dokploy et l'enregistrer à nouveau pour régénérer la configuration Traefik, puis vérifier les logs de Traefik.",
					}
				: {
						summary:
							"Corriger la cause sous-jacente (port, démarrage, écoute) ; Traefik rétablit la route automatiquement.",
					},
			risk: "none",
			autoFixable: false,
		});
	}
	return findings;
};
