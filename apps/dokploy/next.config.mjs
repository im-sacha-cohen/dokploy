/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */

/** @type {import("next").NextConfig} */
const nextConfig = {
	reactStrictMode: true,
	typescript: {
		ignoreBuildErrors: true,
	},
	transpilePackages: ["@dokploy/server"],
	async rewrites() {
		return [
			{ source: "/mcp", destination: "/api/mcp" },
			{
				source: "/.well-known/oauth-protected-resource/:path*",
				destination: "/api/well-known/oauth-protected-resource",
			},
			{
				source: "/.well-known/oauth-protected-resource",
				destination: "/api/well-known/oauth-protected-resource",
			},
			{
				source: "/.well-known/oauth-authorization-server/:path*",
				destination: "/api/well-known/oauth-authorization-server",
			},
			{
				source: "/.well-known/oauth-authorization-server",
				destination: "/api/well-known/oauth-authorization-server",
			},
		];
	},
	async headers() {
		return [
			{
				// Apply security headers to all routes
				source: "/:path*",
				headers: [
					{
						key: "X-Frame-Options",
						value: "DENY",
					},
					{
						key: "Content-Security-Policy",
						value: "frame-ancestors 'none'",
					},
					{
						key: "X-Content-Type-Options",
						value: "nosniff",
					},
					{
						key: "Referrer-Policy",
						value: "strict-origin-when-cross-origin",
					},
				],
			},
		];
	},
};

export default nextConfig;
