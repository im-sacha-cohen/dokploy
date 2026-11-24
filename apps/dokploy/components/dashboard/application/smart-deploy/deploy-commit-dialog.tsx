import { GitCommitHorizontal, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

const COMMIT_REF = /^[0-9a-f]{7,40}$/;

const relativeDate = (iso: string | null) => {
	if (!iso) return "";
	const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	if (Number.isNaN(seconds)) return "";
	const units: [Intl.RelativeTimeFormatUnit, number][] = [
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	];
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, size] of units) {
		if (seconds >= size)
			return format.format(-Math.floor(seconds / size), unit);
	}
	return format.format(-seconds, "second");
};

interface Props {
	serviceType: "application" | "compose";
	serviceId: string;
	branch: string | null;
	/** Commit currently running, marked in the list. */
	runningSha?: string | null;
	/** Pre-selected commit, e.g. from a history row. */
	initialSha?: string | null;
	onDeploy: (commitSha: string) => Promise<unknown>;
	children?: React.ReactNode;
}

/** Lists the branch's last commits, or takes a pasted SHA, then deploys it. */
export const DeployCommitDialog = ({
	serviceType,
	serviceId,
	branch,
	runningSha,
	initialSha,
	onDeploy,
	children,
}: Props) => {
	const [open, setOpen] = useState(false);
	const [sha, setSha] = useState(initialSha ?? "");
	const [pending, setPending] = useState(false);
	const value = sha.trim().toLowerCase();
	const valid = COMMIT_REF.test(value);
	const { data: remote, isFetching } = api.smartDeploy.listCommits.useQuery(
		{ serviceType, serviceId },
		{ enabled: open, refetchOnWindowFocus: false, staleTime: 30_000 },
	);
	const commits = remote?.status === "ok" ? remote.commits : [];

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setSha(initialSha ?? "");
			}}
		>
			<DialogTrigger asChild>
				{children ?? (
					<Button variant="secondary">
						<GitCommitHorizontal className="size-4" /> Deploy a commit…
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Deploy a specific commit</DialogTitle>
					<DialogDescription>
						Fetches this commit, builds it and replaces the running version. The
						next push or "Deploy" goes back to the head of{" "}
						{branch ? <code>{branch}</code> : "the branch"}.
					</DialogDescription>
				</DialogHeader>
				<form
					className="flex min-w-0 flex-col gap-2"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!valid) return;
						setPending(true);
						try {
							await onDeploy(value);
							setOpen(false);
						} catch (error) {
							toast.error(
								error instanceof Error ? error.message : String(error),
							);
						} finally {
							setPending(false);
						}
					}}
				>
					<span className="text-sm font-medium">
						Last commits on {branch ? <code>{branch}</code> : "the branch"}
					</span>
					<div className="max-h-72 overflow-y-auto rounded-md border">
						{isFetching && !remote && (
							<p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" /> Reading the
								repository…
							</p>
						)}
						{remote && remote.status !== "ok" && (
							<p className="p-3 text-sm text-muted-foreground">
								Commits unavailable ({remote.reason}). Paste a SHA below.
							</p>
						)}
						{remote?.status === "ok" && commits.length === 0 && (
							<p className="p-3 text-sm text-muted-foreground">
								No commit found on this branch.
							</p>
						)}
						{commits.map((commit, index) => {
							const selected =
								value.length >= 7 && commit.sha.startsWith(value);
							return (
								<button
									key={commit.sha}
									type="button"
									onClick={() => setSha(commit.sha)}
									className={cn(
										"flex w-full items-start gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted",
										selected && "bg-muted",
									)}
								>
									<code className="shrink-0 pt-0.5 text-xs">
										{commit.sha.slice(0, 7)}
									</code>
									<span className="flex min-w-0 flex-1 flex-col">
										<span className="truncate">{commit.message || "—"}</span>
										<span className="text-xs text-muted-foreground">
											{[commit.author, relativeDate(commit.date)]
												.filter(Boolean)
												.join(" · ")}
										</span>
									</span>
									<span className="flex shrink-0 gap-1">
										{index === 0 && <Badge variant="blue">latest</Badge>}
										{runningSha === commit.sha && (
											<Badge variant="green">running</Badge>
										)}
									</span>
								</button>
							);
						})}
					</div>
					<Label htmlFor="deploy-commit-sha" className="pt-2">
						Commit SHA
					</Label>
					<Input
						id="deploy-commit-sha"
						placeholder="Pick a commit above or paste a SHA"
						autoComplete="off"
						spellCheck={false}
						className="font-mono"
						value={sha}
						onChange={(event) => setSha(event.target.value)}
					/>
					<p className="text-xs text-muted-foreground">
						Full or short SHA (7 characters or more). A short SHA must be on{" "}
						{branch ? <code>{branch}</code> : "the configured branch"}.
					</p>
					{sha && !valid && (
						<p className="text-xs text-red-600 dark:text-red-400">
							Expected 7 to 40 hexadecimal characters.
						</p>
					)}
					<DialogFooter>
						<Button type="submit" disabled={!valid} isLoading={pending}>
							Deploy {valid ? value.slice(0, 7) : "commit"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};
