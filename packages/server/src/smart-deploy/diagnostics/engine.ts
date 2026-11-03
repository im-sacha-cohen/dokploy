import { portMismatchRule, reverseProxyRule } from "./rules/network";
import {
	composeVariablesRule,
	configNotAppliedRule,
	dataIncompatibleRule,
	diskFullRule,
	externalPortRule,
	imagePullFailedRule,
	outOfMemoryRule,
	serviceStoppedRule,
} from "./rules/resources";
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
	ComposeServiceFacts,
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
	imagePullFailedRule,
	outOfMemoryRule,
	diskFullRule,
];

export const DATABASE_RULES: Rule[] = [
	serviceStoppedRule,
	imagePullFailedRule,
	externalPortRule,
	dataIncompatibleRule,
	outOfMemoryRule,
	diskFullRule,
	crashLoopRule,
	missingEnvRule,
	healthcheckRule,
	notListeningRule,
	localhostBindRule,
	configNotAppliedRule,
];

// Workers and jobs of a stack listen on nothing: network rules only run for
// services that a domain routes to.
const withDomainsOnly =
	(rule: Rule): Rule =>
	(ctx) =>
		ctx.config.domains.length > 0 ? rule(ctx) : null;

export const COMPOSE_SERVICE_RULES: Rule[] = [
	serviceStoppedRule,
	imagePullFailedRule,
	outOfMemoryRule,
	diskFullRule,
	crashLoopRule,
	missingEnvRule,
	healthcheckRule,
	withDomainsOnly(notListeningRule),
	withDomainsOnly(localhostBindRule),
	withDomainsOnly(portMismatchRule),
	withDomainsOnly(reverseProxyRule),
];

export const COMPOSE_STACK_RULES: Rule[] = [
	buildFailedRule,
	composeVariablesRule,
];

