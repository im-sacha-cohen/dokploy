import { Loader2, RefreshCw, Rocket, RotateCcw, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";
import {
	LiveStatusBadge,
	shortImage,
	shortSha,
	VerificationBadge,
	VersionBadge,
} from "./badges";

const KIND_LABEL: Record<string, string> = {
	deploy_latest: "Deploy latest",
	rebuild: "Rebuild",
	redeploy: "Redeploy",
	rollback: "Rollback",
	restart: "Restart",
};

const Row = ({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) => (
	<div className="flex flex-col gap-1">
		<span className="text-xs uppercase tracking-wide text-muted-foreground">
			{label}
		</span>
		<div className="text-sm font-medium break-all">{children}</div>
	</div>
);

interface Props {
	applicationId: string;
	canDeploy: boolean;
	onActionStarted: () => void;
}

export const CurrentDeployment = ({
	applicationId,
	canDeploy,
	onActionStarted,
}: Props) => {
	const utils = api.useUtils();
	const { data, isLoading, isFetching, refetch, error } =
		api.smartDeploy.getVersionStatus.useQuery(
			{ applicationId, checkRemote: true },
			{ refetchOnWindowFocus: false },
		);
	const deployLatest = api.smartDeploy.deployLatest.useMutation();
	const { data: live, isFetching: isDiagnosing } =
		api.smartDeploy.diagnoseApplication.useQuery(
			{ applicationId },
			{ refetchOnWindowFocus: false },
		);
	const restart = api.smartDeploy.restartApplication.useMutation();
	const redeploy = api.smartDeploy.redeployVersion.useMutation();

	const afterAction = async (message: string) => {
		toast.success(message);
		await utils.smartDeploy.getVersionStatus.invalidate({ applicationId });
		await utils.smartDeploy.diagnoseApplication.invalidate({ applicationId });
		onActionStarted();
	};

	if (isLoading) {
		return (
			<Card className="bg-background">
				<CardContent className="flex items-center gap-2 py-8 text-muted-foreground">
					<Loader2 className="size-4 animate-spin" /> Reading the running
					version…
				</CardContent>
			</Card>
		);
	}
	if (error || !data) {
		return (
			<AlertBlock type="error">
				{error?.message ?? "Version status unavailable"}
			</AlertBlock>
		);
	}

	const remote = data.latestRemote;
	const current = data.current;

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<CardTitle className="text-xl">Current deployment</CardTitle>
					<CardDescription>
						What is actually running, compared with the repository. Nothing here
						is assumed: unverified values are shown as such.
					</CardDescription>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => {
						void refetch();
						void utils.smartDeploy.diagnoseApplication.invalidate({
							applicationId,
						});
					}}
					disabled={isFetching}
				>
					<RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
					Check again
				</Button>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
					<Row label="Status (live)">
						{live ? (
							<LiveStatusBadge verdict={live.verdict} />
						) : (
							<span className="text-muted-foreground">
								{isDiagnosing ? "Checking…" : "Unavailable"}
							</span>
						)}
					</Row>
					<Row label="Last deployment check">
						<VerificationBadge status={current?.verificationStatus} />
					</Row>
					<Row label="Branch">{data.source.branch ?? "—"}</Row>
					<Row label="Running commit">
						{data.runningCommitSha ? (
							<code>{shortSha(data.runningCommitSha)}</code>
						) : (
							<span className="text-muted-foreground">Unknown</span>
						)}
					</Row>
					<Row label="Latest remote commit">
						{remote.status === "ok" ? (
							<code>{shortSha(remote.sha)}</code>
						) : (
							<span
								className="text-muted-foreground"
								title={"reason" in remote ? remote.reason : undefined}
							>
								Not verified
							</span>
						)}
					</Row>
					<Row label="Running image">
						{data.live.runningImageId ? (
							<code title={data.live.runningImageId}>
								{shortImage(data.live.runningImageId)}
							</code>
						) : (
							<span className="text-muted-foreground">
								No running container
							</span>
						)}
					</Row>
					<Row label="Replicas">
						{data.live.collected
							? `${data.live.runningTasks}/${data.live.desiredReplicas} running`
							: "Unavailable"}
					</Row>
					<Row label="Version status">
						<VersionBadge state={data.versionState} />
					</Row>
					<Row label="Matched by">
						{data.currentMatch === "image_match"
							? "Exact image"
							: data.currentMatch === "latest_successful"
								? "Latest successful (not exact)"
								: "—"}
					</Row>
				</div>
				<p className="text-sm text-muted-foreground">{data.versionReason}</p>

				{canDeploy && (
					<div className="flex flex-wrap gap-2">
						<DialogAction
							type="default"
							title="Deploy the latest commit?"
							description={`Fetches the head of ${data.source.branch ?? "the branch"}${remote.status === "ok" ? ` (${shortSha(remote.sha)})` : ""}, builds it and replaces the running version.`}
							onClick={async () => {
								await deployLatest
									.mutateAsync({ applicationId })
									.then(() => afterAction("Deploy latest queued"))
									.catch((e) => toast.error(e.message));
							}}
						>
							<Button
								variant={
									data.recommendedAction === "deploy_latest"
										? "default"
										: "secondary"
								}
								isLoading={deployLatest.isPending}
							>
								<Rocket className="size-4" /> Deploy latest
								{data.recommendedAction === "deploy_latest" && (
									<span className="text-xs opacity-80">· recommended</span>
								)}
							</Button>
						</DialogAction>
						<DialogAction
							type="default"
							title="Restart the application?"
							description="Restarts the containers with the current image and settings. Nothing is fetched or rebuilt."
							onClick={async () => {
								await restart
									.mutateAsync({ applicationId })
									.then(() => afterAction("Restart started"))
									.catch((e) => toast.error(e.message));
							}}
						>
							<Button variant="secondary" isLoading={restart.isPending}>
								<RotateCcw className="size-4" /> Restart
							</Button>
						</DialogAction>
					</div>
				)}

				<div className="flex flex-col gap-2">
					<span className="text-sm font-medium">Version history</span>
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Action</TableHead>
								<TableHead>Commit</TableHead>
								<TableHead>Image</TableHead>
								<TableHead>Verification</TableHead>
								<TableHead>Date</TableHead>
								<TableHead className="text-right" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.history.slice(0, 8).map((d) => {
								const isCurrent = d.deploymentId === current?.deploymentId;
								const older = current && d.createdAt < current.createdAt;
								return (
									<TableRow key={d.deploymentId}>
										<TableCell>
											<div className="flex items-center gap-2">
												{d.kind ? (KIND_LABEL[d.kind] ?? d.kind) : d.title}
												{isCurrent && data.currentMatch === "image_match" && (
													<Badge variant="green">running</Badge>
												)}
											</div>
										</TableCell>
										<TableCell>
											<code>{shortSha(d.builtCommitSha) ?? "—"}</code>
										</TableCell>
										<TableCell>
											<code>{shortImage(d.imageId) ?? "—"}</code>
										</TableCell>
										<TableCell>
											{d.status === "error" ? (
												<Badge variant="red">Build failed</Badge>
											) : (
												<VerificationBadge status={d.verificationStatus} />
											)}
										</TableCell>
										<TableCell className="text-muted-foreground text-xs">
											{new Date(d.createdAt).toLocaleString()}
										</TableCell>
										<TableCell className="text-right">
											{canDeploy &&
												d.redeployable &&
												!isCurrent &&
												d.imageId !== data.live.runningImageId && (
													<DialogAction
														type="default"
														title={
															older
																? "Roll back to this version?"
																: "Redeploy this version?"
														}
														description={`Runs again the exact image ${shortImage(d.imageId)} (commit ${shortSha(d.builtCommitSha) ?? "unknown"}) with the current settings. No fetch, no build.`}
														onClick={async () => {
															await redeploy
																.mutateAsync({ deploymentId: d.deploymentId })
																.then(() =>
																	afterAction(
																		older
																			? "Rollback queued"
																			: "Redeploy queued",
																	),
																)
																.catch((e) => toast.error(e.message));
														}}
													>
														<Button variant="ghost" size="sm">
															<Undo2 className="size-4" />
															{older ? "Roll back" : "Redeploy"}
														</Button>
													</DialogAction>
												)}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			</CardContent>
		</Card>
	);
};
