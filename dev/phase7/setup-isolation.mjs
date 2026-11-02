// Prepares the LOCAL dev instance for permission/isolation tests (idempotent):
// - organization B with its own project and application,
// - a "Restricted project" in organization A the member cannot see,
// - a test member (member@dokploy.test) with access to apps A, B, E only.
// The member password is generated locally and stored in dev/.env (gitignored).
// Usage: node dev/phase7/setup-isolation.mjs
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createSession, devEnv, login, call as ownerCall } from "../demo-apps/api-client.mjs";

const ORG_B = "Isolation Org B";
const RESTRICTED = "Restricted project";
const MEMBER_EMAIL = devEnv.DEMO_MEMBER_EMAIL || "member@dokploy.test";
let memberPassword = devEnv.DEMO_MEMBER_PASSWORD;
if (!memberPassword) {
	memberPassword = randomBytes(18).toString("base64url");
	appendFileSync(
		new URL("../.env", import.meta.url),
		`\n# Local-only restricted member used by dev/phase7 (never a real password)\nDEMO_MEMBER_EMAIL=${MEMBER_EMAIL}\nDEMO_MEMBER_PASSWORD=${memberPassword}\n`,
	);
}

const ensureProjectWithApp = async (projectName, appName) => {
	const projects = await ownerCall("/api/project.all", undefined, "GET");
	let project = projects.find((p) => p.name === projectName);
	if (!project) {
		const created = await ownerCall("/api/project.create", { name: projectName });
		await ownerCall("/api/application.create", {
			name: appName,
			appName,
			environmentId: created.environment.environmentId,
		});
		project = (await ownerCall("/api/project.all", undefined, "GET")).find((p) => p.name === projectName);
	}
	const app = project.environments.flatMap((e) => e.applications).find((a) => a.name === appName);
	return { projectId: project.projectId, applicationId: app.applicationId };
};

await login();
const session = await ownerCall("/api/auth/get-session", undefined, "GET");
const orgA = session.session.activeOrganizationId;

const orgs = await ownerCall("/api/organization.all", undefined, "GET");
let orgB = orgs.find((o) => o.name === ORG_B);
if (!orgB) orgB = await ownerCall("/api/organization.create", { name: ORG_B });
await ownerCall("/api/auth/organization/set-active", { organizationId: orgB.id });
const orgBApp = await ensureProjectWithApp("Org B project", "orgb-app");
await ownerCall("/api/auth/organization/set-active", { organizationId: orgA });

const restricted = await ensureProjectWithApp(RESTRICTED, "restricted-app");

const demo = (await ownerCall("/api/project.all", undefined, "GET")).find((p) => p.name === "Smart Deploy Demo");
const demoEnv = demo.environments[0];
const allowedApps = demoEnv.applications.filter((a) => ["a-healthy", "b-wrong-port", "e-outdated"].includes(a.name));

const member = createSession();
let memberId;
try {
	memberId = (await member.signIn(MEMBER_EMAIL, memberPassword)).user.id;
} catch {
	const invitations = await ownerCall("/api/organization.allInvitations", undefined, "GET");
	let invite = invitations.find((i) => i.email === MEMBER_EMAIL && i.status === "pending");
	if (!invite) {
		await ownerCall("/api/organization.inviteMember", { email: MEMBER_EMAIL, role: "member" });
		invite = (await ownerCall("/api/organization.allInvitations", undefined, "GET")).find(
			(i) => i.email === MEMBER_EMAIL && i.status === "pending",
		);
	}
	// Same as pages/invitation.tsx: the invitation id authorizes the sign-up.
	await member.call(
		"/api/auth/sign-up/email",
		{ email: MEMBER_EMAIL, password: memberPassword, name: "Restricted", lastName: "Member" },
		"POST",
		{ "x-dokploy-token": invite.id },
	);
	memberId = (await member.signIn(MEMBER_EMAIL, memberPassword)).user.id;
	await member.call("/api/auth/organization/accept-invitation", { invitationId: invite.id });
}

await ownerCall("/api/user.assignPermissions", {
	id: memberId,
	accessedProjects: [demo.projectId],
	accessedEnvironments: [demoEnv.environmentId],
	accessedServices: allowedApps.map((a) => a.applicationId),
	accessedGitProviders: [],
	accessedServers: [],
	canCreateProjects: false,
	canCreateServices: false,
	canDeleteProjects: false,
	canDeleteServices: false,
	canAccessToDocker: false,
	canAccessToTraefikFiles: false,
	canAccessToAPI: true,
	canAccessToSSHKeys: false,
	canAccessToGitProviders: false,
	canDeleteEnvironments: false,
	canCreateEnvironments: false,
});

const summary = {
	orgA,
	orgB: orgB.id,
	orgBAppId: orgBApp.applicationId,
	restrictedAppId: restricted.applicationId,
	memberId,
	memberAllowedApps: allowedApps.map((a) => a.name),
};
console.log(JSON.stringify(summary, null, 2));
