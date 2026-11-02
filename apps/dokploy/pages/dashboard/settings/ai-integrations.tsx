import { validateRequest } from "@dokploy/server";
import type { GetServerSidePropsContext } from "next";
import type { ReactElement } from "react";
import { ShowAiIntegrations } from "@/components/dashboard/settings/ai-integrations/show-ai-integrations";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";

const Page = () => (
	<div className="flex w-full flex-col gap-4">
		<ShowAiIntegrations />
	</div>
);

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="AI Integrations">{page}</DashboardLayout>
);

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { user } = await validateRequest(ctx.req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	return { props: {} };
}
