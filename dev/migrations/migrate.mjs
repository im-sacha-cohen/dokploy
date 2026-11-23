// Applies a Drizzle migrations folder to a database, like apps/dokploy/migration.ts.
// Usage: node migrate.mjs <database-url> <migrations-folder>
import { createRequire } from "node:module";

// Dependencies live in the app's node_modules, not next to this script.
const require = createRequire(new URL("../../apps/dokploy/package.json", import.meta.url));
const { drizzle } = require("drizzle-orm/postgres-js");
const { migrate } = require("drizzle-orm/postgres-js/migrator");
const postgres = require("postgres");

const [url, folder] = process.argv.slice(2);
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
	await migrate(drizzle(sql), { migrationsFolder: folder });
	console.log(`migrated ${folder}`);
} finally {
	await sql.end();
}
