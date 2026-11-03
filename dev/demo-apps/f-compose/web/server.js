const http = require("node:http");
const net = require("node:net");

const port = Number(process.env.PORT || 3000);
const redisHost = process.env.REDIS_HOST || "cache";

function pingRedis() {
	return new Promise((resolve) => {
		const socket = net.connect(6379, redisHost);
		socket.setTimeout(1000);
		socket.on("connect", () => socket.write("PING\r\n"));
		socket.on("data", (d) => {
			resolve(d.toString().startsWith("+PONG"));
			socket.end();
		});
		socket.on("error", () => resolve(false));
		socket.on("timeout", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

http
	.createServer(async (req, res) => {
		const redis = await pingRedis();
		if (req.url === "/health") {
			res.writeHead(redis ? 200 : 503, { "content-type": "application/json" });
			return res.end(
				JSON.stringify({ status: redis ? "ok" : "degraded", redis }),
			);
		}
		res.end(`f-compose web (redis: ${redis ? "up" : "down"})\n`);
	})
	.listen(port, "0.0.0.0", () => console.log(`listening on 0.0.0.0:${port}`));
