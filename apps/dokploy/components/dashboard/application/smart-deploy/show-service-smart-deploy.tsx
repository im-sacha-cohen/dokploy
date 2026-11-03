import { buildNetworkChains } from "@dokploy/server/smart-deploy/diagnostics/presentation";
import type {
	DiagnosticReport,
	Finding,
} from "@dokploy/server/smart-deploy/diagnostics/types";
import {
	ChevronDown,
	Database,
	Network,
	RefreshCw,
	Stethoscope,
} from "lucide-react";
import { useRouter } from "next/router";
import { useState } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
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
import { ConfidenceBadge, LiveStatusBadge, SeverityBadge } from "./badges";
import { ago, ChainHops } from "./network-chain";
import { isServiceFix, ServiceFixButton } from "./service-fix-button";
import {
	type ServiceType,
	useRefreshServiceDiagnosis,
	useServiceDiagnosis,
} from "./use-service-diagnosis";

const VERDICT_TEXT: Record<
	string,
	{ type: "success" | "warning" | "error" | "info"; text: string }
> = {
	healthy: { type: "success", text: "Everything checked is running." },
	degraded: { type: "warning", text: "It runs, but with problems." },
	down: { type: "error", text: "It does not run." },
	stopped: { type: "info", text: "It is stopped." },
	unknown: {
		type: "info",
		text: "Not enough facts to conclude (see what could not be checked below).",
	},
};

const FindingCard = ({
	finding,
	serviceType,
	serviceId,
}: {
	finding: Finding;
	serviceType: ServiceType;
	serviceId: string;
}) => {
	const router = useRouter();
	const [open, setOpen] = useState(
		finding.severity === "critical" && !finding.causedBy,
	);
	const action = finding.recommendedFix.action;
	return (
		<div className="rounded-lg border p-3">
			<button
				type="button"
				className="flex w-full flex-wrap items-center gap-2 text-left"
				onClick={() => setOpen(!open)}
			>
				<SeverityBadge severity={finding.severity} />
				<ConfidenceBadge confidence={finding.confidence} />
				{finding.service && (
					<Badge variant="secondary">{finding.service}</Badge>
				)}
				<span className="text-sm font-medium">{finding.title}</span>
				<code className="text-xs text-muted-foreground">{finding.code}</code>
				{finding.causedBy && (
					<Badge variant="outline">
						caused by {finding.causedBy.join(", ")}
					</Badge>
				)}
				<ChevronDown
					className={cn("ml-auto size-4 transition", open && "rotate-180")}
				/>
			</button>
			{open && (
				<div className="mt-3 flex flex-col gap-2 text-sm">
					<p className="text-muted-foreground">{finding.description}</p>
					<div>
						<span className="font-medium">Evidence</span>
						<ul className="mt-1 list-disc pl-5 text-muted-foreground">
							{finding.evidence.map((e, i) => (
								<li key={`${e.source}-${i}`}>
									<code className="text-xs">{e.source}</code> {e.summary}
									{e.excerpt && e.excerpt.length > 0 && (
										<pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
											{e.excerpt.join("\n")}
										</pre>
									)}
								</li>
							))}
						</ul>
					</div>
					<p>
						<span className="font-medium">Probable cause: </span>
						{finding.probableCause}
					</p>
					<p>
						<span className="font-medium">Recommended fix: </span>
						{finding.recommendedFix.summary}
					</p>
					{finding.recommendedFix.steps && (
						<ol className="list-decimal pl-5 text-muted-foreground">
							{finding.recommendedFix.steps.map((step) => (
								<li key={step}>{step}</li>
							))}
						</ol>
					)}
					<div className="flex flex-wrap gap-2">
						{finding.autoFixable && action && isServiceFix(action) && (
							<ServiceFixButton
								serviceType={serviceType}
								serviceId={serviceId}
								action={action}
								risk={finding.risk}
								stopped={finding.code === "SERVICE_STOPPED"}
							/>
						)}
						{action?.kind === "set_environment_variables" && (
							<Button
								size="sm"
								variant="outline"
								onClick={() =>
									router.push({
										pathname: router.pathname,
										query: { ...router.query, tab: "environment" },
									})
								}
							>
								Set {action.keys.join(", ")}
							</Button>
						)}
					</div>
				</div>
			)}
		</div>
	);
};

const ServicesTable = ({ report }: { report: DiagnosticReport }) => (
	<Table>
		<TableHeader>
			<TableRow>
				<TableHead>Service</TableHead>
				<TableHead>Status</TableHead>
				<TableHead>Image</TableHead>
				<TableHead>Restarts</TableHead>
				<TableHead>Health</TableHead>
				<TableHead>Listens on</TableHead>
			</TableRow>
		</TableHeader>
		<TableBody>
			{report.facts.services?.map((s) => (
				<TableRow key={s.name}>
					<TableCell className="font-medium">{s.name}</TableCell>
					<TableCell>
						<LiveStatusBadge verdict={s.verdict} />
					</TableCell>
					<TableCell
						className="max-w-56 truncate text-xs"
						title={s.image ?? ""}
					>
						{s.image ?? "—"}
					</TableCell>
					<TableCell>{s.restartCount ?? "—"}</TableCell>
					<TableCell>
						{s.health && s.health !== "none" ? s.health : "—"}
					</TableCell>
					<TableCell className="text-xs">
						{s.listening
							? s.listening.length
								? [...new Set(s.listening.map((l) => l.port))].join(", ")
								: "nothing"
							: "not measured"}
					</TableCell>
				</TableRow>
			))}
		</TableBody>
	</Table>
);

