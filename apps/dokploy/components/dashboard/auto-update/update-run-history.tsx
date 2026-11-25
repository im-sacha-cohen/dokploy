import { cn } from "@/lib/utils";
import { formatWhen } from "./update-policy-form";

export interface UpdateRunRow {
	updateRunId: string;
	kind: "update" | "rollback";
	status: string;
	fromImage: string | null;
	toImage: string | null;
	reason: string | null;
	startedAt: string;
	finishedAt: string | null;
}

const STATUS: Record<
	string,
	{ label: string; tone: "ok" | "bad" | "busy" | "quiet" }
> = {
	skipped: { label: "Skipped", tone: "quiet" },
	notified: { label: "Notified", tone: "quiet" },
	backing_up: { label: "Backing up", tone: "busy" },
	updating: { label: "Updating", tone: "busy" },
	verifying: { label: "Verifying", tone: "busy" },
	restoring: { label: "Putting back", tone: "busy" },
	succeeded: { label: "Updated", tone: "ok" },
	rolled_back: { label: "Put back", tone: "bad" },
	aborted: { label: "Not started", tone: "bad" },
	failed: { label: "Failed", tone: "bad" },
	interrupted: { label: "Interrupted", tone: "bad" },
};

const TONE = {
	ok: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
	bad: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
	busy: "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
	quiet: "bg-muted text-muted-foreground",
};

/** `repo:tag@sha256:abcdef…` → `repo:tag @abcdef1`. */
export const shortImage = (image: string | null) => {
	if (!image) return "—";
	const [name, digest] = image.split("@");
	const short = digest?.replace("sha256:", "").slice(0, 7);
	return short ? `${name} @${short}` : (name ?? image);
};

export const UpdateRunHistory = ({ runs }: { runs: UpdateRunRow[] }) => {
	if (runs.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">No update attempt yet.</p>
		);
	}
	return (
		<ul className="flex flex-col divide-y rounded-lg border">
			{runs.map((run) => {
				const status = STATUS[run.status] ?? {
					label: run.status,
					tone: "quiet" as const,
				};
				return (
					<li key={run.updateRunId} className="flex flex-col gap-1 p-3">
						<div className="flex flex-wrap items-center gap-2">
							<span
								className={cn(
									"rounded-md px-2 py-0.5 text-xs font-medium",
									TONE[status.tone],
								)}
							>
								{run.kind === "rollback"
									? `Rollback · ${status.label}`
									: status.label}
							</span>
							<span className="text-xs text-muted-foreground">
								{formatWhen(run.startedAt)}
							</span>
						</div>
						{(run.fromImage || run.toImage) && (
							<p className="font-mono text-xs break-all">
								{shortImage(run.fromImage)} → {shortImage(run.toImage)}
							</p>
						)}
						{run.reason && (
							<p className="text-sm text-muted-foreground">{run.reason}</p>
						)}
					</li>
				);
			})}
		</ul>
	);
};
