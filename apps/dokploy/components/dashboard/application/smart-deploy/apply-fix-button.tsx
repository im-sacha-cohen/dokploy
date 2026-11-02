import { Wrench } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { useRefreshDiagnosis } from "./use-diagnosis";

type ApplicableAction =
	| { kind: "update_domain_port"; domainId: string; host: string; port: number }
	| { kind: "deploy_latest" }
	| { kind: "redeploy_deployment"; deploymentId: string };

export const describeFix = (action: ApplicableAction, risk: string) => {
	switch (action.kind) {
		case "update_domain_port":
			return `Change the port ${action.host} routes to into ${action.port}, then regenerate its Traefik route. Risk: ${risk}. You can change it back in the Domains tab.`;
		case "deploy_latest":
			return `Fetch, build and deploy the latest commit of the branch. Risk: ${risk}.`;
		case "redeploy_deployment":
			return `Run again the image of deployment ${action.deploymentId}, without rebuilding. Risk: ${risk}.`;
	}
};

export const fixLabel = (action: ApplicableAction) => {
	switch (action.kind) {
		case "update_domain_port":
			return `Use port ${action.port}`;
		case "deploy_latest":
			return "Deploy latest";
		case "redeploy_deployment":
			return "Redeploy";
	}
};

/** Confirmed, server-revalidated fix (smartDeploy.applyFix). */
export const ApplyFixButton = ({
	applicationId,
	action,
	risk,
	size = "sm",
	variant = "default",
}: {
	applicationId: string;
	action: ApplicableAction;
	risk: string;
	size?: "sm" | "default";
	variant?: "default" | "secondary" | "outline";
}) => {
	const applyFix = api.smartDeploy.applyFix.useMutation();
	const refresh = useRefreshDiagnosis(applicationId);
	return (
		<DialogAction
			type="default"
			title="Apply this fix?"
			description={describeFix(action, risk)}
			onClick={async () => {
				await applyFix
					.mutateAsync({ applicationId, action })
					.then(async () => {
						toast.success(
							action.kind === "update_domain_port"
								? "Port updated"
								: "Fix queued",
						);
						await refresh();
					})
					.catch((e) => toast.error(e.message));
			}}
		>
			<Button size={size} variant={variant} isLoading={applyFix.isPending}>
				<Wrench className="size-4" /> {fixLabel(action)}
			</Button>
		</DialogAction>
	);
};
