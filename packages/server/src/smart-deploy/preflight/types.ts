import type { Confidence, Severity } from "../diagnostics/types";

export interface Detection<T> {
	value: T;
	confidence: Confidence;
	/** Files or facts the detection is based on. Never contains secret values. */
	evidence: string[];
}

export interface PortCandidate {
	port: number;
	source:
		| "dockerfile_expose"
		| "code_default"
		| "framework_default"
		| "compose";
	confidence: Confidence;
	evidence: string;
}

export interface PreflightCheck {
	code:
		| "BUILD_CONFIGURATION_MISMATCH"
		| "PORT_MISMATCH"
		| "MISSING_ENVIRONMENT_VARIABLE"
		| "APPLICATION_LISTENING_ON_LOCALHOST"
		| "NO_HEALTHCHECK"
		| "COMPOSE_PROJECT"
		| "NO_DOMAIN"
		| "SOURCE_UNAVAILABLE";
	severity: Severity;
	confidence: Confidence;
	title: string;
	detail: string;
	recommendation: string;
}

/** Raw material read from a temporary clone. Stays server-side. */
export interface RepositorySnapshot {
	commitSha: string | null;
	files: string[];
	contents: Record<string, string>;
	envReferences: string[];
	listenLines: string[];
	truncated: boolean;
}

export interface PreflightConfig {
	buildType: string;
	dockerfilePath: string;
	buildPath: string;
	domains: { domainId: string; host: string; port: number | null }[];
	envKeys: string[];
	swarmHealthcheck: boolean;
}

export interface PreflightAnalysis {
	language: Detection<string> | null;
	framework: Detection<string> | null;
	packageManager: Detection<string> | null;
	dockerfile: Detection<{
		path: string;
		exposedPorts: number[];
		healthcheck: boolean;
		cmd: string | null;
	}> | null;
	compose: Detection<{ file: string; services: string[] }> | null;
	buildCommand: Detection<string> | null;
	startCommand: Detection<string> | null;
	ports: PortCandidate[];
	envVars: {
		referenced: string[];
		documented: string[];
		configured: string[];
		missing: string[];
	};
	healthcheck: Detection<string> | null;
	checks: PreflightCheck[];
}

export interface PreflightReport extends PreflightAnalysis {
	generatedAt: string;
	source: {
		type: string;
		repository: string | null;
		branch: string | null;
		commitSha: string | null;
		buildPath: string;
	};
	durationMs: number;
	error?: string;
}
