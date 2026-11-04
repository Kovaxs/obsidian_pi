import assert from "node:assert/strict";
import test from "node:test";
import { parseSaveArguments, resolveSaveTarget } from "../src/save.ts";
import { ObsidianCli } from "../src/obsidian-cli.ts";
import type { VaultIndex } from "../src/types.ts";

const index: VaultIndex = {
	generatedAt: 1,
	vault: "vault",
	vaultPath: "/vault",
	files: [
		{ path: "note.md", mtime: 1, tags: ["#project"], headings: [[1, "Section", 0]] },
		{ path: "other.md", mtime: 2, tags: [], headings: [] },
	],
};

test("parses a save target and an optional draft with quoted spaces", () => {
	assert.deepEqual(parseSaveArguments('@@obs@"my note"#Section Draft this text'), {
		chain: '@@obs@"my note"#Section',
		draft: "Draft this text",
	});
	assert.deepEqual(parseSaveArguments("@@obs@note"), { chain: "@@obs@note" });
});

test("resolves an explicit file and validates its section", () => {
	assert.deepEqual(resolveSaveTarget(index, "@@obs+project@note#Section"), {
		vault: "vault",
		file: index.files[0],
		sectionPath: ["Section"],
	});
	assert.throws(() => resolveSaveTarget(index, "@@obs@note#Missing"), /not found/);
});

test("rejects vault-wide, tag-only, multiple-file, and ambiguous targets", () => {
	assert.throws(() => resolveSaveTarget(index, "@@obs"), /exactly one file/);
	assert.throws(() => resolveSaveTarget(index, "@@obs+project"), /exactly one file/);
	assert.throws(() => resolveSaveTarget(index, '@@obs@"note,other"'), /Expected one target note, found 0/);
	assert.throws(() => resolveSaveTarget(index, "@@obs@note,other"), /exactly one file/);
});

test("excluded folders cannot be targeted by name or full path", () => {
	const hiddenIndex: VaultIndex = {
		...index,
		files: [...index.files, { path: "Fleeting Notes/deep/secret.md", mtime: 1, tags: [], headings: [] }],
	};
	for (const chain of ["@@obs@secret", '@@obs@"Fleeting Notes/deep/secret"']) {
		assert.throws(() => resolveSaveTarget(hiddenIndex, chain, ["Fleeting Notes"]), /found 0/);
	}
	assert.equal(resolveSaveTarget(hiddenIndex, "@@obs@note", ["Fleeting Notes"]).file.path, "note.md");
	assert.equal(resolveSaveTarget(hiddenIndex, "@@all@secret").file.path, "Fleeting Notes/deep/secret.md");
});

test("appendNote passes the exact vault, path, content, and heading without a shell", async () => {
	let captured: string[] = [];
	const cli = new ObsidianCli(async (_command, args) => {
		captured = args;
		return { stdout: "", stderr: "", code: 0, killed: false, truncated: false };
	});
	await cli.appendNote("vault", "folder/note.md", "first line\nsecond line", "Section");
	assert.deepEqual(captured, [
		"vault=vault",
		"append",
		"path=folder/note.md",
		"content=first line\nsecond line",
		"heading=Section",
	]);
});
