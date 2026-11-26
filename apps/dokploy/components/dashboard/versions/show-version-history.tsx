import {
	ArrowRight,
	ChevronDown,
	ExternalLink,
	GitCommitHorizontal,
	History,
	Loader2,
	Package,
	RefreshCw,
	Rocket,
	Tag,
} from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { VersionRollbackButton } from "@/components/dashboard/application/smart-deploy/version-rollback-button";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
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
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { api, type RouterOutputs } from "@/utils/api";

type ServiceType = "application" | "compose";
type History = RouterOutputs["smartDeploy"]["getVersionHistory"];
type NewerItem = History["releases"][number];

const formatDate = (date: string | null | undefined) =>
	date
		? new Date(date).toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			})
		: null;

const plural = (count: number, word: string) =>
	`${count} ${word}${count > 1 ? "s" : ""}`;

// The badge, the Deploy line and the tab share one request per service.
const QUERY_OPTIONS = { refetchOnWindowFocus: false, staleTime: 60_000 };

export const useVersionHistory = (
	serviceType: ServiceType,
	serviceId: string,
	enabled = true,
) =>
	api.smartDeploy.getVersionHistory.useQuery(
		{ serviceType, serviceId },
		{ ...QUERY_OPTIONS, enabled: enabled && !!serviceId },
	);

/** "2 newer releases, 5 commits" — what came out after the running version. */
export const describeNewer = (next: History["next"]) => {
	const parts = [
		next.newerReleases > 0 ? plural(next.newerReleases, "newer release") : null,
		next.newerCommits > 0 ? plural(next.newerCommits, "new commit") : null,
		next.newerImages > 0 ? plural(next.newerImages, "newer image tag") : null,
	].filter(Boolean);
	return parts.join(", ");
};

const ChangeBadge = ({ change }: { change: History["next"]["change"] }) =>
	change === "same" ? (
		<Badge variant="outline">Same version</Badge>
	) : change === "newer" ? (
		<Badge variant="orange">Newer version</Badge>
	) : (
		<Badge variant="outline">Unknown</Badge>
	);

/**
 * One line above the Deploy button, and in its confirmation: what runs and
 * what Deploy is about to install. Spans only: it also sits in the dialog's <p>.
 */
export const DeployVersionSummary = ({
	serviceType,
	serviceId,
	className,
}: {
	serviceType: ServiceType;
	serviceId: string;
	className?: string;
}) => {
	const { data, isLoading } = useVersionHistory(serviceType, serviceId);
	if (isLoading) {
		return (
			<span
				className={`block text-sm text-muted-foreground ${className ?? ""}`}
			>
				Checking versions…
			</span>
		);
	}
	if (!data) return null;
	const newer = describeNewer(data.next);
	return (
		<span className={`flex flex-col gap-1 text-sm ${className ?? ""}`}>
			<span className="flex flex-wrap items-center gap-2">
				<span className="text-muted-foreground">Running</span>
				<code className="rounded bg-muted px-1.5 py-0.5">
					{data.current?.label ?? "nothing yet"}
				</code>
				<ArrowRight className="size-3.5 text-muted-foreground" />
				<span className="text-muted-foreground">Deploy installs</span>
				<code className="rounded bg-muted px-1.5 py-0.5">
					{data.next.label}
				</code>
				<ChangeBadge change={data.next.change} />
			</span>
			{(newer || data.next.reason) && (
				<span className="text-muted-foreground">
					{[
						newer ? `Since the running version: ${newer}.` : null,
						data.next.reason,
					]
						.filter(Boolean)
						.join(" ")}
				</span>
			)}
		</span>
	);
};

