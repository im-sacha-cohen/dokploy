import { Wrench } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import {
	type ServiceType,
	useRefreshServiceDiagnosis,
} from "./use-service-diagnosis";

export type ServiceFixAction =
	| { kind: "update_domain_port"; domainId: string; host: string; port: number }
	| { kind: "redeploy_service" };

export const isServiceFix = (action: {
	kind: string;
}): action is ServiceFixAction =>
	action.kind === "update_domain_port" || action.kind === "redeploy_service";

const describe = (
	action: ServiceFixAction,
	serviceType: ServiceType,
	stopped: boolean,
	risk: string,
) =>
	action.kind === "update_domain_port"
		? `Change the port ${action.host} routes to into ${action.port}, then redeploy the stack so Traefik picks it up. Risk: ${risk}.`
		: stopped
			? `Start the ${serviceType === "compose" ? "stack" : "database"}. Risk: ${risk}.`
			: `Deploy the ${serviceType === "compose" ? "stack" : "database"} again with its current configuration. Risk: ${risk}.`;

/** Confirmed, server-revalidated fix (smartDeploy.applyServiceFix). */
export const ServiceFixButton = ({
	serviceType,
	serviceId,
	action,
	risk,
	stopped = false,
}: {
	serviceType: ServiceType;
	serviceId: string;
	action: ServiceFixAction;
	risk: string;
	stopped?: boolean;
}) => {
	const apply = api.smartDeploy.applyServiceFix.useMutation();
	const refresh = useRefreshServiceDiagnosis(serviceType, serviceId);
	const label =
		action.kind === "update_domain_port"
			? `Use port ${action.port}`
			: stopped
				? "Start"
				: "Redeploy";
	return (
		<DialogAction
			type="default"
			title="Apply this fix?"
			description={describe(action, serviceType, stopped, risk)}
			onClick={async () => {
				await apply
					.mutateAsync({ serviceType, serviceId, action })
					.then(async () => {
						toast.success(
							action.kind === "update_domain_port"
								? "Port updated, redeploying"
								: stopped
									? "Starting"
									: "Redeploy queued",
						);
						await refresh();
					})
					.catch((e) => toast.error(e.message));
			}}
		>
			<Button size="sm" isLoading={apply.isPending}>
				<Wrench className="size-4" /> {label}
			</Button>
		</DialogAction>
	);
};
