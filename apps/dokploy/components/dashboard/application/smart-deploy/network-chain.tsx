import {
	buildNetworkChains,
	type ChainHop,
	type HopState,
} from "@dokploy/server/smart-deploy/diagnostics/presentation";
import type { DiagnosticReport } from "@dokploy/server/smart-deploy/diagnostics/types";
import {
	ArrowRight,
	Check,
	CircleHelp,
	Info,
	Network,
	RefreshCw,
	X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ApplyFixButton } from "./apply-fix-button";
import { useDiagnosis, useRefreshDiagnosis } from "./use-diagnosis";

const HOP_STYLE: Record<HopState, string> = {
	ok: "border-emerald-500/40 bg-emerald-500/10",
	broken: "border-red-500/50 bg-red-500/10",
	unknown: "border-dashed",
	not_applicable: "",
};

const HOP_TEXT: Record<HopState, string> = {
	ok: "text-emerald-700 dark:text-emerald-300",
	broken: "text-red-700 dark:text-red-300",
	unknown: "text-muted-foreground",
	not_applicable: "",
};

const HopIcon = ({ state }: { state: HopState }) => {
	if (state === "ok") return <Check className="size-3.5" />;
	if (state === "broken") return <X className="size-3.5" />;
	if (state === "unknown") return <CircleHelp className="size-3.5" />;
	return null;
};

const Hop = ({ hop }: { hop: ChainHop }) => (
	<div
		className={cn(
			"flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border p-3",
			HOP_STYLE[hop.state],
		)}
	>
		<span
			className={cn(
				"flex items-center gap-1 text-xs",
				HOP_TEXT[hop.state] || "text-muted-foreground",
			)}
		>
			<HopIcon state={hop.state} /> {hop.label}
		</span>
		<span
			className={cn(
				"truncate font-medium",
				hop.key === "domainPort" || hop.key === "container"
					? "text-xl"
					: "text-sm",
				HOP_TEXT[hop.state],
			)}
			title={hop.value}
		>
			{hop.value}
		</span>
		<span className="text-xs text-muted-foreground" title={hop.detail}>
			{hop.detail}
		</span>
	</div>
);

const ago = (iso: string) => {
	const seconds = Math.max(
		0,
		Math.round((Date.now() - new Date(iso).getTime()) / 1000),
	);
	return seconds < 60
		? `${seconds}s ago`
		: `${Math.round(seconds / 60)} min ago`;
};

/** Domain → Traefik → routed port → container, each hop checked for real. */
export const NetworkChain = ({ applicationId }: { applicationId: string }) => {
	const { data, isFetching } = useDiagnosis(applicationId);
	const refresh = useRefreshDiagnosis(applicationId);
	const report = data as DiagnosticReport | undefined;
	const chains = report ? buildNetworkChains(report) : [];

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<CardTitle className="flex items-center gap-2 text-xl">
						<Network className="size-5" /> Network path
					</CardTitle>
					<CardDescription>
						Where requests go, hop by hop. Checked from inside the Traefik
						container and the app container
						{report ? ` · ${ago(report.generatedAt)}` : ""}.
					</CardDescription>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => void refresh()}
					disabled={isFetching}
				>
					<RefreshCw className={cn("size-4", isFetching && "animate-spin")} />{" "}
					Check again
				</Button>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{!report && (
					<p className="text-sm text-muted-foreground">Checking ports…</p>
				)}
				{report && chains.length === 0 && (
					<p className="text-sm text-muted-foreground">
						No domain: the application is not exposed through Traefik.
					</p>
				)}
				{chains.map((chain) => (
					<div key={chain.domain.domainId} className="flex flex-col gap-2">
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:flex xl:flex-row xl:items-center">
							{chain.hops.map((hop, index) => (
								<div
									key={hop.key}
									className="flex min-w-0 flex-1 items-center gap-2"
								>
									{index > 0 && (
										<ArrowRight className="hidden size-4 shrink-0 text-muted-foreground xl:block" />
									)}
									<Hop hop={hop} />
								</div>
							))}
						</div>
						{chain.fix && (
							<div className="flex flex-wrap items-center gap-2 text-sm">
								<span className="text-red-700 dark:text-red-300">
									{chain.domain.host} sends traffic to port {chain.domain.port};
									the app listens on {chain.fix.port}.
								</span>
								<ApplyFixButton
									applicationId={applicationId}
									action={chain.fix}
									risk="low"
								/>
							</div>
						)}
					</div>
				))}
				{report && (
					<p className="flex items-center gap-1.5 text-xs text-muted-foreground">
						<Info className="size-3.5" />
						{report.facts.publishedPorts.length === 0
							? "No port published on the host: traffic only goes through Traefik."
							: `Published on the host: ${report.facts.publishedPorts
									.map(
										(p) => `${p.publishedPort} → ${p.targetPort}/${p.protocol}`,
									)
									.join(", ")}.`}
					</p>
				)}
			</CardContent>
		</Card>
	);
};
