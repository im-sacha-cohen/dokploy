import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	Circle,
	FileText,
	Loader2,
	MinusCircle,
	Wrench,
	XCircle,
} from "lucide-react";
import { useRouter } from "next/router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, type RouterOutputs } from "@/utils/api";
import { ShowDeployment } from "../deployments/show-deployment";
import {
	ConfidenceBadge,
	SeverityBadge,
	shortImage,
	shortSha,
	VerificationBadge,
} from "./badges";

type Application = NonNullable<RouterOutputs["application"]["one"]>;
type Preflight = RouterOutputs["smartDeploy"]["preflight"];
type Finding =
	RouterOutputs["smartDeploy"]["diagnoseApplication"]["findings"][number];

const Field = ({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) => (
	<div className="flex flex-col gap-1 rounded-lg border p-3">
		<span className="text-xs uppercase tracking-wide text-muted-foreground">
			{label}
		</span>
		<div className="text-sm font-medium break-all">{children}</div>
	</div>
);

const useOpenTab = () => {
	const router = useRouter();
	return (tab: string) =>
		router.push({ pathname: router.pathname, query: { ...router.query, tab } });
};

export const SourceStep = ({ application }: { application: Application }) => {
	const openTab = useOpenTab();
	const { data: version } = api.smartDeploy.getVersionStatus.useQuery(
		{ applicationId: application.applicationId, checkRemote: false },
		{ refetchOnWindowFocus: false },
	);
	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-3 md:grid-cols-3">
				<Field label="Source">{application.sourceType}</Field>
				<Field label="Repository">{version?.source.repository ?? "—"}</Field>
				<Field label="Branch">{version?.source.branch ?? "—"}</Field>
			</div>
			<p className="text-sm text-muted-foreground">
				The source is edited in the General tab; this step only shows what will
				be used.
			</p>
			<div>
				<Button variant="outline" onClick={() => openTab("general")}>
					Edit source
				</Button>
			</div>
		</div>
	);
};

export const ConfigurationStep = ({
	application,
}: {
	application: Application;
}) => {
	const openTab = useOpenTab();
	const envNames = (application.env ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && line.includes("="))
		.map((line) => line.slice(0, line.indexOf("=")));
	return (
		<div className="flex flex-col gap-4">
			<div className="grid gap-3 md:grid-cols-3">
				<Field label="Build type">{application.buildType}</Field>
				{application.buildType === "dockerfile" && (
					<Field label="Dockerfile">
						{application.dockerfile || "Dockerfile"}
					</Field>
				)}
				<Field label="Domains">
					{application.domains.length === 0
						? "None"
						: application.domains.map((d) => (
								<div key={d.domainId}>
									{d.host} → port {d.port ?? "?"}
								</div>
							))}
				</Field>
				<Field label="Environment variables">
					{envNames.length === 0 ? "None" : envNames.join(", ")}
				</Field>
				<Field label="Swarm healthcheck">
					{application.healthCheckSwarm?.Test?.length
						? "Configured"
						: "Not configured"}
				</Field>
				<Field label="Replicas">{application.replicas}</Field>
			</div>
			<p className="text-sm text-muted-foreground">
				Values are never shown, only variable names.
			</p>
			<div className="flex flex-wrap gap-2">
				<Button variant="outline" onClick={() => openTab("environment")}>
					Edit environment
				</Button>
				<Button variant="outline" onClick={() => openTab("domains")}>
					Edit domains
				</Button>
				<Button variant="outline" onClick={() => openTab("advanced")}>
					Advanced settings
				</Button>
			</div>
		</div>
	);
};

