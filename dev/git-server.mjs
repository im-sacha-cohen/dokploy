// Minimal smart-HTTP Git server (git http-backend over CGI) for local demo repos.
// Dokploy's custom Git source requires http(s) for keyless clones and uses
// `--depth 1`, which the "dumb" static HTTP protocol cannot serve.
import { spawn } from "node:child_process";
import http from "node:http";

const root = process.env.GIT_PROJECT_ROOT || "/workspace/dev/demo-apps/.repos";
const port = Number(process.env.GIT_SERVER_PORT || 4040);

http
	.createServer((req, res) => {
		const url = new URL(req.url, "http://localhost");
		const cgi = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				REQUEST_METHOD: req.method,
				PATH_INFO: decodeURIComponent(url.pathname),
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: req.headers["content-type"] || "",
				REMOTE_ADDR: req.socket.remoteAddress || "",
			},
		});
		req.pipe(cgi.stdin);

		let headersDone = false;
		let buffer = Buffer.alloc(0);
		cgi.stdout.on("data", (chunk) => {
			if (headersDone) return res.write(chunk);
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end === -1) return;
			let status = 200;
			for (const line of buffer.subarray(0, end).toString().split("\r\n")) {
				const idx = line.indexOf(":");
				const name = line.slice(0, idx).trim();
				const value = line.slice(idx + 1).trim();
				if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
				else res.setHeader(name, value);
			}
			res.writeHead(status);
			headersDone = true;
			res.write(buffer.subarray(end + 4));
		});
		cgi.stderr.on("data", (d) => process.stderr.write(d));
		cgi.on("close", () => res.end());
	})
	.listen(port, "0.0.0.0", () => console.log(`demo git server on :${port} serving ${root}`));
