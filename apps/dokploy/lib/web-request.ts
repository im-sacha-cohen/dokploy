import type { IncomingMessage, ServerResponse } from "node:http";
import { isHttpsRequest } from "@/lib/secure-cookies";

const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {}

/** Builds a web-standard Request from a Node request (body read up to 1 MiB). */
export const toWebRequest = async (req: IncomingMessage): Promise<Request> => {
	const proto = isHttpsRequest(req.headers["x-forwarded-proto"])
		? "https"
		: "http";
	const url = `${proto}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		headers.set(key, Array.isArray(value) ? value.join(", ") : value);
	}

	let body: ArrayBuffer | undefined;
	if (req.method !== "GET" && req.method !== "HEAD") {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
			chunks.push(chunk as Buffer);
		}
		const merged = Buffer.concat(chunks);
		body = merged.buffer.slice(
			merged.byteOffset,
			merged.byteOffset + merged.byteLength,
		) as ArrayBuffer;
	}

	const controller = new AbortController();
	req.on("close", () => controller.abort());
	return new Request(url, {
		method: req.method,
		headers,
		body,
		signal: controller.signal,
	});
};

/** Writes a web Response to a Node response, streaming the body (SSE-safe). */
export const sendWebResponse = async (
	res: ServerResponse,
	response: Response,
) => {
	res.statusCode = response.status;
	response.headers.forEach((value, key) => {
		res.setHeader(key, value);
	});
	if (!response.body) {
		res.end();
		return;
	}
	res.flushHeaders?.();
	const reader = response.body.getReader();
	res.on("close", () => {
		void reader.cancel().catch(() => undefined);
	});
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(value);
		}
	} finally {
		res.end();
	}
};
