const http = require("node:http");

// Deliberately bound to loopback: reachable inside the container only.
http
	.createServer((_req, res) => res.end("g-localhost-bind\n"))
	.listen(3000, "127.0.0.1", () => console.log("listening on 127.0.0.1:3000"));
