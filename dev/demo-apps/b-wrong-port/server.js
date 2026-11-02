const http = require("node:http");

const port = Number(process.env.PORT || 3000);
const version = process.env.APP_VERSION || "a-healthy";

http
	.createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ status: "ok" }));
		}
		res.writeHead(200, { "content-type": "text/plain" });
		res.end(`Hello from ${version}\n`);
	})
	.listen(port, "0.0.0.0", () => console.log(`listening on 0.0.0.0:${port}`));