/** On a service card of the project page: the running version, and whether a newer one is out. */
export const ServiceVersionBadge = ({
	serviceType,
	serviceId,
}: {
	serviceType: ServiceType;
	serviceId: string;
}) => {
	const { data } = useVersionHistory(serviceType, serviceId);
	if (!data?.current) return null;
	// "Update available" only when Deploy installs it; a newer tag that must be
	// picked by hand (another image tag, a compose file edit) is only "out".
	const deployable = data.next.change === "newer";
	const published =
		!deployable && (data.next.newerReleases > 0 || data.next.newerImages > 0);
	const detail = describeNewer(data.next) || data.next.reason || undefined;
	return (
		<div className="flex min-w-0 items-center gap-1.5 text-xs">
			<Tag className="size-3 shrink-0 text-muted-foreground" />
			<span
				className="truncate text-muted-foreground"
				title={data.current.label}
			>
				{data.current.label}
			</span>
			{deployable && (
				<Badge
					variant="orange"
					className="shrink-0 px-1.5 py-0 text-[10px]"
					title={detail}
				>
					Update available
				</Badge>
			)}
			{published && (
				<Badge
					variant="outline"
					className="shrink-0 px-1.5 py-0 text-[10px]"
					title={detail}
				>
					Newer version out
				</Badge>
			)}
		</div>
	);
};

const DeployItemButton = ({
	serviceType,
	serviceId,
	item,
}: {
	serviceType: ServiceType;
	serviceId: string;
	item: NewerItem;
}) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const deployApp = api.smartDeploy.deployCommit.useMutation();
	const deployCompose = api.smartDeploy.deployComposeCommit.useMutation();
	const deployTag = api.smartDeploy.deployImageTag.useMutation();
	const deploy = item.deploy;
	if (!deploy || !permissions?.deployment.create) return null;
	if (deploy.kind === "image" && !permissions.service.create) return null;
	const pending =
		deployApp.isPending || deployCompose.isPending || deployTag.isPending;

	const run = async () => {
		try {
			if (deploy.kind === "image") {
				await deployTag.mutateAsync({
					applicationId: serviceId,
					tag: item.label,
				});
			} else if (serviceType === "application") {
				await deployApp.mutateAsync({
					applicationId: serviceId,
					commitSha: deploy.sha,
				});
			} else {
				await deployCompose.mutateAsync({
					composeId: serviceId,
					commitSha: deploy.sha,
				});
			}
			toast.success("Deployment queued");
			await utils.smartDeploy.getVersionHistory.invalidate({
				serviceType,
				serviceId,
			});
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Deployment failed");
		}
	};

	return (
		<DialogAction
			title={`Deploy ${item.kind === "commit" ? "this commit" : item.label}?`}
			description={
				deploy.kind === "image"
					? `The application's image becomes ${deploy.image}, then it is deployed. The Deployments tab can roll it back.`
					: `Dokploy fetches commit ${deploy.sha.slice(0, 7)}, builds it and deploys it. The next plain Deploy goes back to the head of the branch.`
			}
			onClick={run}
		>
			<Button variant="outline" size="sm" disabled={pending}>
				{pending ? (
					<Loader2 className="size-4 animate-spin" />
				) : (
					<Rocket className="size-4" />
				)}
				Deploy this version
			</Button>
		</DialogAction>
	);
};

