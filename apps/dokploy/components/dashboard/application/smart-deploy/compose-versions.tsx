import { GitCommitHorizontal, History, RefreshCw, Undo2 } from "lucide-react";
import { useState } from "react";
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
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { shortImage, shortSha } from "./badges";
import { KIND_LABEL } from "./current-deployment";
import { DeployCommitDialog } from "./deploy-commit-dialog";

const STATUS_BADGE: Record<
	string,
	{ variant: "green" | "red" | "yellow" | "outline"; label: string }
> = {
	done: { variant: "green", label: "Done" },
	error: { variant: "red", label: "Failed" },
	running: { variant: "yellow", label: "Running" },
	cancelled: { variant: "outline", label: "Cancelled" },
};

// A queued job creates its deployment row a moment later.
const WATCH_AFTER_ACTION_MS = 20_000;

/** Version history of a compose stack, with rollback and commit deploys. */
export const ComposeVersions = ({ composeId }: { composeId: string }) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canDeploy = !!permissions?.deployment.create;
	const [watchUntil, setWatchUntil] = useState(0);
	const { data, isFetching, refetch, error } =
		api.smartDeploy.getComposeVersions.useQuery(
			{ composeId },
			{
				refetchOnWindowFocus: false,
				refetchInterval: (query) =>
					Date.now() < watchUntil ||
					query.state.data?.history.some((d) => d.status === "running")
						? 3000
						: false,
			},
		);
	const rollback = api.smartDeploy.redeployComposeVersion.useMutation();
	const deployCommit = api.smartDeploy.deployComposeCommit.useMutation();

	const afterAction = async (message: string) => {
		toast.success(message);
		setWatchUntil(Date.now() + WATCH_AFTER_ACTION_MS);
		await utils.smartDeploy.getComposeVersions.invalidate({ composeId });
	};
	const queueCommit = (commitSha: string) =>
		deployCommit
			.mutateAsync({ composeId, commitSha })
			.then(() => afterAction(`Deploy of ${commitSha.slice(0, 7)} queued`));

	const current = data?.history.find(
		(d) => d.deploymentId === data.currentDeploymentId,
	);

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<CardTitle className="flex items-center gap-2 text-xl">
						<History className="size-5" /> Versions
					</CardTitle>
					<CardDescription>
						Each successful deployment keeps the images its services ran (last
						5) and its compose file, so you can go back to it without fetching,
						pulling or building.
					</CardDescription>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void refetch()}
					disabled={isFetching}
				>
					<RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
					Check again
				</Button>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{error && <AlertBlock type="error">{error.message}</AlertBlock>}
				{!data && !error && (
					<p className="text-sm text-muted-foreground">Reading versions…</p>
				)}
				{data?.rollbackUnavailableReason && (
					<AlertBlock type="info">{data.rollbackUnavailableReason}</AlertBlock>
				)}
				{data && (
					<>
						<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
							<div className="flex flex-col gap-1">
								<span className="text-xs uppercase tracking-wide text-muted-foreground">
									Branch
								</span>
								<span className="text-sm font-medium">
									{data.source.branch ?? "—"}
								</span>
							</div>
							<div className="flex flex-col gap-1">
								<span className="text-xs uppercase tracking-wide text-muted-foreground">
									Running version
								</span>
								<span className="text-sm font-medium">
									{current ? (
										<>
											{KIND_LABEL[current.kind ?? ""] ?? current.title}
											{current.builtCommitSha && (
												<>
													{" · "}
													<code>{shortSha(current.builtCommitSha)}</code>
												</>
											)}
										</>
									) : (
										<span
											className="text-muted-foreground"
											title="No recorded deployment has exactly the images that are running"
										>
											Not matched
										</span>
									)}
								</span>
							</div>
							<div className="flex flex-col gap-1">
								<span className="text-xs uppercase tracking-wide text-muted-foreground">
									Running services
								</span>
								<span className="text-sm font-medium">
									{data.live.collected
										? data.live.services.length
										: "Unavailable"}
								</span>
							</div>
						</div>

						{canDeploy && data.canDeployCommit && (
							<div className="flex flex-wrap gap-2">
								<DeployCommitDialog
									serviceType="compose"
									serviceId={composeId}
									runningSha={current?.builtCommitSha}
									branch={data.source.branch}
									onDeploy={queueCommit}
								/>
							</div>
						)}

						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Action</TableHead>
									<TableHead>Commit</TableHead>
									<TableHead>Images</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Date</TableHead>
									<TableHead className="text-right" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.history.length === 0 && (
									<TableRow>
										<TableCell
											colSpan={6}
											className="text-center text-sm text-muted-foreground"
										>
											No deployment yet.
										</TableCell>
									</TableRow>
								)}
								{data.history.slice(0, 10).map((d) => {
									const isCurrent = d.deploymentId === data.currentDeploymentId;
									const older =
										current && d.versionCreatedAt < current.versionCreatedAt;
									const status = STATUS_BADGE[d.status ?? ""];
									return (
										<TableRow key={d.deploymentId}>
											<TableCell>
												<div className="flex items-center gap-2">
													<span title={d.title}>
														{d.kind ? (KIND_LABEL[d.kind] ?? d.kind) : d.title}
													</span>
													{isCurrent && <Badge variant="green">running</Badge>}
												</div>
											</TableCell>
											<TableCell>
												<code>
													{shortSha(d.builtCommitSha ?? d.requestedCommitSha) ??
														"—"}
												</code>
											</TableCell>
											<TableCell className="text-xs">
												{d.services.length === 0 ? (
													<span className="text-muted-foreground">
														Not recorded
													</span>
												) : (
													<span
														title={d.services
															.map(
																(s) =>
																	`${s.service}: ${s.image} (${shortImage(s.imageId)})${s.retained ? "" : " · not kept"}`,
															)
															.join("\n")}
													>
														{d.services.length} service
														{d.services.length > 1 ? "s" : ""}
														{d.services.every((s) => s.retained)
															? " · kept"
															: " · not kept"}
													</span>
												)}
											</TableCell>
											<TableCell>
												{status ? (
													<Badge variant={status.variant}>{status.label}</Badge>
												) : (
													(d.status ?? "—")
												)}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{new Date(d.createdAt).toLocaleString()}
											</TableCell>
											<TableCell className="text-right">
												{canDeploy && d.redeployable && !isCurrent && (
													<DialogAction
														type="default"
														title={
															older
																? "Roll back to this version?"
																: "Redeploy this version?"
														}
														description={`Runs again the exact images of this deployment (${d.services.map((s) => s.service).join(", ")}) with its compose file and today's domains and environment variables. Nothing is fetched, pulled or built. Volumes are kept as they are.`}
														onClick={async () => {
															await rollback
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
												{canDeploy &&
													!d.redeployable &&
													!isCurrent &&
													data.canDeployCommit &&
													d.builtCommitSha && (
														<DeployCommitDialog
															serviceType="compose"
															serviceId={composeId}
															runningSha={current?.builtCommitSha}
															branch={data.source.branch}
															initialSha={d.builtCommitSha}
															onDeploy={queueCommit}
														>
															<Button
																variant="ghost"
																size="sm"
																title="Its images are no longer kept: fetch and build this commit again"
															>
																<GitCommitHorizontal className="size-4" />
																Rebuild commit
															</Button>
														</DeployCommitDialog>
													)}
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					</>
				)}
			</CardContent>
		</Card>
	);
};
