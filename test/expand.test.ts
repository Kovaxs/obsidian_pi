import assert from "node:assert/strict";
import test from "node:test";
import { expandPrompt } from "../src/expand.ts";
import { ObsidianCli } from "../src/obsidian-cli.ts";
import { VaultIndexStore } from "../src/vault-index.ts";
import type { VaultFile } from "../src/types.ts";

const files: VaultFile[] = [
	{
		path: "uv dockerfile.md",
		mtime: 1,
		tags: ["#python/uv", "#docker"],
		headings: [
			[2, "Setup", 1],
			[3, "Install", 3],
			[2, "Usage", 5],
		],
	},
	{ path: "other note.md", mtime: 2, tags: ["#python"], headings: [] },
];
const contents = new Map([
	["uv dockerfile.md", "# uv\n## Setup\nsetup text\n### Install\ninstall text\n## Usage\nusage text\n"],
	["other note.md", "other text\n"],
]);

function fixture(indexFiles = files) {
	const cli = new ObsidianCli(async (_command, args) => {
		if (args[0] === "vaults") return execResult("vault\t/vault\n");
		if (args[1] === "read") return execResult(contents.get(args[2]?.slice(5) ?? "") ?? "");
		return execResult(`=> ${JSON.stringify(indexFiles)}\n`);
	});
	const store = new VaultIndexStore(cli, "vault");
	return { cli, vaults: { getStore: (keyword: string) => (keyword === "obs" ? store : undefined) } };
}

test("expands a file section with source citations and stops at the next sibling", async () => {
	const { cli, vaults } = fixture();
	const result = await expandPrompt('Before\n@@obs@"uv dockerfile"#Setup##Install\nAfter', vaults, cli);
	assert.equal(result.errors.length, 0);
	assert.match(result.text, /Reference: @@obs@"uv dockerfile"#Setup##Install/);
	assert.match(result.text, /Path: uv dockerfile.md/);
	assert.match(result.text, /Section: Setup > Install/);
	assert.match(result.text, /### Install\ninstall text/);
	assert.doesNotMatch(result.text, /usage text/);
	assert.match(result.text, /After$/);
});

test("expands tags into several notes and reads each selected file once", async () => {
	const { cli, vaults } = fixture();
	let reads = 0;
	const countingCli = new ObsidianCli(async (_command, args) => {
		if (args[1] === "read") reads += 1;
		return execResult(contents.get(args[2]?.slice(5) ?? "") ?? "");
	});
	const result = await expandPrompt("@@obs+python", vaults, countingCli);
	assert.equal(reads, 2);
	assert.equal(result.changes[0]?.files, 2);
	assert.equal(result.changes[0]?.blocks, 2);
	assert.match(result.text, /install text/);
	assert.match(result.text, /other text/);
	assert.equal(cli instanceof ObsidianCli, true);
});

test("retains unresolved chains and returns an error", async () => {
	const { cli, vaults } = fixture();
	const result = await expandPrompt("Use @@obs@missing please", vaults, cli);
	assert.equal(result.text, "Use @@obs@missing please");
	assert.match(result.errors[0] ?? "", /no notes match/);
});

test("expands multiple independent chains in one prompt", async () => {
	const { cli, vaults } = fixture();
	const result = await expandPrompt('@@obs@"other note" @@obs+networking', vaults, cli);
	assert.equal(result.errors.length, 1);
	assert.equal(result.changes.length, 1);
	assert.match(result.text, /other text/);
	assert.match(result.text, /@@obs\+networking/);
});

test("caps UTF-8 note content and marks truncation", async () => {
	const large = [{ ...files[1]!, path: "large.md" }];
	const { cli, vaults } = fixture(large);
	const largeCli = new ObsidianCli(async () => execResult("a🙂".repeat(100)));
	const result = await expandPrompt("@@obs@large", vaults, largeCli, { maxNoteBytes: 80, maxChainBytes: 1_000 });
	assert.equal(result.changes[0]?.truncated, true);
	assert.match(result.text, /truncated/);
	assert.doesNotMatch(result.text, /�/);
	assert.equal(cli instanceof ObsidianCli, true);
});

test("applies the byte cap separately to each note", async () => {
	const large = [
		{ ...files[1]!, path: "large-a.md" },
		{ ...files[1]!, path: "large-b.md" },
	];
	const { vaults } = fixture(large);
	const largeCli = new ObsidianCli(async () => execResult("x".repeat(100)));
	const result = await expandPrompt("@@obs+python", vaults, largeCli, {
		maxNoteBytes: 20,
		maxChainBytes: 1_000,
	});
	assert.equal(result.changes[0]?.blocks, 2);
	assert.match(result.text, /x{20}/);
	assert.doesNotMatch(result.text, /x{21}/);
});

test("stops reading notes after the chain cap", async () => {
	const large = [
		{ ...files[1]!, path: "large-a.md" },
		{ ...files[1]!, path: "large-b.md" },
		{ ...files[1]!, path: "large-c.md" },
	];
	const { vaults } = fixture(large);
	let reads = 0;
	const largeCli = new ObsidianCli(async () => {
		reads += 1;
		return execResult("x".repeat(100));
	});
	const result = await expandPrompt("@@obs+python", vaults, largeCli, {
		maxNoteBytes: 100,
		maxChainBytes: 150,
	});
	assert.equal(result.changes[0]?.truncated, true);
	assert.ok(reads < large.length);
});

function execResult(stdout: string) {
	return { stdout, stderr: "", code: 0, killed: false, truncated: false };
}
