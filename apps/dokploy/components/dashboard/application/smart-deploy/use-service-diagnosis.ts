import { api } from "@/utils/api";

export type ServiceType =
	| "compose"
	| "postgres"
	| "mysql"
	| "mariadb"
	| "mongo"
	| "redis";

/** Shared diagnosis query of a compose stack or database (banner + tab). */
export const useServiceDiagnosis = (
	serviceType: ServiceType,
	serviceId: string,
	enabled = true,
) =>
	api.smartDeploy.diagnoseService.useQuery(
		{ serviceType, serviceId },
		{ enabled, refetchOnWindowFocus: false, staleTime: 30_000 },
	);

export const useRefreshServiceDiagnosis = (
	serviceType: ServiceType,
	serviceId: string,
) => {
	const utils = api.useUtils();
	return () =>
		utils.smartDeploy.diagnoseService.invalidate({ serviceType, serviceId });
};
