import { handleProtectedResourceMetadata } from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import { sendWebResponse, toWebRequest } from "@/lib/web-request";

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	await sendWebResponse(
		res,
		handleProtectedResourceMetadata(await toWebRequest(req)),
	);
}
