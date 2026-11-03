import { pickRootCause } from "@dokploy/server/smart-deploy/diagnostics/presentation";
import type { Finding } from "@dokploy/server/smart-deploy/diagnostics/types";
import { AlertOctagon, AlertTriangle, RefreshCw } from "lucide-react";
import { useRouter } from "next/router";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ApplyFixButton } from "./apply-fix-button";
import { useDiagnosis, useRefreshDiagnosis } from "./use-diagnosis";

/**
 * Shown above the tabs of an application when it does not serve traffic or is
 * unhealthy: one sentence for the root cause and one primary action.
 */
export const HealthBanner = ({ applicationId }: { applicationId: string }) => {
	const router = useRouter();
	const { data, isFetching } = useDiagnosis(applicationId);
	const refresh = useRefreshDiagnosis(applicationId);
	if (!data || (data.verdict !== "down" && data.verdict !== "degraded"))
		return null;

	const cause =
		pickRootCause(data.findings as Finding[]) ??
		(data.findings[0] as Finding | undefined);
	if (!cause) return null;
	const down = data.verdict === "down";
	const action = cause.recommendedFix.action;
	const openTab = (tab: string, extra: Record<string, string> = {}) =>
		router.push({
			pathname: router.pathname,
			query: { ...router.query, tab, ...extra },
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
						"text-sm font-medium",
						down
							? "text-red-700 dark:text-red-300"
							: "text-orange-700 dark:text-orange-300",
					)}
				>
					{down
						? "This application is not serving traffic"
						: "This application has problems"}
					{" · "}
					{cause.title}
				</span>
				<span className="text-sm text-muted-foreground">
					{cause.probableCause}
				</span>
				<div className="mt-2 flex flex-wrap gap-2">
					{cause.autoFixable &&
						action &&
						action.kind !== "set_environment_variables" &&
						action.kind !== "redeploy_service" && (
							<ApplyFixButton
								applicationId={applicationId}
								action={action}
								risk={cause.risk}
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
						onClick={() => openTab("smart-deploy", { step: "result" })}
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
