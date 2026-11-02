import type {
	DeploymentVerification,
	VerificationStage,
} from "@dokploy/server/db/schema";

export type TimelineState =
	| "done"
	| "failed"
	| "running"
	| "pending"
	| "skipped";

export interface TimelineEvent {
	key: string;
	label: string;
	state: TimelineState;
	at?: string;
	detail?: string;
}

interface DeploymentLike {
	createdAt: string;
	status: string | null;
	kind: string | null;
	verificationStatus: string | null;
	verification: DeploymentVerification | null;
	errorMessage?: string | null;
}

const STAGES: [keyof DeploymentVerification["stages"], string][] = [
	["build", "Build"],
	["containerCreated", "Container created"],
	["containerRunning", "Container running"],
	["healthy", "Application healthy"],
	["reachable", "Application reachable"],
];

const stageState = (
	stage: VerificationStage,
	inProgress: boolean,
): TimelineState => {
	switch (stage.status) {
		case "passed":
			return "done";
		case "failed":
			return "failed";
		case "skipped":
		case "not_applicable":
			return "skipped";
		default:
			return inProgress ? "running" : "pending";
	}
};

/** Builds the timeline from what was actually recorded; nothing is inferred. */
export const buildTimeline = (deployment: DeploymentLike) => {
	const settled =
		deployment.status !== "running" &&
		!["pending", "verifying", null].includes(deployment.verificationStatus);
	const events: TimelineEvent[] = [
		{
			key: "queued",
			label: "Deployment started",
			state: "done",
			at: deployment.createdAt,
		},
	];

	const verification = deployment.verification;
	if (!verification) {
		events.push({
			key: "legacy",
			label:
				deployment.status === "running"
					? "Building"
					: `Finished (${deployment.status})`,
			state:
				deployment.status === "running"
					? "running"
					: deployment.status === "error"
						? "failed"
						: "done",
			detail: "No step-by-step tracking for this deployment.",
		});
		return { settled: deployment.status !== "running", events };
	}

	let currentFound = false;
	for (const [key, label] of STAGES) {
		const stage = verification.stages[key];
		const isCurrent = !settled && !currentFound && stage.status === "pending";
		if (isCurrent) currentFound = true;
		events.push({
			key,
			label,
			state: stageState(stage, isCurrent),
			at: stage.at,
			detail:
				stage.status === "not_applicable"
					? (stage.detail ?? "Not applicable")
					: stage.detail,
		});
	}
	if (verification.notes?.length) {
		events.push({
			key: "notes",
			label: "Notes",
			state: "skipped",
			detail: verification.notes.join(" "),
		});
	}
	return { settled, events };
};
