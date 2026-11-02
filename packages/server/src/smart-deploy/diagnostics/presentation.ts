// Pure helpers turning a DiagnosticReport into what the UI shows. Imported by
// client components: keep this file free of runtime (Node, DB) imports.
import type {
	DiagnosticReport,
	DomainFact,
	Finding,
	FixAction,
	ListeningSocket,
	ProbeResult,
	Severity,
} from "./types";

const SEVERITY_RANK: Record<Severity, number> = {
	critical: 0,
	error: 1,
	warning: 2,
	info: 3,
};

/**
 * The finding to put in front of the user: a cause (not a consequence),
 * high/medium confidence, most severe first. Version freshness is not an
 * error and never takes the banner.
 */
export const pickRootCause = (findings: Finding[]): Finding | null =>
	findings
		.filter(
			(f) =>
				!f.causedBy?.length &&
				f.confidence !== "low" &&
				f.code !== "GIT_COMMIT_OUTDATED" &&
				(f.severity === "critical" || f.severity === "error"),
		)
		.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0] ??
	null;

export type HopState = "ok" | "broken" | "unknown" | "not_applicable";

export interface ChainHop {
	key: "entry" | "router" | "domainPort" | "container";
	label: string;
	value: string;
	detail: string;
	state: HopState;
}

export interface DomainChain {
	domain: DomainFact;
	hops: ChainHop[];
	/** Auto-fix proposed by the diagnosis for this domain, if any. */
	fix: Extract<FixAction, { kind: "update_domain_port" }> | null;
}

const isLoopback = (address: string) =>
	address.startsWith("127.") ||
	address === "::1" ||
	address.startsWith("::ffff:127.");

const BAD_GATEWAY = new Set([502, 503, 504]);

const routerHop = (router?: ProbeResult, backend?: ProbeResult): ChainHop => {
	if (!router) {
		return {
			key: "router",
			label: "Traefik",
			value: "not probed",
			detail: "",
			state: "unknown",
		};
	}
	if (router.httpStatus !== undefined && BAD_GATEWAY.has(router.httpStatus)) {
		return {
			key: "router",
			label: "Traefik",
			value: `HTTP ${router.httpStatus}`,
			detail: "cannot reach the app",
			state: "broken",
		};
	}
	if (router.httpStatus === 404 && backend?.ok) {
		return {
			key: "router",
			label: "Traefik",
			value: "HTTP 404",
			detail: "no route for this host",
			state: "broken",
		};
	}
	if (router.httpStatus !== undefined) {
		return {
			key: "router",
			label: "Traefik",
			value: `HTTP ${router.httpStatus}`,
			detail:
				router.httpStatus >= 300 && router.httpStatus < 400
					? "redirects (HTTPS)"
					: "route OK",
			state: "ok",
		};
	}
	return {
		key: "router",
		label: "Traefik",
		value: router.error ?? "error",
		detail: router.detail ?? "",
		state: "broken",
	};
};

const containerHop = (
	listening: ListeningSocket[] | null,
	exposed: number[] | null,
): ChainHop => {
	const exposeText = exposed?.length
		? `EXPOSE ${exposed.join(", ")}`
		: "no EXPOSE";
	if (listening === null) {
		return {
			key: "container",
			label: "Container listens",
			value: exposed?.length ? exposed.join(", ") : "?",
			detail: `not measured · ${exposeText}`,
			state: "unknown",
		};
	}
	if (listening.length === 0) {
		return {
			key: "container",
			label: "Container listens",
			value: "nothing",
			detail: exposeText,
			state: "broken",
		};
	}
	const external = listening.filter((s) => !isLoopback(s.address));
	const ports = [...new Set(listening.map((s) => s.port))].join(", ");
	if (external.length === 0) {
		return {
			key: "container",
			label: "Container listens",
			value: ports,
			detail: `only on ${listening[0]?.address} · unreachable`,
			state: "broken",
		};
	}
	return {
		key: "container",
		label: "Container listens",
		value: [...new Set(external.map((s) => s.port))].join(", "),
		detail: `${external[0]?.address} · ${exposeText}`,
		state: "ok",
	};
};

/** One chain per domain: entry → Traefik → domain port → container. */
export const buildNetworkChains = (report: DiagnosticReport): DomainChain[] => {
	const listening = report.facts.listening;
	const reachablePorts = listening
		? new Set(
				listening.filter((s) => !isLoopback(s.address)).map((s) => s.port),
			)
		: null;
	const container = containerHop(listening, report.facts.imageExposedPorts);

	return report.facts.domains.map((domain) => {
		const router = report.facts.probes.find(
			(p) => p.kind === "router" && p.domainId === domain.domainId,
		);
		const backend = report.facts.probes.find(
			(p) => p.kind === "backend" && p.domainId === domain.domainId,
		);

		let portState: HopState = "unknown";
		let portDetail = "listening ports unknown";
		if (domain.port === null) {
			portState = "unknown";
			portDetail = "no port set";
		} else if (reachablePorts && reachablePorts.size > 0) {
			portState = reachablePorts.has(domain.port) ? "ok" : "broken";
			portDetail =
				portState === "ok" ? "the app listens here" : "nothing listens here";
		} else if (reachablePorts) {
			portState = "unknown";
			portDetail = "the app is not reachable on any port";
		} else if (backend?.ok) {
			portState = "ok";
			portDetail = "answers through Traefik";
		}

		const fixFinding = report.findings.find(
			(f) =>
				f.autoFixable &&
				f.recommendedFix.action?.kind === "update_domain_port" &&
				f.recommendedFix.action.domainId === domain.domainId,
		);

		return {
			domain,
			hops: [
				{
					key: "entry",
					label: "Domain",
					value: domain.host,
					detail: domain.https ? "HTTPS" : "HTTP",
					state: "not_applicable",
				},
				routerHop(router, backend),
				{
					key: "domainPort",
					label: "Routed to port",
					value: domain.port === null ? "?" : String(domain.port),
					detail: portDetail,
					state: portState,
				},
				container,
			],
			fix:
				fixFinding?.recommendedFix.action?.kind === "update_domain_port"
					? fixFinding.recommendedFix.action
					: null,
		};
	});
};

/** Port to suggest for a domain: the only externally listening port, else the only EXPOSE. */
export const suggestedDomainPort = (
	report: DiagnosticReport,
): number | null => {
	const external = report.facts.listening
		? [
				...new Set(
					report.facts.listening
						.filter((s) => !isLoopback(s.address))
						.map((s) => s.port),
				),
			]
		: [];
	if (external.length === 1) return external[0] ?? null;
	const exposed = report.facts.imageExposedPorts ?? [];
	if (external.length === 0 && exposed.length === 1) return exposed[0] ?? null;
	const both = external.filter((p) => exposed.includes(p));
	return both.length === 1 ? (both[0] ?? null) : null;
};