const DatabaseFacts = ({ report }: { report: DiagnosticReport }) => {
	const db = report.facts.database;
	if (!db) return null;
	const listens = report.facts.listening?.some(
		(l) => l.port === db.defaultPort,
	);
	const published = report.facts.publishedPorts.find(
		(p) => p.targetPort === db.defaultPort,
	);
	const rows: [string, string, boolean | null][] = [
		["Engine", db.engine, null],
		[
			"Image",
			db.runningImage && db.runningImage !== db.configuredImage
				? `${db.configuredImage} configured · ${db.runningImage} running`
				: db.configuredImage,
			db.runningImage ? db.runningImage === db.configuredImage : null,
		],
		[
			"Internal port",
			`${db.defaultPort}${report.facts.listening ? (listens ? " · listening" : " · not listening") : ""}`,
			report.facts.listening ? !!listens : null,
		],
		[
			"External port",
			db.externalPort
				? `${db.externalPort}${published ? " · published" : " · not published"}`
				: "none (reachable only from other services)",
			db.externalPort ? !!published : null,
		],
	];
	return (
		<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
			{rows.map(([label, value, ok]) => (
				<div
					key={label}
					className={cn(
						"rounded-lg border p-3",
						ok === true && "border-emerald-500/40 bg-emerald-500/10",
						ok === false && "border-red-500/50 bg-red-500/10",
					)}
				>
					<div className="text-xs text-muted-foreground">{label}</div>
					<div className="text-sm font-medium break-all">{value}</div>
				</div>
			))}
		</div>
	);
};

/** Smart Deploy tab of a compose stack or a database. */
export const ShowServiceSmartDeploy = ({
	serviceType,
	serviceId,
}: {
	serviceType: ServiceType;
	serviceId: string;
}) => {
	const { data, isFetching, error } = useServiceDiagnosis(
		serviceType,
		serviceId,
	);
	const refresh = useRefreshServiceDiagnosis(serviceType, serviceId);
	const report = data as DiagnosticReport | undefined;
	const chains = report ? buildNetworkChains(report) : [];
	const verdict = report ? VERDICT_TEXT[report.verdict] : undefined;

	return (
		<div className="flex flex-col gap-4">
			<Card className="bg-background">
				<CardHeader className="flex flex-row items-start justify-between gap-4">
					<div className="space-y-1">
						<CardTitle className="flex items-center gap-2 text-xl">
							<Stethoscope className="size-5" /> Smart Deploy
							{report && <LiveStatusBadge verdict={report.verdict} />}
						</CardTitle>
						<CardDescription>
							Diagnosis from Docker, the logs and Traefik
							{report ? ` · ${ago(report.generatedAt)}` : ""}. Read-only: fixes
							are applied only when you confirm them.
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
					{error && <AlertBlock type="error">{error.message}</AlertBlock>}
					{!report && !error && (
						<p className="text-sm text-muted-foreground">Diagnosing…</p>
					)}
					{verdict && (
						<AlertBlock type={verdict.type}>{verdict.text}</AlertBlock>
					)}
					{report?.findings.map((finding, i) => (
						<FindingCard
							key={`${finding.code}-${finding.service ?? ""}-${i}`}
							finding={finding as Finding}
							serviceType={serviceType}
							serviceId={serviceId}
						/>
					))}
					{report && report.collectionErrors.length > 0 && (
						<details className="text-xs text-muted-foreground">
							<summary>
								{report.collectionErrors.length} check(s) could not run
							</summary>
							<ul className="mt-1 list-disc pl-5">
								{report.collectionErrors.map((e, i) => (
									<li key={`${e.source}-${i}`}>
										<code>{e.source}</code> {e.message}
									</li>
								))}
							</ul>
						</details>
					)}
				</CardContent>
			</Card>

			{report?.facts.database && (
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-xl">
							<Database className="size-5" /> Database
						</CardTitle>
					</CardHeader>
					<CardContent>
						<DatabaseFacts report={report} />
					</CardContent>
				</Card>
			)}

			{report?.facts.services && (
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="text-xl">Services</CardTitle>
						<CardDescription>
							Each service of the stack, checked on its own.
						</CardDescription>
					</CardHeader>
					<CardContent>
						{report.facts.services.length ? (
							<ServicesTable report={report} />
						) : (
							<p className="text-sm text-muted-foreground">
								No container found for this stack: it has not been deployed yet.
							</p>
						)}
					</CardContent>
				</Card>
			)}

			{chains.length > 0 && (
				<Card className="bg-background">
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-xl">
							<Network className="size-5" /> Network path
						</CardTitle>
						<CardDescription>
							Domain → Traefik → port → the service's container.
						</CardDescription>
					</CardHeader>
					<CardContent className="flex flex-col gap-4">
						{chains.map((chain) => (
							<div key={chain.domain.domainId} className="flex flex-col gap-2">
								<span className="text-xs text-muted-foreground">
									{chain.domain.host} → service{" "}
									<code>{chain.domain.serviceName}</code>
								</span>
								<ChainHops hops={chain.hops} />
								{chain.fix && (
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<span className="text-red-700 dark:text-red-300">
											{chain.domain.host} sends traffic to port{" "}
											{chain.domain.port}; the service listens on{" "}
											{chain.fix.port}.
										</span>
										<ServiceFixButton
											serviceType={serviceType}
											serviceId={serviceId}
											action={chain.fix}
											risk="low"
										/>
									</div>
								)}
							</div>
						))}
					</CardContent>
				</Card>
			)}
		</div>
	);
};
