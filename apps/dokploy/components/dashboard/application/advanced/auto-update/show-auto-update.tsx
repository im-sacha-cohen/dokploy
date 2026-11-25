import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { UpdatePolicyForm } from "@/components/dashboard/auto-update/update-policy-form";
import { UpdateRunHistory } from "@/components/dashboard/auto-update/update-run-history";
import { AlertBlock } from "@/components/shared/alert-block";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { api } from "@/utils/api";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Scheduled updates of an application deployed from a Docker image. */
export const ShowAutoUpdate = ({
	applicationId,
}: {
	applicationId: string;
}) => {
	const utils = api.useUtils();
	const { data, isLoading } = api.updatePolicy.getForApplication.useQuery({
		applicationId,
	});
	const save = api.updatePolicy.saveForApplication.useMutation({
		onSuccess: () => {
			toast.success("Update rule saved");
			void utils.updatePolicy.getForApplication.invalidate({ applicationId });
		},
		onError: (error) => toast.error(error.message),
	});

	const dokploy = data?.dokployWindow;

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl">Scheduled updates</CardTitle>
				<CardDescription>
					Deploys a newer image in a window you choose, after the backups you
					pick. If Smart Deploy does not find the new version healthy, or it
					stops before the watch time ends, the previous image is deployed
					again.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{isLoading || !data ? (
					<p className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading…
					</p>
				) : data.sourceType !== "docker" ? (
					<AlertBlock type="info">
						Scheduled updates cover applications deployed from a Docker image.
						For an application built from Git, turn on auto deploy to deploy
						each push.
					</AlertBlock>
				) : (
					<>
						<UpdatePolicyForm
							policy={data.policy}
							saving={save.isPending}
							onSave={(settings) => save.mutate({ applicationId, settings })}
							backupOptions={data.backupOptions}
							marginMinutes={data.marginMinutes}
							conflictNote={
								dokploy && (
									<p className="mt-1 text-xs text-muted-foreground">
										Dokploy updates itself on{" "}
										{dokploy.days.map((d) => DAY_NAMES[d]).join(", ")} at{" "}
										{dokploy.startTime} for {dokploy.durationMinutes} min (
										{dokploy.timezone}): this window must stay at least{" "}
										{data.marginMinutes} min away from it.
									</p>
								)
							}
						/>
						<div className="flex flex-col gap-2">
							<h3 className="text-sm font-medium">History</h3>
							<UpdateRunHistory runs={data.runs} />
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
};