export const PreflightStep = ({
	report,
	isRunning,
	onRun,
}: {
	report: Preflight | null;
	isRunning: boolean;
	onRun: () => void;
}) => {
	if (!report) {
		return (
			<div className="flex flex-col items-start gap-3">
				<p className="text-sm text-muted-foreground">
					Clones the configured branch into a temporary directory, reads the
					manifest files and searches the code. Nothing is built or executed;
					the copy is deleted right after.
				</p>
				<Button onClick={onRun} isLoading={isRunning}>
					Run preflight analysis
				</Button>
			</div>
		);
	}
	const detections: [
		string,
		{ value: unknown; confidence: string; evidence: string[] } | null,
	][] = [
		["Language", report.language],
		["Framework", report.framework],
		["Package manager", report.packageManager],
		["Build command", report.buildCommand],
		["Start command", report.startCommand],
		["Healthcheck", report.healthcheck],
	];
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
				Commit analysed:{" "}
				<code>{shortSha(report.source.commitSha) ?? "unknown"}</code> · path{" "}
				<code>{report.source.buildPath}</code> · {report.durationMs} ms
				<Button variant="ghost" size="sm" onClick={onRun} isLoading={isRunning}>
					Run again
				</Button>
			</div>
			{report.error && <AlertBlock type="warning">{report.error}</AlertBlock>}
			<div className="grid gap-3 md:grid-cols-3">
				{detections.map(([label, d]) => (
					<Field key={label} label={label}>
						{d ? (
							<div className="flex flex-col gap-1">
								<span>{String(d.value)}</span>
								<div className="flex flex-wrap items-center gap-1">
									<ConfidenceBadge confidence={d.confidence} />
									<span className="text-xs font-normal text-muted-foreground">
										{d.evidence.join(" · ")}
									</span>
								</div>
							</div>
						) : (
							<span className="text-muted-foreground">Not detected</span>
						)}
					</Field>
				))}
				<Field label="Dockerfile">
					{report.dockerfile
						? `${report.dockerfile.value.path} · EXPOSE ${report.dockerfile.value.exposedPorts.join(", ") || "none"}`
						: "None"}
				</Field>
				<Field label="Docker Compose">
					{report.compose
						? `${report.compose.value.file} (${report.compose.value.services.join(", ")})`
						: "None"}
				</Field>
				<Field label="Expected ports">
					{report.ports.length === 0
						? "Not detected"
						: report.ports.map((p) => (
								<div key={p.port} className="flex items-center gap-1">
									{p.port} <ConfidenceBadge confidence={p.confidence} />
									<span className="text-xs font-normal text-muted-foreground">
										{p.evidence}
									</span>
								</div>
							))}
				</Field>
				<Field label="Environment variables">
					<div className="flex flex-col gap-1 font-normal">
						<span>
							Referenced in code:{" "}
							{report.envVars.referenced.join(", ") || "none"}
						</span>
						<span>
							Documented (.env.example):{" "}
							{report.envVars.documented.join(", ") || "none"}
						</span>
						<span>
							Missing from configuration:{" "}
							<strong>{report.envVars.missing.join(", ") || "none"}</strong>
						</span>
					</div>
				</Field>
			</div>
			<div className="flex flex-col gap-2">
				<span className="text-sm font-medium">Checks</span>
				{report.checks.length === 0 && (
					<AlertBlock type="success">
						No issue detected before deployment.
					</AlertBlock>
				)}
				{report.checks.map((check) => (
					<div
						key={`${check.code}-${check.title}`}
						className="rounded-lg border p-3"
					>
						<div className="flex flex-wrap items-center gap-2">
							<SeverityBadge severity={check.severity} />
							<ConfidenceBadge confidence={check.confidence} />
							<span className="text-sm font-medium">{check.title}</span>
							<code className="text-xs text-muted-foreground">
								{check.code}
							</code>
						</div>
						<p className="mt-1 text-sm text-muted-foreground">{check.detail}</p>
						<p className="mt-1 text-sm">→ {check.recommendation}</p>
					</div>
				))}
			</div>
		</div>
	);
};

const STATE_ICON = {
	done: <CheckCircle2 className="size-5 text-emerald-500" />,
	failed: <XCircle className="size-5 text-red-500" />,
	running: <Loader2 className="size-5 animate-spin text-primary" />,
	pending: <Circle className="size-5 text-muted-foreground" />,
	skipped: <MinusCircle className="size-5 text-muted-foreground" />,
};

export const TimelineStep = ({
	deploymentId,
	serverId,
	onSettled,
}: {
	deploymentId: string | null;
	serverId?: string;
	onSettled: () => void;
}) => {
	const [showLogs, setShowLogs] = useState(false);
	const { data } = api.smartDeploy.getDeploymentTimeline.useQuery(
		{ deploymentId: deploymentId ?? "" },
		{
			enabled: !!deploymentId,
			refetchInterval: (query) => (query.state.data?.settled ? false : 2000),
		},
	);
	const settled = !!data?.settled;
	// biome-ignore lint/correctness/useExhaustiveDependencies: notify once per settle transition
	useEffect(() => {
		if (settled) onSettled();
	}, [settled]);
	if (!deploymentId) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" /> Waiting for the deployment
				to start…
			</div>
		);
	}
	if (!data) return <Loader2 className="size-4 animate-spin" />;
	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-2 text-sm">
				<span className="font-medium">{data.title}</span>
				<VerificationBadge status={data.verificationStatus} />
				{data.builtCommitSha && <code>{shortSha(data.builtCommitSha)}</code>}
				{data.imageId && <code>{shortImage(data.imageId)}</code>}
				<Button variant="outline" size="sm" onClick={() => setShowLogs(true)}>
					<FileText className="size-4" /> Build logs
				</Button>
			</div>
			<ol className="flex flex-col gap-3">
				{data.events.map((event) => (
					<li key={event.key} className="flex items-start gap-3">
						{STATE_ICON[event.state]}
						<div className="flex flex-col">
							<span className="text-sm font-medium">{event.label}</span>
							<span className="text-xs text-muted-foreground">
								{event.at ? new Date(event.at).toLocaleTimeString() : ""}
								{event.detail ? ` ${event.detail}` : ""}
							</span>
						</div>
					</li>
				))}
			</ol>
			{!data.settled && (
				<p className="text-xs text-muted-foreground">
					Every step is observed on the server (Swarm tasks, healthcheck,
					Traefik); this page updates every 2 seconds.
				</p>
			)}
			<ShowDeployment
				open={showLogs}
				onClose={() => setShowLogs(false)}
				logPath={data.logPath}
				serverId={serverId}
			/>
		</div>
	);
};

