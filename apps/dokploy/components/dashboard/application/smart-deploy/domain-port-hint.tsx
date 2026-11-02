import {
	buildNetworkChains,
	suggestedDomainPort,
} from "@dokploy/server/smart-deploy/diagnostics/presentation";
import type { DiagnosticReport } from "@dokploy/server/smart-deploy/diagnostics/types";
import { Check, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDiagnosis } from "./use-diagnosis";

/** Under the "Container Port" field: the port the app really listens on. */
export const DomainPortHint = ({
	applicationId,
	value,
	onUse,
}: {
	applicationId: string;
	value: number | undefined;
	onUse: (port: number) => void;
}) => {
	const { data, isLoading } = useDiagnosis(applicationId);
	if (isLoading) {
		return (
			<p className="text-xs text-muted-foreground">
				Detecting the port the app listens on…
			</p>
		);
	}
	if (!data) return null;
	const report = data as DiagnosticReport;
	const suggested = suggestedDomainPort(report);
	const measured = report.facts.listening !== null;
	if (suggested === null) {
		return (
			<p className="text-xs text-muted-foreground">
				{measured
					? "Could not tell which port serves HTTP (none or several ports listening)."
					: "The app is not running: listening ports could not be measured."}
			</p>
		);
	}
	const source = measured ? "listens on" : "declares (EXPOSE)";
	if (value === suggested) {
		return (
			<p className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
				<Check className="size-3.5" /> The app {source} {suggested}.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap items-center gap-2 text-xs text-orange-700 dark:text-orange-300">
			<TriangleAlert className="size-3.5" />
			<span>
				The app {source} {suggested}
				{value ? `, not ${value}` : ""}.
			</span>
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => onUse(suggested)}
			>
				Use {suggested}
			</Button>
		</div>
	);
};

/** Small badge on each domain card: does this domain actually reach the app? */
export const DomainReachabilityBadge = ({
	applicationId,
	domainId,
}: {
	applicationId: string;
	domainId: string;
}) => {
	const { data } = useDiagnosis(applicationId);
	if (!data) return null;
	const chain = buildNetworkChains(data as DiagnosticReport).find(
		(c) => c.domain.domainId === domainId,
	);
	if (!chain) return null;
	// Name the cause, not the symptom: a wrong port or a dead container explains
	// the Traefik error that follows from it.
	const broken = ["domainPort", "container", "router"]
		.map((key) => chain.hops.find((h) => h.key === key && h.state === "broken"))
		.find(Boolean);
	if (broken) {
		return (
			<Badge variant="red" title={`${broken.label}: ${broken.detail}`}>
				Unreachable ·{" "}
				{broken.key === "domainPort"
					? "wrong port"
					: broken.key === "container"
						? "app not listening"
						: broken.detail}
			</Badge>
		);
	}
	if (chain.hops.some((h) => h.state === "unknown")) {
		return <Badge variant="outline">Not verified</Badge>;
	}
	return <Badge variant="green">Reachable</Badge>;
};
