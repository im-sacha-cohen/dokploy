import {
	configureMcp,
	type findApplicationById,
	handleMcpRequest,
} from "@dokploy/server";
import type { NextApiRequest, NextApiResponse } from "next";
import {
	BodyTooLargeError,
	sendWebResponse,
	toWebRequest,
} from "@/lib/web-request";
import { callApi, execInService } from "@/server/mcp/api-bridge";
import { enqueueApplicationJob } from "@/server/utils/enqueue-application-job";

export const config = { api: { bodyParser: false, responseLimit: false } };

configureMcp({
	enqueue: (application, job) =>
		enqueueApplicationJob(
			application as Awaited<ReturnType<typeof findApplicationById>>,
			job,
		),
	callApi,
	execInService,
});

/** MCP Streamable HTTP endpoint, served at /mcp through a rewrite. */
export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	try {
		const request = await toWebRequest(req);
		await sendWebResponse(res, await handleMcpRequest(request));
	} catch (error) {
		if (error instanceof BodyTooLargeError) {
			res.status(413).json({ error: "payload_too_large" });
			return;
		}
		console.error("[mcp] request failed:", error);
		if (!res.headersSent) res.status(500).json({ error: "server_error" });
		else res.end();
	}
}
