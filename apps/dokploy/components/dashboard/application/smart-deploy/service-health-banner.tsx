import { pickRootCause } from "@dokploy/server/smart-deploy/diagnostics/presentation";
import type { Finding } from "@dokploy/server/smart-deploy/diagnostics/types";
import { AlertOctagon, AlertTriangle, RefreshCw } from "lucide-react";
import { useRouter } from "next/router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isServiceFix, ServiceFixButton } from "./service-fix-button";
import {
	type ServiceType,
	useRefreshServiceDiagnosis,
	useServiceDiagnosis,
} from "./use-service-diagnosis";

const NOUN: Record<ServiceType, string> = {
	compose: "stack",
	postgres: "database",
	mysql: "database",
	mariadb: "database",
	mongo: "database",
	redis: "database",
};

/** Above the tabs of a compose stack or database that is down or degraded. */
export const ServiceHealthBanner = ({
	serviceType,
	serviceId,
}: {
	serviceType: ServiceType;
	serviceId: string;
}) => {
	const router = useRouter();
	const { data, isFetching } = useServiceDiagnosis(serviceType, serviceId);
	const refresh = useRefreshServiceDiagnosis(serviceType, serviceId);
	if (!data || (data.verdict !== "down" && data.verdict !== "degraded"))
		return null;

	const cause =
		pickRootCause(data.findings as Finding[]) ??
		(data.findings[0] as Finding | undefined);
	if (!cause) return null;
	const down = data.verdict === "down";
	const action = cause.recommendedFix.action;
	const noun = NOUN[serviceType];
	const openTab = (tab: string) =>
		router.push({
			pathname: router.pathname,
			query: { ...router.query, tab },
		});

	return (
		<div
			role="alert"
			className={cn(
				"flex items-start gap-3 rounded-lg border p-4",
				down
					? "border-red-500/40 bg-red-500/10"
					: "border-orange-500/40 bg-orange-500/10",
			)}
		>
			{down ? (
				<AlertOctagon className="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400" />
			) : (
				<AlertTriangle className="mt-0.5 size-5 shrink-0 text-orange-600 dark:text-orange-400" />
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<span
					className={cn(
						"flex flex-wrap items-center gap-2 text-sm font-medium",
						down
							? "text-red-700 dark:text-red-300"
							: "text-orange-700 dark:text-orange-300",
					)}
				>
					{down ? `This ${noun} is down` : `This ${noun} has problems`}
					{" · "}
					{cause.title}
					{cause.service && <Badge variant="outline">{cause.service}</Badge>}
				</span>
				<span className="text-sm text-muted-foreground">
					{cause.probableCause}
				</span>
				<div className="mt-2 flex flex-wrap gap-2">
					{cause.autoFixable && action && isServiceFix(action) && (
						<ServiceFixButton
							serviceType={serviceType}
							serviceId={serviceId}
							action={action}
							risk={cause.risk}
							stopped={cause.code === "SERVICE_STOPPED"}
						/>
					)}
					{action?.kind === "set_environment_variables" && (
						<Button size="sm" onClick={() => openTab("environment")}>
							Set {action.keys.join(", ")}
						</Button>
					)}
					<Button
						size="sm"
						variant="outline"
						onClick={() => openTab("smart-deploy")}
					>
						View diagnosis
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() => void refresh()}
						disabled={isFetching}
						aria-label="Check again"
					>
						<RefreshCw className={cn("size-4", isFetching && "animate-spin")} />
					</Button>
				</div>
			</div>
		</div>
	);
};
