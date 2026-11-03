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
	"IMAGE_PULL_FAILED",
	"OUT_OF_MEMORY",
	"DISK_FULL",
	"DATA_DIRECTORY_INCOMPATIBLE",
	"EXTERNAL_PORT_UNAVAILABLE",
	"CONFIG_NOT_APPLIED",
	"SERVICE_STOPPED",
] as const;

export const DATABASE_TYPES = [
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
] as const;
export type DatabaseType = (typeof DATABASE_TYPES)[number];
export type TargetType = "application" | "compose" | DatabaseType;

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
	| { kind: "redeploy_deployment"; deploymentId: string }
	/** Deploy a database or compose stack again with its current configuration. */
	| { kind: "redeploy_service" };

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
	/** Compose service the finding is about (compose stacks only). */
	service?: string;
}

export interface DomainFact {
	domainId: string;
	host: string;
	port: number | null;
	path: string | null;
	https: boolean;
	/** Compose service the domain routes to. */
	serviceName?: string | null;
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
	/** Image reference the container was created from. */
	image?: string;
	startedAt: string;
	uptimeSeconds: number;
	health: ContainerHealthFact;
	oomKilled?: boolean;
	restartCount?: number;
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
		type: TargetType;
		id: string;
		name: string;
		appName: string;
		serverId: string | null;
		/** Compose service, when the context describes one service of a stack. */
		service?: string;
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
	database?: DatabaseFacts;
	/** Logs of the latest tasks that ran the configured image (databases), when the service runs another one. */
	previousAttemptLogs?: string[];
	/** Restarts of the service's last container, even when it is not running. */
	restartCount?: number;
	collectionErrors: { source: EvidenceSource; message: string }[];
}

export interface DatabaseFacts {
	engine: DatabaseType;
	/** Port the engine listens on inside the container. */
	defaultPort: number;
	/** Host port Dokploy is asked to publish, if any. */
	externalPort: number | null;
	/** Image set in Dokploy. */
	configuredImage: string;
	/** Registry answer when the configured image is not on the server. */
	imageUnavailable?: string;
}

export type Rule = (ctx: DiagnosticContext) => Finding | Finding[] | null;

/** One service of a compose stack, as shown in the report. */
export interface ComposeServiceFacts {
	name: string;
	verdict: DiagnosticVerdict;
	state: string | null;
	running: boolean;
	image: string | null;
	restartCount: number | null;
	health: ContainerHealthFact["status"] | null;
	listening: ListeningSocket[] | null;
	imageExposedPorts: number[] | null;
}

export type DiagnosticVerdict =
	| "healthy"
	| "degraded"
	| "down"
	| "stopped"
	| "unknown";

export interface DiagnosticReport {
	generatedAt: string;
	target: DiagnosticContext["target"];
	verdict: DiagnosticVerdict;
	findings: Finding[];
	facts: {
		latestDeploymentStatus: string | null;
		runningTasks: number | null;
		desiredReplicas: number | null;
		/** False when the Swarm service does not exist (never deployed). */
		serviceExists?: boolean | null;
		listening: ListeningSocket[] | null;
		imageExposedPorts: number[] | null;
		domains: DomainFact[];
		publishedPorts: PublishedPortFact[];
		probes: ProbeResult[];
		/** Compose stacks: one entry per service. */
		services?: ComposeServiceFacts[];
		/** Databases: engine, ports and configured vs running image. */
		database?: DatabaseFacts & { runningImage: string | null };
	};
	collectionErrors: DiagnosticContext["collectionErrors"];
}
