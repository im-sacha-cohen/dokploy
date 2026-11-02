export const DIAGNOSTIC_CODES = [
	"BUILD_FAILED",
	"CONTAINER_CRASH_LOOP",
	"MISSING_ENVIRONMENT_VARIABLE",
	"HEALTHCHECK_FAILED",
	"APPLICATION_NOT_LISTENING",
	"APPLICATION_LISTENING_ON_LOCALHOST",
	"PORT_MISMATCH",
	"REVERSE_PROXY_UNREACHABLE",
	"IMAGE_VERSION_MISMATCH",
	"GIT_COMMIT_OUTDATED",
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export type Confidence = "high" | "medium" | "low";
export type Severity = "critical" | "error" | "warning" | "info";
export type FixRisk = "none" | "low" | "medium" | "high";

export type EvidenceSource =
	| "deployment"
	| "build_logs"
	| "docker_service"
	| "docker_task"
	| "docker_container"
	| "docker_image"
	| "listening_sockets"
	| "proxy_probe"
	| "application_logs"
	| "dokploy_config"
	| "repository";

export interface Evidence {
	source: EvidenceSource;
	summary: string;
	/** Already redacted and sanitized. */
	excerpt?: string[];
}

/**
 * Machine-readable fix. Never applied by the diagnostics engine itself:
 * the caller must obtain explicit user confirmation first.
 */
export type FixAction =
	| { kind: "update_domain_port"; domainId: string; host: string; port: number }
	| { kind: "set_environment_variables"; keys: string[] }
	| { kind: "deploy_latest" }
	| { kind: "redeploy_deployment"; deploymentId: string };

export interface RecommendedFix {
	summary: string;
	steps?: string[];
	action?: FixAction;
}

export interface Finding {
	code: DiagnosticCode;
	title: string;
	description: string;
	severity: Severity;
	confidence: Confidence;
	evidence: Evidence[];
	probableCause: string;
	recommendedFix: RecommendedFix;
	risk: FixRisk;
	autoFixable: boolean;
	/** Findings this one is a consequence of. */
	causedBy?: DiagnosticCode[];
}

export interface DomainFact {
	domainId: string;
	host: string;
	port: number | null;
	path: string | null;
	https: boolean;
}

export interface PublishedPortFact {
	publishedPort: number;
	targetPort: number;
	protocol: string;
}

export interface DeploymentFact {
	deploymentId: string;
	status: string | null;
	createdAt: string;
	errorMessage: string | null;
	logTail?: string[];
}

export interface TaskFact {
	state: string;
	desiredState: string;
	timestamp: string;
	error?: string;
	exitCode?: number;
	containerId?: string;
}

export interface ContainerHealthFact {
	status: "starting" | "healthy" | "unhealthy" | "none";
	failingStreak: number;
	lastOutput?: string[];
	lastExitCode?: number;
}

export interface ContainerFact {
	id: string;
	imageId?: string;
	startedAt: string;
	uptimeSeconds: number;
	health: ContainerHealthFact;
}

export interface ListeningSocket {
	address: string;
	port: number;
	family: "ipv4" | "ipv6";
}

export interface ProbeResult {
	kind: "backend" | "router";
	target: string;
	domainId?: string;
	ok: boolean;
	httpStatus?: number;
	error?: "connection_refused" | "timeout" | "dns" | "other";
	detail?: string;
}

export interface TrackedDeploymentFact {
	deploymentId: string;
	createdAt: string;
	status: string | null;
	kind: string | null;
	imageId: string | null;
	imageTag: string | null;
	builtCommitSha: string | null;
}

export interface VersionFacts {
	/** Most recent deployment, whatever its state. */
	latest: TrackedDeploymentFact | null;
	/** Deployment whose recorded image is the one running now (exact match). */
	running: TrackedDeploymentFact | null;
	remoteHead?:
		| { status: "ok"; sha: string; branch: string; checkedAt: string }
		| { status: "error"; reason: string }
		| { status: "not_applicable"; reason: string };
}

/**
 * Facts gathered before rules run. `undefined` means "not collected" and must
 * never be read as "absent": rules only conclude from facts actually observed.
 */
export interface DiagnosticContext {
	now: Date;
	target: {
		type: "application";
		id: string;
		name: string;
		appName: string;
		serverId: string | null;
	};
	config: {
		domains: DomainFact[];
		publishedPorts: PublishedPortFact[];
		envKeys: string[];
		swarmHealthcheckConfigured: boolean;
	};
	latestDeployment?: DeploymentFact | null;
	service?: { exists: boolean; desiredReplicas: number; image?: string };
	tasks?: TaskFact[];
	container?: ContainerFact | null;
	imageExposedPorts?: number[];
	listening?: ListeningSocket[];
	probes?: ProbeResult[];
	logs?: string[];
	envExampleKeys?: string[];
	version?: VersionFacts;
	collectionErrors: { source: EvidenceSource; message: string }[];
}

export type Rule = (ctx: DiagnosticContext) => Finding | Finding[] | null;

export type DiagnosticVerdict = "healthy" | "degraded" | "down" | "unknown";

export interface DiagnosticReport {
	generatedAt: string;
	target: DiagnosticContext["target"];
	verdict: DiagnosticVerdict;
	findings: Finding[];
	facts: {
		latestDeploymentStatus: string | null;
		runningTasks: number | null;
		desiredReplicas: number | null;
		listening: ListeningSocket[] | null;
		imageExposedPorts: number[] | null;
		domains: DomainFact[];
		probes: ProbeResult[];
	};
	collectionErrors: DiagnosticContext["collectionErrors"];
}
