import { Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";
import { CurrentDeployment } from "./current-deployment";
import {
	ConfigurationStep,
	PreflightStep,
	ResultStep,
	SourceStep,
	TimelineStep,
} from "./wizard-steps";

const STEPS = [
	"Source",
	"Configuration",
	"Preflight",
	"Deployment",
	"Result",
] as const;

interface Props {
	applicationId: string;
}

export const ShowSmartDeploy = ({ applicationId }: Props) => {
	const utils = api.useUtils();
	const { data: application } = api.application.one.useQuery({ applicationId });
	const { data: permissions } = api.user.getPermissions.useQuery();
	const [step, setStep] = useState(0);
	const [preflight, setPreflight] = useState<
		RouterOutputs["smartDeploy"]["preflight"] | null
	>(null);
	const [deploymentId, setDeploymentId] = useState<string | null>(null);
	const runPreflight = api.smartDeploy.preflight.useMutation();
	const deployLatest = api.smartDeploy.deployLatest.useMutation();

	if (!application) return null;
	const canDeploy = !!permissions?.deployment.create;
	const canFix = canDeploy || !!permissions?.domain.create;
	const blocking =
		preflight?.checks.filter((c) => c.severity === "error") ?? [];

	const refreshVersion = () =>
		utils.smartDeploy.getVersionStatus.invalidate({ applicationId });

	// The queue creates the deployment row asynchronously: wait for the new id.
	const waitForNewDeployment = async (knownIds: Set<string>) => {
		for (let i = 0; i < 60; i++) {
			const rows = await utils.deployment.all.fetch({ applicationId });
			const fresh = rows.find((d) => !knownIds.has(d.deploymentId));
			if (fresh) return fresh.deploymentId;
			await new Promise((r) => setTimeout(r, 2000));
		}
		return null;
	};

	const startDeploy = async () => {
		const before = await utils.deployment.all.fetch({ applicationId });
		await deployLatest.mutateAsync({ applicationId });
		setDeploymentId(null);
		setStep(3);
		const id = await waitForNewDeployment(
			new Set(before.map((d) => d.deploymentId)),
		);
		if (!id) toast.error("The deployment did not start within 2 minutes");
		setDeploymentId(id);
		void refreshVersion();
	};

	return (
		<div className="flex flex-col gap-4">
			<CurrentDeployment
				applicationId={applicationId}
				canDeploy={canDeploy}
				onActionStarted={() => {
					void refreshVersion();
				}}
			/>
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl">Deploy</CardTitle>
					<CardDescription>
						Check the source and configuration, analyse the repository, then
						follow the deployment until the application is verified.
					</CardDescription>
				</CardHeader>
				<CardContent className="flex flex-col gap-6">
					<ol className="flex flex-wrap gap-2">
						{STEPS.map((label, index) => (
							<li key={label}>
								<button
									type="button"
									onClick={() => setStep(index)}
									className={cn(
										"flex items-center gap-2 rounded-full border px-3 py-1 text-sm",
										index === step
											? "border-primary bg-primary text-primary-foreground"
											: index < step
												? "border-primary/50"
												: "text-muted-foreground",
									)}
								>
									<span className="font-mono">{index + 1}</span> {label}
								</button>
							</li>
						))}
					</ol>

					{step === 0 && <SourceStep application={application} />}
					{step === 1 && <ConfigurationStep application={application} />}
					{step === 2 && (
						<PreflightStep
							report={preflight}
							isRunning={runPreflight.isPending}
							onRun={async () => {
								await runPreflight
									.mutateAsync({ applicationId })
									.then(setPreflight)
									.catch((e) => toast.error(e.message));
							}}
						/>
					)}
					{step === 3 && (
						<TimelineStep
							deploymentId={deploymentId}
							serverId={
								application.buildServerId || application.serverId || undefined
							}
							onSettled={() => {
								void refreshVersion();
								void utils.smartDeploy.diagnoseApplication.invalidate({
									applicationId,
								});
							}}
						/>
					)}
					{step === 4 && (
						<ResultStep
							applicationId={applicationId}
							canFix={canFix}
							onFixed={() => {
								void refreshVersion();
							}}
						/>
					)}

					<div className="flex flex-wrap justify-between gap-2 border-t pt-4">
						<Button
							variant="outline"
							disabled={step === 0}
							onClick={() => setStep(step - 1)}
						>
							Back
						</Button>
						<div className="flex gap-2">
							{step === 2 && canDeploy && (
								<DialogAction
									type={blocking.length ? "destructive" : "default"}
									title="Deploy the latest commit?"
									description={
										blocking.length
											? `The preflight found ${blocking.length} blocking issue(s): ${blocking.map((c) => c.title).join("; ")}. The deployment will probably fail.`
											: preflight
												? "Fetches the head of the branch, builds it and replaces the running version."
												: "The preflight analysis has not been run. Deploy anyway?"
									}
									onClick={() => {
										void startDeploy().catch((e) => toast.error(e.message));
									}}
								>
									<Button isLoading={deployLatest.isPending}>
										<Rocket className="size-4" /> Deploy latest
									</Button>
								</DialogAction>
							)}
							{step < STEPS.length - 1 && (
								<Button variant="secondary" onClick={() => setStep(step + 1)}>
									Next
								</Button>
							)}
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
};
