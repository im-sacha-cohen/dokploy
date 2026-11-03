// Minimal REST client for the LOCAL Dokploy dev instance (cookie sessions).
// Reads DOKPLOY_DEV_URL (environment first) and the test accounts from dev/.env.
import { readFileSync } from "node:fs";

export const devEnv = Object.fromEntries(
	readFileSync(new URL("../.env", import.meta.url), "utf8")
		.split("\n")
		.filter((l) => l && !l.startsWith("#") && l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

export const baseUrl =
	process.env.DOKPLOY_DEV_URL ||
	devEnv.DOKPLOY_DEV_URL ||
	"http://localhost:3000";
if (!["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname)) {
	throw new Error(`Refusing to talk to a non-local instance (${baseUrl})`);
}

/** One cookie jar per user, so several test accounts can be driven at once. */
export const createSession = () => {
	const jar = new Map();
	let cookie = "";
	const storeCookies = (res) => {
		for (const header of res.headers.getSetCookie?.() ?? []) {
			const [pair] = header.split(";");
			jar.set(pair.slice(0, pair.indexOf("=")), pair);
		}
		cookie = [...jar.values()].join("; ");
	};

	const call = async (path, body, method = "POST", extraHeaders = {}) => {
		const res = await fetch(`${baseUrl}${path}`, {
			method,
			headers: {
				"content-type": "application/json",
				cookie,
				origin: baseUrl,
				...extraHeaders,
			},
			body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
		});
		storeCookies(res);
		const text = await res.text();
		if (!res.ok) {
			const error = new Error(
				`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
			);
			error.status = res.status;
			throw error;
		}
		return text ? JSON.parse(text) : null;
	};

	const rawGet = async (url) => {
		const res = await fetch(url, {
			headers: { cookie, origin: baseUrl },
			redirect: "manual",
		});
		storeCookies(res);
		return res;
	};

	const signIn = (email, password) =>
		call("/api/auth/sign-in/email", { email, password });

	return { call, rawGet, signIn };
};

const owner = createSession();
export const call = owner.call;
export const rawGet = owner.rawGet;

export async function login() {
	const email = devEnv.DEMO_ADMIN_EMAIL;
	const password = devEnv.DEMO_ADMIN_PASSWORD;
	if (!email || !password) {
		throw new Error(
			"DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD missing in dev/.env",
		);
	}
	try {
		await owner.signIn(email, password);
	} catch {
		console.log("No account yet: creating the local test owner account");
		await call("/api/auth/sign-up/email", {
			email,
			password,
			name: "Demo",
			lastName: "Owner",
		});
		await owner.signIn(email, password);
	}
}
