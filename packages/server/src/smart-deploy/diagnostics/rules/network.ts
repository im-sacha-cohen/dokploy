import { externallyReachablePorts } from "../proc-net";
import type { DomainFact, Finding, ProbeResult, Rule } from "../types";
import { LISTEN_GRACE_SECONDS } from "./runtime";

const describeProbe = (probe: ProbeResult) =>
	`${probe.kind === "router" ? "Traefik → domain" : "Traefik → service"} ${probe.target}: ${
		probe.httpStatus !== undefined
			? `HTTP ${probe.httpStatus}`
			: (probe.error ?? "failed")
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
				title: `Domain ${domain.host} targets port ${domain.port}, but the application listens on ${reachable.join(", ")}`,
				description: `Traefik sends requests for ${domainLabel(domain)} to port ${domain.port} of the service, where nothing is listening.`,
				severity: "critical",
				confidence: "high",
				evidence: [
					{
						source: "dokploy_config",
						summary: `Port of domain ${domain.host}: ${domain.port}`,
					},
					{
						source: "listening_sockets",
						summary: `Listening ports (excluding localhost): ${reachable.join(", ")}`,
						excerpt: (ctx.listening ?? []).map((s) => `${s.address}:${s.port}`),
					},
					...(exposed.length
						? [
								{
									source: "docker_image" as const,
									summary: `EXPOSE in the image: ${exposed.join(", ")}`,
								},
							]
						: []),
				],
				probableCause:
					"The port configured on the domain does not match the port the application actually listens on.",
				recommendedFix: candidate
					? {
							summary: `Change the port of domain ${domain.host} from ${domain.port} to ${candidate}.`,
							action: {
								kind: "update_domain_port",
								domainId: domain.domainId,
								host: domain.host,
								port: candidate,
							},
						}
					: {
							summary: `Pick the listening port (${reachable.join(", ")}) that serves HTTP and set it on the domain.`,
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
				title: `Domain ${domain.host} targets port ${domain.port}, the image exposes ${exposed.join(", ")}`,
				description:
					"The domain port is not among the image's EXPOSE ports. The ports actually listening could not be checked.",
				severity: "warning",
				confidence: "medium",
				evidence: [
					{
						source: "dokploy_config",
						summary: `Port of domain ${domain.host}: ${domain.port}`,
					},
					{
						source: "docker_image",
						summary: `EXPOSE in the image: ${exposed.join(", ")}`,
					},
				],
				probableCause:
					"EXPOSE is only a hint: the application may listen elsewhere. To be confirmed once the container is running.",
				recommendedFix: candidate
					? {
							summary: `Check the listening port; if it is indeed ${candidate}, set it on the domain.`,
							action: {
								kind: "update_domain_port",
								domainId: domain.domainId,
								host: domain.host,
								port: candidate,
							},
						}
					: { summary: "Check the port the application listens on." },
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
				title: `Published port ${published.publishedPort} targets port ${published.targetPort}, where nothing is listening`,
				description:
					"A port published on the host points to a container port that is not listening.",
				severity: "warning",
				confidence: "high",
				evidence: [
					{
						source: "dokploy_config",
						summary: `Published port ${published.publishedPort} → ${published.targetPort}/${published.protocol}`,
					},
					{
						source: "listening_sockets",
						summary: `Listening ports (excluding localhost): ${reachable.join(", ")}`,
					},
				],
				probableCause:
					"The publication's Target Port does not match the listening port.",
				recommendedFix: {
					summary:
						"Fix the Target Port in Advanced → Ports. Only publish a port on the host if access outside Traefik is needed.",
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
				? `Traefik does not route ${domain.host}`
				: `Traefik cannot reach the application for ${domain.host}`,
			description: routerMissing
				? "The service responds directly, but Traefik returns 404 for this domain: no router matches."
				: `Requests to ${domainLabel(domain)} fail between Traefik and the service ${ctx.target.appName}.`,
			severity: "critical",
			confidence: "high",
			evidence,
			probableCause: routerMissing
				? "The domain's Traefik dynamic configuration is missing or invalid (file not generated, wrong Host rule)."
				: "The service does not respond on the configured port (other findings, if any, give the cause).",
			recommendedFix: routerMissing
				? {
						summary:
							"Open the domain in Dokploy and save it again to regenerate the Traefik configuration, then check the Traefik logs.",
					}
				: {
						summary:
							"Fix the underlying cause (port, startup, listening); Traefik restores the route automatically.",
					},
			risk: "none",
			autoFixable: false,
		});
	}
	return findings;
};
