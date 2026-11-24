type DeployJob =
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy" | "redeploy-version";
			applicationType: "application";
			serverId?: string;
			/** For "redeploy-version": the deployment whose image is redeployed. */
			sourceDeploymentId?: string;
			/** For "deploy": builds this commit instead of the branch head. */
			commitSha?: string;
	  }
	| {
			composeId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy" | "redeploy-version";
			applicationType: "compose";
			serverId?: string;
			freshVolumes?: boolean;
			/** For "redeploy-version": the deployment whose images are run again. */
			sourceDeploymentId?: string;
			/** For "deploy": deploys this commit instead of the branch head. */
			commitSha?: string;
	  }
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "application-preview";
			previewDeploymentId: string;
			serverId?: string;
	  };

export type DeploymentJob = DeployJob;
