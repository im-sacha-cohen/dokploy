const http = require("node:http");

const required = ["DATABASE_URL", "SESSION_SECRET"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
	console.error(`Missing required environment variable(s): ${missing.join(", ")}`);
	process.exit(78);
}

const port = Number(process.env.PORT || 3000);
http
	.createServer((_req, res) => res.end("d-missing-env configured\n"))
	.listen(port, "0.0.0.0", () => console.log(`listening on 0.0.0.0:${port}`));
