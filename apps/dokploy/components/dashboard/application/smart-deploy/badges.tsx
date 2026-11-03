import { Badge } from "@/components/ui/badge";

export const shortSha = (sha?: string | null) => (sha ? sha.slice(0, 7) : null);
export const shortImage = (id?: string | null) =>
	id ? id.replace(/^sha256:/, "").slice(0, 12) : null;

const VERIFICATION: Record<
	string,
	{ label: string; variant: "green" | "yellow" | "red" | "orange" | "outline" }
> = {
	healthy: { label: "Healthy", variant: "green" },
	running: { label: "Running (no healthcheck)", variant: "yellow" },
	degraded: { label: "Degraded", variant: "orange" },
	failed: { label: "Failed", variant: "red" },
	verifying: { label: "Verifying…", variant: "outline" },
	pending: { label: "Pending", variant: "outline" },
	unknown: { label: "Unknown", variant: "outline" },
};

export const VerificationBadge = ({ status }: { status?: string | null }) => {
	const entry = VERIFICATION[status ?? ""] ?? {
		label: "Not tracked",
		variant: "outline" as const,
	};
	return <Badge variant={entry.variant}>{entry.label}</Badge>;
};

const VERSION: Record<
	string,
	{ label: string; variant: "green" | "orange" | "outline" }
> = {
	up_to_date: { label: "Up to date", variant: "green" },
	outdated: { label: "Outdated", variant: "orange" },
	unknown: { label: "Unknown", variant: "outline" },
	not_applicable: { label: "N/A", variant: "outline" },
};

export const VersionBadge = ({ state }: { state: string }) => {
	const entry = VERSION[state] ?? VERSION.unknown;
	return <Badge variant={entry?.variant}>{entry?.label}</Badge>;
};

export const ConfidenceBadge = ({ confidence }: { confidence: string }) => (
	<Badge
		variant={
			confidence === "high"
				? "green"
				: confidence === "medium"
					? "yellow"
					: "outline"
		}
		title="Confidence"
	>
		{confidence} confidence
	</Badge>
);

export const SeverityBadge = ({ severity }: { severity: string }) => (
	<Badge
		variant={
			severity === "critical" || severity === "error"
				? "red"
				: severity === "warning"
					? "orange"
					: "outline"
		}
	>
		{severity}
	</Badge>
);

const LIVE: Record<
	string,
	{ label: string; variant: "green" | "orange" | "red" | "outline" }
> = {
	healthy: { label: "Healthy", variant: "green" },
	degraded: { label: "Degraded", variant: "orange" },
	down: { label: "Down", variant: "red" },
	stopped: { label: "Stopped", variant: "outline" },
	unknown: { label: "Unknown", variant: "outline" },
};

export const LiveStatusBadge = ({ verdict }: { verdict: string }) => {
	const entry = LIVE[verdict] ?? LIVE.unknown;
	return <Badge variant={entry?.variant}>{entry?.label}</Badge>;
};

const OUTCOME: Record<
	string,
	{ label: string; variant: "green" | "yellow" | "red" | "orange" | "outline" }
> = {
	healthy: { label: "Verified healthy", variant: "green" },
	running: { label: "Running · no healthcheck", variant: "yellow" },
	degraded: {
		label: "Running but unhealthy or unreachable",
		variant: "orange",
	},
	failed: { label: "App did not start", variant: "red" },
	verifying: { label: "Verifying…", variant: "outline" },
	pending: { label: "Verifying…", variant: "outline" },
	unknown: { label: "Not verified", variant: "outline" },
};

/**
 * What actually happened after a "done" deployment: upstream marks a
 * deployment done once the build finished, whether or not the app runs.
 */
export const DeploymentOutcomeBadge = ({
	status,
	verificationStatus,
}: {
	status?: string | null;
	verificationStatus?: string | null;
}) => {
	if (!verificationStatus || status === "error" || status === "running")
		return null;
	const outcome = OUTCOME[verificationStatus];
	if (!outcome) return null;
	if (verificationStatus === "failed" && status === "done") {
		return <Badge variant="red">Build OK · {outcome.label}</Badge>;
	}
	return <Badge variant={outcome.variant}>{outcome.label}</Badge>;
};
