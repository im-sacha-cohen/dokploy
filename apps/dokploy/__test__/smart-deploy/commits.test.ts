import { parseGitLog } from "@dokploy/server/smart-deploy/versioning/commits";
import { describe, expect, it } from "vitest";

const SEP = "\x1f";
const SHA_1 = "a".repeat(40);
const SHA_2 = "b".repeat(40);

describe("parseGitLog", () => {
	it("reads sha, author, date and subject, newest first", () => {
		const commits = parseGitLog(
			[
				[SHA_2, "Ana", "2026-11-24T10:00:00+01:00", "fix: login"].join(SEP),
				[SHA_1, "", "", "first | commit"].join(SEP),
				"warning: filtering not recognized by server, ignoring",
				"",
			].join("\n"),
		);
		expect(commits).toEqual([
			{
				sha: SHA_2,
				author: "Ana",
				date: "2026-11-24T10:00:00+01:00",
				message: "fix: login",
			},
			{ sha: SHA_1, author: null, date: null, message: "first | commit" },
		]);
	});
});