const NewerRow = ({
	serviceType,
	serviceId,
	item,
}: {
	serviceType: ServiceType;
	serviceId: string;
	item: NewerItem;
}) => {
	const [open, setOpen] = useState(false);
	const meta = [
		formatDate(item.date),
		item.author,
		item.kind === "commit" && item.sha ? item.sha.slice(0, 7) : null,
	].filter(Boolean);
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<div className="flex flex-col gap-2 rounded-lg border p-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div className="flex min-w-0 flex-col gap-0.5">
						<div className="flex flex-wrap items-center gap-2">
							{item.kind === "commit" ? (
								<GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
							) : (
								<Tag className="size-4 shrink-0 text-muted-foreground" />
							)}
							<span className="font-medium break-all">{item.label}</span>
							{item.prerelease && <Badge variant="outline">Pre-release</Badge>}
						</div>
						{meta.length > 0 && (
							<span className="text-xs text-muted-foreground">
								{meta.join(" · ")}
							</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						{item.url && (
							<Button variant="ghost" size="sm" asChild>
								<a href={item.url} target="_blank" rel="noreferrer noopener">
									<ExternalLink className="size-4" />
								</a>
							</Button>
						)}
						{item.notes && (
							<CollapsibleTrigger asChild>
								<Button variant="ghost" size="sm">
									Notes
									<ChevronDown
										className={`size-4 transition-transform ${open ? "rotate-180" : ""}`}
									/>
								</Button>
							</CollapsibleTrigger>
						)}
						<DeployItemButton
							serviceType={serviceType}
							serviceId={serviceId}
							item={item}
						/>
					</div>
				</div>
				{item.notes && (
					<CollapsibleContent>
						<div className="max-h-96 overflow-auto rounded-md bg-muted/50 p-3 text-sm [&_a]:underline [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1">
							<ReactMarkdown>{item.notes}</ReactMarkdown>
						</div>
					</CollapsibleContent>
				)}
			</div>
		</Collapsible>
	);
};

const Section = ({
	title,
	icon,
	children,
}: {
	title: string;
	icon: React.ReactNode;
	children: React.ReactNode;
}) => (
	<div className="flex flex-col gap-3">
		<h3 className="flex items-center gap-2 text-sm font-medium">
			{icon}
			{title}
		</h3>
		{children}
	</div>
);

/** The Versions tab: what runs, what was published after, what ran before. */
export const ShowVersionHistory = ({
	serviceType,
	serviceId,
}: {
	serviceType: ServiceType;
	serviceId: string;
}) => {
	const utils = api.useUtils();
	const { data, isLoading, error } = useVersionHistory(serviceType, serviceId);
	const [checking, setChecking] = useState(false);

	const checkNow = async () => {
		setChecking(true);
		try {
			const fresh = await utils.smartDeploy.getVersionHistory.fetch({
				serviceType,
				serviceId,
				force: true,
			});
			utils.smartDeploy.getVersionHistory.setData(
				{ serviceType, serviceId },
				fresh,
			);
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Check failed");
		} finally {
			setChecking(false);
		}
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div className="space-y-1">
					<CardTitle className="text-xl">Versions</CardTitle>
					<CardDescription>
						The version that runs, what was published after it and what ran
						before. Git hosts and registries are checked at most every 10
						minutes.
					</CardDescription>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={checkNow}
					disabled={checking || isLoading}
				>
					<RefreshCw className={`size-4 ${checking ? "animate-spin" : ""}`} />
					Check now
				</Button>
			</CardHeader>
			<CardContent className="flex flex-col gap-6">
				{isLoading && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Reading versions…
					</div>
				)}
				{error && <AlertBlock type="error">{error.message}</AlertBlock>}
				{data && (
					<>
						{data.problems.length > 0 && (
							<AlertBlock type="warning">
								<ul className="list-disc pl-4">
									{data.problems.map((p) => (
										<li key={p}>{p}</li>
									))}
								</ul>
							</AlertBlock>
						)}

						<div className="grid gap-4 md:grid-cols-2">
							<div className="flex flex-col gap-1 rounded-lg border p-4">
								<span className="text-xs text-muted-foreground">Running</span>
								<span className="text-lg font-semibold break-all">
									{data.current?.label ?? "Nothing deployed yet"}
								</span>
								{data.current?.detail && (
									<span className="text-sm text-muted-foreground break-all">
										{data.current.detail}
									</span>
								)}
								{data.current?.date && (
									<span className="text-xs text-muted-foreground">
										Since {formatDate(data.current.date)}
									</span>
								)}
							</div>
							<div className="flex flex-col gap-1 rounded-lg border p-4">
								<span className="flex items-center gap-2 text-xs text-muted-foreground">
									Deploy installs <ChangeBadge change={data.next.change} />
								</span>
								<span className="text-lg font-semibold break-all">
									{data.next.label}
								</span>
								{data.next.reason && (
									<span className="text-sm text-muted-foreground">
										{data.next.reason}
									</span>
								)}
							</div>
						</div>

						{data.images.map((image) => (
							<Section
								key={`${image.service ?? "app"}:${image.image}`}
								title={
									image.service
										? `Image of ${image.service}: ${image.image}`
										: `Image ${image.image}`
								}
								icon={<Package className="size-4" />}
							>
								<p className="text-sm text-muted-foreground">
									{image.error
										? `Could not read the registry: ${image.error}`
										: [
												`Tag ${image.label}`,
												image.registryDate
													? `last pushed ${formatDate(image.registryDate)}`
													: null,
												image.rebuilt === true
													? "pushed again since the running image was pulled"
													: image.rebuilt === false
														? "same image as the one running"
														: null,
											]
												.filter(Boolean)
												.join(" · ")}
								</p>
								{image.newer.length > 0 ? (
									<div className="flex flex-col gap-2">
										{image.newer.map((item) => (
											<NewerRow
												key={item.key}
												serviceType={serviceType}
												serviceId={serviceId}
												item={item}
											/>
										))}
										{serviceType === "compose" && (
											<p className="text-xs text-muted-foreground">
												To use a newer tag, change it in the compose file, then
												deploy.
											</p>
										)}
									</div>
								) : (
									!image.error &&
									image.isVersion && (
										<p className="text-sm text-muted-foreground">
											No newer tag written the same way.
										</p>
									)
								)}
							</Section>
						))}

						{data.sourceKind === "git" && (
							<Section
								title={data.releasesSupported ? "Newer releases" : "Newer tags"}
								icon={<Tag className="size-4" />}
							>
								{data.releases.length > 0 ? (
									<div className="flex flex-col gap-2">
										{data.releases.map((item) => (
											<NewerRow
												key={item.key}
												serviceType={serviceType}
												serviceId={serviceId}
												item={item}
											/>
										))}
									</div>
								) : (
									<p className="text-sm text-muted-foreground">
										{data.releasesSupported
											? "No release after the running version."
											: "No tag after the running version. Release notes need a GitHub, GitLab or Gitea source."}
									</p>
								)}
							</Section>
						)}

						{data.sourceKind === "git" && (
							<Section
								title="Newer commits on the branch"
								icon={<GitCommitHorizontal className="size-4" />}
							>
								{data.commits.length > 0 ? (
									<div className="flex flex-col gap-2">
										{data.commits.map((item) => (
											<NewerRow
												key={item.key}
												serviceType={serviceType}
												serviceId={serviceId}
												item={item}
											/>
										))}
										{data.moreCommits && (
											<p className="text-xs text-muted-foreground">
												The running commit is older than the{" "}
												{data.commits.length} commits read: there are more.
											</p>
										)}
									</div>
								) : (
									<p className="text-sm text-muted-foreground">
										The running commit is the head of the branch.
									</p>
								)}
							</Section>
						)}

						<Section title="Before" icon={<History className="size-4" />}>
							{data.past.length > 0 ? (
								<div className="flex flex-col gap-2">
									{data.past.map((p) => (
										<div
											key={p.deploymentId}
											className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
										>
											<div className="flex min-w-0 flex-col gap-0.5">
												<div className="flex flex-wrap items-center gap-2">
													<span className="font-medium break-all">
														{p.label}
													</span>
													{p.current && <Badge variant="green">Running</Badge>}
													{p.status === "error" && (
														<Badge variant="red">Failed</Badge>
													)}
												</div>
												<span className="text-xs text-muted-foreground">
													{new Date(p.createdAt).toLocaleString()}
													{p.detail && p.detail !== p.label
														? ` · ${p.detail}`
														: ""}
												</span>
											</div>
											{!p.current && (
												<VersionRollbackButton
													type={serviceType}
													serviceId={serviceId}
													deploymentId={p.deploymentId}
												/>
											)}
										</div>
									))}
								</div>
							) : (
								<p className="text-sm text-muted-foreground">
									No deployment yet.
								</p>
							)}
						</Section>
					</>
				)}
			</CardContent>
		</Card>
	);
};