/** Which findings explain which: [consequence, possible causes]. */
const CAUSALITY: [DiagnosticCode, DiagnosticCode[]][] = [
	[
		"CONTAINER_CRASH_LOOP",
		[
			"MISSING_ENVIRONMENT_VARIABLE",
			"HEALTHCHECK_FAILED",
			"OUT_OF_MEMORY",
			"DISK_FULL",
			"DATA_DIRECTORY_INCOMPATIBLE",
		],
	],
	[
		"APPLICATION_NOT_LISTENING",
		["DATA_DIRECTORY_INCOMPATIBLE", "MISSING_ENVIRONMENT_VARIABLE"],
	],
	// Redeploying would fail the same way: the cause must be handled first.
	["CONFIG_NOT_APPLIED", ["DATA_DIRECTORY_INCOMPATIBLE", "IMAGE_PULL_FAILED"]],
	["SERVICE_STOPPED", ["IMAGE_PULL_FAILED", "EXTERNAL_PORT_UNAVAILABLE"]],
	[
		"REVERSE_PROXY_UNREACHABLE",
		[
			"BUILD_FAILED",
			"CONTAINER_CRASH_LOOP",
			"MISSING_ENVIRONMENT_VARIABLE",
			"APPLICATION_NOT_LISTENING",
			"APPLICATION_LISTENING_ON_LOCALHOST",
			"PORT_MISMATCH",
			"IMAGE_PULL_FAILED",
			"OUT_OF_MEMORY",
			"SERVICE_STOPPED",
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
		finding.probableCause = `Consequence of: ${causes.join(", ")}.`;
		finding.recommendedFix = {
			summary: `Address ${causes.join(", ")} first.`,
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
		significant.length > 0 &&
		significant.every((f) => f.code === "SERVICE_STOPPED")
	) {
		return "stopped";
	}
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

const sortFindings = (findings: Finding[]) =>
	findings.sort(
		(a, b) =>
			SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
			CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence],
	);

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
	sortFindings(findings);

	return {
		generatedAt: ctx.now.toISOString(),
		target: ctx.target,
		verdict: computeVerdict(ctx, findings),
		findings,
		facts: {
			latestDeploymentStatus: ctx.latestDeployment?.status ?? null,
			runningTasks: ctx.tasks ? runningTasks(ctx).length : null,
			desiredReplicas: ctx.service?.desiredReplicas ?? null,
			serviceExists: ctx.service?.exists ?? null,
			listening: ctx.listening ?? null,
			imageExposedPorts: ctx.imageExposedPorts ?? null,
			domains: ctx.config.domains,
			publishedPorts: ctx.config.publishedPorts,
			probes: ctx.probes ?? [],
			...(ctx.database
				? {
						database: {
							...ctx.database,
							runningImage: ctx.service?.image?.split("@")[0] ?? null,
						},
					}
				: {}),
		},
		collectionErrors: ctx.collectionErrors,
	};
};

const VERDICT_RANK: Record<DiagnosticVerdict, number> = {
	down: 0,
	degraded: 1,
	unknown: 2,
	stopped: 3,
	healthy: 4,
};

/**
 * A compose stack: stack-level rules (deployment) plus each service diagnosed
 * on its own, its findings tagged with the service name.
 */
export const runComposeDiagnostics = (
	stack: DiagnosticContext,
	services: DiagnosticContext[],
): DiagnosticReport => {
	const stackReport = runDiagnostics(stack, COMPOSE_STACK_RULES);
	const serviceReports = services.map((ctx) => ({
		ctx,
		report: runDiagnostics(ctx, COMPOSE_SERVICE_RULES),
	}));
	const findings = [
		...stackReport.findings,
		...serviceReports.flatMap(({ ctx, report }) =>
			report.findings.map((f) => ({ ...f, service: ctx.target.service })),
		),
	];
	sortFindings(findings);

	// A stopped service that a domain routes to means traffic is not served.
	const verdicts = serviceReports.map(({ ctx, report }) =>
		report.verdict === "stopped" && ctx.config.domains.length > 0
			? "down"
			: report.verdict,
	);
	let verdict: DiagnosticVerdict =
		verdicts.length === 0
			? stackReport.findings.length
				? "down"
				: "unknown"
			: verdicts.reduce((worst, v) =>
					VERDICT_RANK[v] < VERDICT_RANK[worst] ? v : worst,
				);
	// A failed deployment leaves older containers running: degraded, not healthy.
	if (stackReport.findings.length > 0 && verdict === "healthy") {
		verdict = "degraded";
	}
	// One stopped worker does not take the stack down unless nothing runs.
	if (
		verdict === "down" &&
		serviceReports.every(
			({ ctx }, index) =>
				verdicts[index] !== "down" || ctx.config.domains.length === 0,
		) &&
		serviceReports.some(({ report }) => report.verdict === "healthy")
	) {
		verdict = "degraded";
	}

	const serviceFacts: ComposeServiceFacts[] = serviceReports.map(
		({ ctx, report }) => ({
			name: ctx.target.service ?? "",
			verdict: report.verdict,
			state: ctx.container
				? "running"
				: ctx.service?.exists === false
					? "missing"
					: (ctx.tasks?.[0]?.state ?? null),
			running: !!ctx.container,
			image: ctx.container?.image ?? ctx.service?.image ?? null,
			restartCount: ctx.container?.restartCount ?? ctx.restartCount ?? null,
			health: ctx.container?.health.status ?? null,
			listening: ctx.listening ?? null,
			imageExposedPorts: ctx.imageExposedPorts ?? null,
		}),
	);

	return {
		generatedAt: stack.now.toISOString(),
		target: stack.target,
		verdict,
		findings,
		facts: {
			latestDeploymentStatus: stack.latestDeployment?.status ?? null,
			runningTasks: serviceReports.filter(({ ctx }) => !!ctx.container).length,
			desiredReplicas: services.length,
			listening: null,
			imageExposedPorts: null,
			domains: stack.config.domains,
			publishedPorts: [],
			probes: serviceReports.flatMap(({ ctx }) => ctx.probes ?? []),
			services: serviceFacts,
		},
		collectionErrors: [
			...stack.collectionErrors,
			...serviceReports.flatMap(({ ctx }) =>
				ctx.collectionErrors.map((e) => ({
					...e,
					message: `${ctx.target.service}: ${e.message}`,
				})),
			),
		],
	};
};