const FIX_DESCRIPTION = (finding: Finding) => {
	const action = finding.recommendedFix.action;
	if (!action) return finding.recommendedFix.summary;
	switch (action.kind) {
		case "update_domain_port":
			return `Change the target port of ${action.host} to ${action.port}, then regenerate its Traefik route. Risk: ${finding.risk}. Reversible from the Domains tab.`;
		case "deploy_latest":
			return `Fetch, build and deploy the latest commit of the branch. Risk: ${finding.risk}.`;
		case "redeploy_deployment":
			return `Run again the image of deployment ${action.deploymentId} without rebuilding. Risk: ${finding.risk}.`;
		default:
			return finding.recommendedFix.summary;
	}
};

const FindingCard = ({
	finding,
	applicationId,
	canFix,
	onFixed,
}: {
	finding: Finding;
	applicationId: string;
	canFix: boolean;
	onFixed: () => void;
}) => {
	const [open, setOpen] = useState(finding.severity === "critical");
	const openTab = useOpenTab();
	const applyFix = api.smartDeploy.applyFix.useMutation();
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
				<span className="text-sm font-medium">{finding.title}</span>
				<code className="text-xs text-muted-foreground">{finding.code}</code>
				{finding.causedBy && (
					<Badge variant="outline">
						caused by {finding.causedBy.join(", ")}
					</Badge>
				)}
				<ChevronDown
					className={`ml-auto size-4 transition ${open ? "rotate-180" : ""}`}
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
					<div className="flex flex-wrap gap-2">
						{finding.autoFixable &&
							action &&
							action.kind !== "set_environment_variables" &&
							action.kind !== "redeploy_service" &&
							canFix && (
								<DialogAction
									type="default"
									title="Apply this fix?"
									description={FIX_DESCRIPTION(finding)}
									onClick={async () => {
										await applyFix
											.mutateAsync({ applicationId, action })
											.then(() => {
												toast.success("Fix applied");
												onFixed();
											})
											.catch((e) => toast.error(e.message));
									}}
								>
									<Button size="sm" isLoading={applyFix.isPending}>
										<Wrench className="size-4" /> Apply fix
									</Button>
								</DialogAction>
							)}
						{action?.kind === "set_environment_variables" && (
							<Button
								size="sm"
								variant="outline"
								onClick={() => openTab("environment")}
							>
								Open Environment ({action.keys.join(", ")})
							</Button>
						)}
					</div>
				</div>
			)}
		</div>
	);
};

export const ResultStep = ({
	applicationId,
	canFix,
	onFixed,
}: {
	applicationId: string;
	canFix: boolean;
	onFixed: () => void;
}) => {
	const { data, isFetching, refetch, error } =
		api.smartDeploy.diagnoseApplication.useQuery(
			{ applicationId },
			{ refetchOnWindowFocus: false },
		);
	if (error) return <AlertBlock type="error">{error.message}</AlertBlock>;
	if (!data) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="size-4 animate-spin" /> Diagnosing (Docker, sockets,
				Traefik)…
			</div>
		);
	}
	const verdictBlock = {
		healthy: (
			<AlertBlock type="success">
				The application is running and reachable.
			</AlertBlock>
		),
		degraded: (
			<AlertBlock type="warning">
				The application runs, but with problems.
			</AlertBlock>
		),
		down: (
			<AlertBlock type="error">
				The application does not serve traffic.
			</AlertBlock>
		),
		stopped: <AlertBlock type="info">The application is stopped.</AlertBlock>,
		unknown: (
			<AlertBlock type="info">
				Not enough facts to conclude (see what could not be checked below).
			</AlertBlock>
		),
	}[data.verdict];
	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center gap-2">
				<div className="flex-1">{verdictBlock}</div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => refetch()}
					isLoading={isFetching}
				>
					Diagnose again
				</Button>
			</div>
			{data.findings.map((finding) => (
				<FindingCard
					key={`${finding.code}-${finding.title}`}
					finding={finding}
					applicationId={applicationId}
					canFix={canFix}
					onFixed={() => {
						onFixed();
						void refetch();
					}}
				/>
			))}
			{data.collectionErrors.length > 0 && (
				<div className="flex flex-col gap-1 text-xs text-muted-foreground">
					<span className="flex items-center gap-1 font-medium">
						<AlertTriangle className="size-3" /> Not checked
					</span>
					{data.collectionErrors.map((e, i) => (
						<span key={`${e.source}-${i}`}>
							{e.source}: {e.message}
						</span>
					))}
				</div>
			)}
		</div>
	);
};
