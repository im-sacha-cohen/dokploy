// Minimal REST client for the LOCAL Dokploy dev instance (cookie session).
// Reads DOKPLOY_DEV_URL, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD from dev/.env.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
	readFileSync(new URL("../.env", import.meta.url), "utf8")
		.split("\n")
		.filter((l) => l && !l.startsWith("#") && l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);

export const baseUrl = env.DOKPLOY_DEV_URL || "http://localhost:3000";
const email = env.DEMO_ADMIN_EMAIL;
const password = env.DEMO_ADMIN_PASSWORD;
if (!["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname)) {
	throw new Error(`Refusing to talk to a non-local instance (${baseUrl})`);
}
if (!email || !password) {
	throw new Error("DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD missing in dev/.env");
}

const jar = new Map();
let cookie = "";

const storeCookies = (res) => {
	for (const header of res.headers.getSetCookie?.() ?? []) {
		const [pair] = header.split(";");
		const name = pair.slice(0, pair.indexOf("="));
		jar.set(name, pair);
	}
	cookie = [...jar.values()].join("; ");
};

export async function call(path, body, method = "POST") {
	const res = await fetch(`${baseUrl}${path}`, {
		method,
		headers: { "content-type": "application/json", cookie, origin: baseUrl },
		body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
	});
	storeCookies(res);
	const text = await res.text();
	if (!res.ok)
		throw new Error(
			`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`,
		);
	return text ? JSON.parse(text) : null;
}

export async function login() {
	try {
		await call("/api/auth/sign-in/email", { email, password });
	} catch {
		console.log("No account yet: creating the local test owner account");
		await call("/api/auth/sign-up/email", {
			email,
			password,
			name: "Demo",
			lastName: "Owner",
		});
		await call("/api/auth/sign-in/email", { email, password });
	}
}

/** GET with the session cookie, without following redirects. */
export async function rawGet(url) {
	const res = await fetch(url, {
		headers: { cookie, origin: baseUrl },
		redirect: "manual",
	});
	storeCookies(res);
	return res;
}
