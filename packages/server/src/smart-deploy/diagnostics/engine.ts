import { portMismatchRule, reverseProxyRule } from "./rules/network";
import {
	buildFailedRule,
	crashLoopRule,
	healthcheckRule,
	localhostBindRule,
	missingEnvRule,
	notListeningRule,
	runningTasks,
} from "./rules/runtime";
import {
	gitCommitOutdatedRule,
	imageVersionMismatchRule,
} from "./rules/version";
import type {
	Confidence,
	DiagnosticCode,
	DiagnosticContext,
	DiagnosticReport,
	DiagnosticVerdict,
	Finding,
	Rule,
	Severity,
} from "./types";

export const DEFAULT_RULES: Rule[] = [
	buildFailedRule,
	crashLoopRule,
	missingEnvRule,
	healthcheckRule,
	notListeningRule,
	localhostBindRule,
	portMismatchRule,
	reverseProxyRule,
	imageVersionMismatchRule,
	gitCommitOutdatedRule,
];

/** Which findings explain which: [consequence, possible causes]. */
const CAUSALITY: [DiagnosticCode, DiagnosticCode[]][] = [
	[
		"CONTAINER_CRASH_LOOP",
		["MISSING_ENVIRONMENT_VARIABLE", "HEALTHCHECK_FAILED"],
	],
	[
		"REVERSE_PROXY_UNREACHABLE",
		[
			"BUILD_FAILED",
			"CONTAINER_CRASH_LOOP",
			"MISSING_ENVIRONMENT_VARIABLE",
			"APPLICATION_NOT_LISTENING",
			"APPLICATION_LISTENING_ON_LOCALHOST",
			"PORT_MISMATCH",
		],
	],
];

const TRAFFIC_BLOCKING = new Set<DiagnosticCode>([
	"REVERSE_PROXY_UNREACHABLE",
	"APPLICATION_NOT_LISTENING",
	"APPLICATION_LISTENING_ON_LOCALHOST",
	"PORT_MISMATCH",
]);

const SEVERITY_ORDER: Record<Severity, number> = {
	critical: 0,
	error: 1,
	warning: 2,
	info: 3,
};
const CONFIDENCE_ORDER: Record<Confidence, number> = {
	high: 0,
	medium: 1,
	low: 2,
};

const linkCauses = (findings: Finding[]) => {
	const present = new Set(
		findings.filter((f) => f.confidence !== "low").map((f) => f.code),
	);
	for (const finding of findings) {
		const rule = CAUSALITY.find(([code]) => code === finding.code);
		if (!rule) continue;
		const causes = rule[1].filter((code) => present.has(code));
		if (causes.length === 0) continue;
		finding.causedBy = causes;
		finding.probableCause = `Conséquence de : ${causes.join(", ")}.`;
		finding.recommendedFix = {
			summary: `Traiter d'abord ${causes.join(", ")}.`,
		};
		if (finding.severity === "critical") finding.severity = "error";
	}
};

const computeVerdict = (
	ctx: DiagnosticContext,
	findings: Finding[],
): DiagnosticVerdict => {
	// Version freshness is reported, but says nothing about the app's health.
	const significant = findings.filter(
		(f) => f.confidence !== "low" && f.code !== "GIT_COMMIT_OUTDATED",
	);
	if (
		significant.some((f) => f.severity === "critical" || f.severity === "error")
	) {
		const trafficBlocked = significant.some(
			(f) => TRAFFIC_BLOCKING.has(f.code) && f.severity !== "warning",
		);
		return trafficBlocked || runningTasks(ctx).length === 0
			? "down"
			: "degraded";
	}
	if (significant.some((f) => f.severity === "warning")) return "degraded";
	if (ctx.tasks === undefined || ctx.service === undefined) return "unknown";
	if (!ctx.service.exists || runningTasks(ctx).length === 0) return "unknown";
	return "healthy";
};

export const runDiagnostics = (
	ctx: DiagnosticContext,
	rules: Rule[] = DEFAULT_RULES,
): DiagnosticReport => {
	const findings: Finding[] = [];
	for (const rule of rules) {
		try {
			const result = rule(ctx);
			if (!result) continue;
			findings.push(...(Array.isArray(result) ? result : [result]));
		} catch (error) {
			ctx.collectionErrors.push({
				source: "dokploy_config",
				message: `Rule failed: ${error instanceof Error ? error.message : String(error)}`,
			});
		}
	}

	linkCauses(findings);
	findings.sort(
		(a, b) =>
			SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
			CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence],
	);

	return {
		generatedAt: ctx.now.toISOString(),
		target: ctx.target,
		verdict: computeVerdict(ctx, findings),
		findings,
		facts: {
			latestDeploymentStatus: ctx.latestDeployment?.status ?? null,
			runningTasks: ctx.tasks ? runningTasks(ctx).length : null,
			desiredReplicas: ctx.service?.desiredReplicas ?? null,
			listening: ctx.listening ?? null,
			imageExposedPorts: ctx.imageExposedPorts ?? null,
			domains: ctx.config.domains,
			probes: ctx.probes ?? [],
		},
		collectionErrors: ctx.collectionErrors,
	};
};
