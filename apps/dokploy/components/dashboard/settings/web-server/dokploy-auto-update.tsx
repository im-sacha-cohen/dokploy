import { CalendarClock, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
	formatWhen,
	UpdatePolicyForm,
} from "@/components/dashboard/auto-update/update-policy-form";
import {
	shortImage,
	UpdateRunHistory,
} from "@/components/dashboard/auto-update/update-run-history";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

const UNFINISHED = ["backing_up", "updating", "verifying", "restoring"];

/** Scheduled updates of Dokploy itself (Settings › Web Server). */
export const DokployAutoUpdate = () => {
	const utils = api.useUtils();
	const { data, isLoading } = api.updatePolicy.getDokploy.useQuery(undefined, {
		refetchInterval: (query) =>
			query.state.data?.updater.running ? 10_000 : false,
	});
	const refresh = () => utils.updatePolicy.getDokploy.invalidate();
	const save = api.updatePolicy.saveDokploy.useMutation({
		onSuccess: () => {
			toast.success("Dokploy update rule saved");
			void refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const resume = api.updatePolicy.resumeDokploy.useMutation({
		onSuccess: () => {
			toast.success("Putting back the version that ran before");
			void refresh();
		},
		onError: (error) => toast.error(error.message),
	});
	const rollback = api.updatePolicy.rollbackDokploy.useMutation({
		onSuccess: () => {
			toast.success(
				"Going back: the panel restarts in a few minutes, then reload the page",
			);
			void refresh();
		},
		onError: (error) => toast.error(error.message),
	});

	const state = data?.updater.state;
	const unfinished = state && UNFINISHED.includes(state.status);

	return (
		<div className="w-full">
			<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto">
				<div className="rounded-xl bg-background shadow-md">
					<CardHeader>
						<CardTitle className="text-xl flex flex-row gap-2">
							<CalendarClock className="size-6 text-muted-foreground self-center" />
							Scheduled Dokploy updates
						</CardTitle>
						<CardDescription>
							Updates the panel in a window you choose. Its database and
							configuration are saved first; if the new version does not stay
							healthy, the exact previous version, database and configuration
							are put back. Your applications keep running throughout.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-6 py-6 border-t">
						{isLoading || !data ? (
							<p className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2 className="size-4 animate-spin" /> Loading…
							</p>
						) : (
							<>
								{unfinished && data.updater.running && (
									<AlertBlock type="info">
										An update is running ({state.status.replace("_", " ")}):{" "}
										{shortImage(state.fromImage)} → {shortImage(state.toImage)}.
										The panel restarts during it.
									</AlertBlock>
								)}
								{unfinished && !data.updater.running && (
									<AlertBlock type="error">
										<div className="flex flex-col gap-2">
											<span>
												The updater stopped while{" "}
												{state.status.replace("_", " ")}
												(server restart?). Nothing else updates until the
												version that ran before is put back.
											</span>
											<DialogAction
												title="Put back the previous version?"
												description={`Dokploy goes back to ${shortImage(state.fromImage)} with the database and configuration saved before this update.`}
												type="default"
												onClick={() => resume.mutate()}
											>
												<Button
													size="sm"
													variant="outline"
													className="w-fit"
													disabled={resume.isPending}
												>
													<RotateCcw className="size-4" /> Resume and put back
												</Button>
											</DialogAction>
										</div>
									</AlertBlock>
								)}

								<UpdatePolicyForm
									policy={data.policy}
									saving={save.isPending}
									onSave={(settings) =>
										save.mutate({ ...settings, backupIds: [] })
									}
									marginMinutes={data.marginMinutes}
								/>

								{data.rollbackable.length > 0 && (
									<div className="flex flex-col gap-2">
										<h3 className="text-sm font-medium">
											Go back to before an update
										</h3>
										<p className="text-sm text-muted-foreground">
											The saved state of the last updates. Going back restores
											the database too: what was changed in the panel since then
											is lost. The current state is saved first.
										</p>
										<ul className="flex flex-col divide-y rounded-lg border">
											{data.rollbackable.map((run) => (
												<li
													key={run.updaterRunId}
													className="flex flex-wrap items-center justify-between gap-2 p-3"
												>
													<div className="flex flex-col gap-0.5">
														<span className="text-sm">
															Update of {formatWhen(run.startedAt)}
														</span>
														<span className="font-mono text-xs text-muted-foreground break-all">
															back to {shortImage(run.fromImage)}
														</span>
													</div>
													<DialogAction
														title="Go back to before this update?"
														description={`Dokploy will run ${shortImage(run.fromImage)} again, and its database and configuration go back to ${formatWhen(run.startedAt)}. Changes made in the panel since then are lost.`}
														onClick={() =>
															rollback.mutate({
																updaterRunId: run.updaterRunId,
															})
														}
													>
														<Button
															size="sm"
															variant="outline"
															disabled={rollback.isPending || !!unfinished}
														>
															<RotateCcw className="size-4" /> Go back
														</Button>
													</DialogAction>
												</li>
											))}
										</ul>
									</div>
								)}

								<div className="flex flex-col gap-2">
									<h3 className="text-sm font-medium">History</h3>
									<UpdateRunHistory runs={data.runs} />
								</div>
							</>
						)}
					</CardContent>
				</div>
			</Card>
		</div>
	);
};
