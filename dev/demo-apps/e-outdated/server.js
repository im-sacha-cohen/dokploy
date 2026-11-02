const fs = require("node:fs");
const http = require("node:http");

const port = Number(process.env.PORT || 3000);
const version = fs.readFileSync(`${__dirname}/VERSION`, "utf8").trim();

http
	.createServer((req, res) => {
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(JSON.stringify({ status: "ok", version }));
		}
		res.end(`e-outdated ${version}\n`);
	})
	.listen(port, "0.0.0.0", () => console.log(`e-outdated ${version} on 0.0.0.0:${port}`));
