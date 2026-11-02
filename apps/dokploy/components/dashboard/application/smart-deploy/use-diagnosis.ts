import { api } from "@/utils/api";

/**
 * Shared diagnosis query: banner, network chain, domain hints and the result
 * step read the same cache entry, so the page runs one diagnosis at a time.
 */
export const useDiagnosis = (applicationId: string, enabled = true) =>
	api.smartDeploy.diagnoseApplication.useQuery(
		{ applicationId },
		{ enabled, refetchOnWindowFocus: false, staleTime: 30_000 },
	);

export const useRefreshDiagnosis = (applicationId: string) => {
	const utils = api.useUtils();
	return async () => {
		await Promise.all([
			utils.smartDeploy.diagnoseApplication.invalidate({ applicationId }),
			utils.smartDeploy.getVersionStatus.invalidate({ applicationId }),
			utils.domain.byApplicationId.invalidate({ applicationId }),
		]);
	};
};
