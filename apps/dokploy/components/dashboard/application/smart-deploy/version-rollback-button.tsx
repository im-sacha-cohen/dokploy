import { Undo2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { shortImage, shortSha } from "./badges";

interface Props {
	type: "application" | "compose";
	serviceId: string;
	deploymentId: string;
}

// Every row of the Deployments tab renders one; react-query shares a single
// status request between them.
const STATUS_OPTIONS = { refetchOnWindowFocus: false, refetchInterval: 5000 };

/**
 * "Roll back" / "Redeploy" on a row of the Deployments tab, for a deployment
 * whose image(s) are retained and that is not the running version.
 */
export const VersionRollbackButton = ({
	type,
	serviceId,
	deploymentId,
}: Props) => {
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const app = api.smartDeploy.getVersionStatus.useQuery(
		{ applicationId: serviceId, checkRemote: false },
		{ ...STATUS_OPTIONS, enabled: type === "application" },
	);
	const compose = api.smartDeploy.getComposeVersions.useQuery(
		{ composeId: serviceId },
		{ ...STATUS_OPTIONS, enabled: type === "compose" },
	);
	const redeployApp = api.smartDeploy.redeployVersion.useMutation();
	const redeployCompose = api.smartDeploy.redeployComposeVersion.useMutation();

	if (!permissions?.deployment.create) return null;

	let target: {
		older: boolean;
		description: string;
		run: () => Promise<unknown>;
	} | null = null;

	if (type === "application" && app.data) {
		const row = app.data.history.find((d) => d.deploymentId === deploymentId);
		const current = app.data.current;
		const running = app.data.live.runningImageId;
		if (
			row?.redeployable &&
			row.deploymentId !== current?.deploymentId &&
			row.imageId !== running
		) {
			const history = app.data.history;
			// A rollback row carries an old image: date it by the build it reran.
			const versionAt = (d: (typeof history)[number]) => {
				let origin = d;
				for (let hop = 0; hop < 20 && origin.sourceDeploymentId; hop++) {
					const next = history.find(
						(h) => h.deploymentId === origin.sourceDeploymentId,
					);
					if (!next) break;
					origin = next;
				}
				return origin.createdAt;
			};
			target = {
				older: !!current && versionAt(row) < versionAt(current),
				description: `Runs again the exact image ${shortImage(row.imageId)} (commit ${shortSha(row.builtCommitSha) ?? "unknown"}) with the current settings. No fetch, no build.`,
				run: () => redeployApp.mutateAsync({ deploymentId }),
			};
		}
	}
	if (type === "compose" && compose.data) {
		const row = compose.data.history.find(
			(d) => d.deploymentId === deploymentId,
		);
		const current = compose.data.history.find(
			(d) => d.deploymentId === compose.data.currentDeploymentId,
		);
		if (row?.redeployable && row.deploymentId !== current?.deploymentId) {
			target = {
				older: !!current && row.versionCreatedAt < current.versionCreatedAt,
				description: `Runs again the exact images of this deployment (${row.services.map((s) => s.service).join(", ")}) with its compose file and today's domains and environment variables. Nothing is fetched, pulled or built. Volumes are kept as they are.`,
				run: () => redeployCompose.mutateAsync({ deploymentId }),
			};
		}
	}
	if (!target) return null;
	const { older, description, run } = target;

	return (
		<DialogAction
			type="default"
			title={older ? "Roll back to this version?" : "Redeploy this version?"}
			description={description}
			onClick={async () => {
				await run()
					.then(async () => {
						toast.success(older ? "Rollback queued" : "Redeploy queued");
						await utils.smartDeploy.getVersionStatus.invalidate();
						await utils.smartDeploy.getComposeVersions.invalidate();
					})
					.catch((e) => toast.error(e.message));
			}}
		>
			<Button
				variant="secondary"
				size="sm"
				className="w-full sm:w-auto"
				isLoading={redeployApp.isPending || redeployCompose.isPending}
			>
				<Undo2 className="size-4" />
				{older ? "Roll back" : "Redeploy"}
			</Button>
		</DialogAction>
	);
};
