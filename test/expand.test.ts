import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
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

async function fixture(t: TestContext, indexFiles = files, excludeFolders: string[] = [], noteContents = contents) {
	const directory = await mkdtemp(join(tmpdir(), "pi-obsidian-expand-"));
	const reads: string[] = [];
	const cli = new ObsidianCli(async (_command, args) => {
		if (args[0] === "vaults") return execResult("vault\t/vault\n");
		if (args[1] === "read") {
			const path = args[2]?.slice(5) ?? "";
			reads.push(path);
			assert.ok(noteContents.has(path), `Unexpected read: ${path}`);
			return execResult(noteContents.get(path)!);
		}
		assert.equal(args[1], "eval", "The extension must not write to the vault");
		return execResult(`=> ${JSON.stringify(indexFiles)}\n`);
	});
	const store = new VaultIndexStore(cli, "vault", { cacheDir: directory });
	t.after(async () => {
		store.stop();
		await rm(directory, { recursive: true, force: true });
	});
	await store.refresh();
	store.stop();
	return {
		cli,
		reads,
		vaults: {
			getStore: (keyword: string) => (keyword === "obs" || keyword === "all" ? store : undefined),
			getExcludedFolders: (keyword: string) => (keyword === "obs" ? excludeFolders : undefined),
		},
	};
}

test("resolves a file to vault and path metadata without reading its content", async (t) => {
	const { cli, vaults, reads } = await fixture(t);
	const result = await expandPrompt('Read @@obs@"uv dockerfile" please', vaults, cli);
	assert.deepEqual(result.errors, []);
	assert.match(result.text, /^Read \[Obsidian note\]/);
	assert.match(result.text, /Vault: vault\nVault path: \/vault/);
	assert.match(result.text, /Path: uv dockerfile.md\nAbsolute path: \/vault\/uv dockerfile.md/);
	assert.match(result.text, /Note: found in index/);
	assert.match(result.text, /Content: not included/);
	assert.match(result.text, /please$/);
	assert.doesNotMatch(result.text, /setup text|install text|usage text/);
	assert.deepEqual(reads, []);
});

test("expands a selected section with its location and stops at the next sibling", async (t) => {
	const { cli, vaults, reads } = await fixture(t);
	const result = await expandPrompt('Before\n@@obs@"uv dockerfile"#Setup##Install\nAfter', vaults, cli);
	assert.deepEqual(result.errors, []);
	assert.match(result.text, /Reference: @@obs@"uv dockerfile"#Setup##Install/);
	assert.match(result.text, /Path: uv dockerfile.md/);
	assert.match(result.text, /Section: Setup > Install\nLine: 4\nHeading level: H3/);
	assert.match(result.text, /### Install\ninstall text/);
	assert.doesNotMatch(result.text, /setup text|usage text/);
	assert.match(result.text, /After$/);
	assert.deepEqual(reads, ["uv dockerfile.md"]);
});

test("includes child headings in a selected parent section", async (t) => {
	const { cli, vaults } = await fixture(t);
	const result = await expandPrompt('@@obs@"uv dockerfile"#Setup', vaults, cli);
	assert.match(result.text, /## Setup\nsetup text\n### Install\ninstall text/);
	assert.doesNotMatch(result.text, /usage text/);
});

test("bare, tag, and multiple-file chains return paths without content reads", async (t) => {
	const { cli, vaults, reads } = await fixture(t);
	for (const chain of ["@@obs", "@@obs+python", '@@obs@"uv dockerfile","other note"']) {
		const result = await expandPrompt(chain, vaults, cli);
		assert.deepEqual(result.errors, []);
		assert.equal(result.changes[0]?.files, 2);
		assert.equal(result.changes[0]?.blocks, 2);
		assert.match(result.text, /Path: uv dockerfile.md/);
		assert.match(result.text, /Path: other note.md/);
		assert.doesNotMatch(result.text, /install text|other text/);
	}
	assert.deepEqual(reads, []);
});

test("passes a new file destination and requested heading without reading or creating it", async (t) => {
	const { cli, vaults, reads } = await fixture(t);
	const result = await expandPrompt('Write to @@obs@"Projects/New idea"#Title under an H2 heading "Second title"', vaults, cli);
	assert.deepEqual(result.errors, []);
	assert.match(result.text, /Path: Projects\/New idea.md/);
	assert.match(result.text, /Absolute path: \/vault\/Projects\/New idea.md/);
	assert.match(result.text, /Note: not found in index \(new destination\)/);
	assert.match(result.text, /Section: Title/);
	assert.match(result.text, /not found in index \(intended heading path\)/);
	assert.match(result.text, /under an H2 heading "Second title"$/);
	assert.deepEqual(reads, []);
});

test("resolves a new destination in an empty vault", async (t) => {
	const { cli, vaults, reads } = await fixture(t, []);
	const result = await expandPrompt('@@obs@"Projects/New idea"', vaults, cli);
	assert.deepEqual(result.errors, []);
	assert.match(result.text, /Path: Projects\/New idea.md/);
	assert.match(result.text, /new destination/);
	assert.deepEqual(reads, []);
});

test("retains missing heading paths on existing notes without including unrelated content", async (t) => {
	const { cli, vaults, reads } = await fixture(t);
	const result = await expandPrompt('@@obs@"uv dockerfile"#Setup##"New heading"', vaults, cli);
	assert.deepEqual(result.errors, []);
	assert.match(result.text, /Note: found in index/);
	assert.match(result.text, /Section: Setup > New heading/);
	assert.match(result.text, /intended heading path/);
	assert.doesNotMatch(result.text, /setup text|install text|Line:|Heading level:/);
	assert.deepEqual(reads, []);
});

test("normalizes new destinations and adds the Markdown extension only once", async (t) => {
	const { cli, vaults } = await fixture(t);
	for (const chain of ['@@obs@"./Projects/New idea.md"', '@@obs@"Projects\\\\New idea"']) {
		const result = await expandPrompt(chain, vaults, cli);
		assert.deepEqual(result.errors, []);
		assert.match(result.text, /Path: Projects\/New idea.md\n/);
		assert.doesNotMatch(result.text, /\.md\.md/);
	}
});

test("resolves existing and new names separately in a multiple-file chain", async (t) => {
	const { cli, vaults } = await fixture(t);
	const result = await expandPrompt('@@obs@"other note","Projects/New idea"', vaults, cli);
	assert.deepEqual(result.errors, []);
	assert.equal(result.changes[0]?.files, 2);
	assert.match(result.text, /Path: other note.md/);
	assert.match(result.text, /Path: Projects\/New idea.md/);
});

test("full paths distinguish duplicate basenames and prefer an exact root path", async (t) => {
	const duplicates = [
		{ ...files[1]!, path: "note.md" },
		{ ...files[1]!, path: "Projects/note.md" },
		{ ...files[1]!, path: "Archive/note.md" },
	];
	const { cli, vaults } = await fixture(t, duplicates);
	for (const path of ["note", "Projects/note", "Archive/note"]) {
		const result = await expandPrompt(`@@obs@${path}`, vaults, cli);
		assert.deepEqual(result.errors, []);
		assert.equal(result.changes[0]?.files, 1);
		assert.ok(result.text.includes(`Path: ${path}.md\n`));
	}
});

test("excluded notes cannot become new destinations by name or normalized path", async (t) => {
	const hidden: VaultFile = {
		path: "Fleeting Notes/deep/secret.md", mtime: 1, tags: ["#python", "#secret"], headings: [],
	};
	const { vaults, cli, reads } = await fixture(t, [...files, hidden], ["Fleeting Notes"]);
	for (const chain of ["@@obs", "@@obs+python"]) {
		const result = await expandPrompt(chain, vaults, cli);
		assert.deepEqual(result.errors, []);
		assert.equal(result.changes[0]?.files, 2);
		assert.doesNotMatch(result.text, /secret/);
	}
	for (const chain of [
		'@@obs@"Fleeting Notes/deep/secret"', "@@obs@secret", "@@obs+secret",
		'@@obs@"./Fleeting Notes/new"', '@@obs@"Fleeting Notes/new"#Heading',
	]) {
		const result = await expandPrompt(chain, vaults, cli);
		assert.equal(result.text, chain);
		assert.match(result.errors[0] ?? "", /no notes match/);
	}
	const all = await expandPrompt("@@all@secret", vaults, cli);
	assert.deepEqual(all.errors, []);
	assert.match(all.text, /Path: Fleeting Notes\/deep\/secret.md/);
	assert.deepEqual(reads, []);
});

test("tag filters cannot turn existing mismatches or missing notes into destinations", async (t) => {
	const { cli, vaults } = await fixture(t);
	for (const chain of ['@@obs+docker@"other note"', "@@obs+docker@missing"]) {
		const result = await expandPrompt(chain, vaults, cli);
		assert.equal(result.text, chain);
		assert.match(result.errors[0] ?? "", /no notes match/);
	}
});

test("rejects paths outside the vault and destinations that do not name a file", async (t) => {
	const { cli, vaults, reads } = await fixture(t);
	for (const path of ["../outside", "Projects/../outside", "/absolute", "C:/absolute", ".", "Projects/", ".md"]) {
		const chain = `@@obs@${JSON.stringify(path)}`;
		const result = await expandPrompt(chain, vaults, cli);
		assert.equal(result.text, chain);
		assert.match(result.errors[0] ?? "", /relative to the vault/);
	}
	assert.deepEqual(reads, []);
});

test("retains unknown keywords, malformed chains, and unmatched tag searches", async (t) => {
	const { cli, vaults } = await fixture(t);
	for (const chain of ["@@unknown@note", '@@obs@"unclosed', "@@obs+networking"]) {
		const result = await expandPrompt(`Use ${chain}`, vaults, cli);
		assert.equal(result.text, `Use ${chain}`);
		assert.equal(result.errors.length, 1);
	}
});

test("retains a section reference when its CLI read fails", async (t) => {
	const { vaults } = await fixture(t);
	const cli = new ObsidianCli(async () => {
		throw new Error("Obsidian unavailable");
	});
	const chain = '@@obs@"uv dockerfile"#Setup';
	const result = await expandPrompt(chain, vaults, cli);
	assert.equal(result.text, chain);
	assert.match(result.errors[0] ?? "", /Obsidian unavailable/);
	assert.deepEqual(result.changes, []);
});

test("expands multiple independent chains and leaves failed searches unchanged", async (t) => {
	const { cli, vaults } = await fixture(t);
	const result = await expandPrompt('@@obs@"other note" @@obs+networking', vaults, cli);
	assert.equal(result.errors.length, 1);
	assert.equal(result.changes.length, 1);
	assert.match(result.text, /Path: other note.md/);
	assert.match(result.text, /@@obs\+networking/);
});

test("caps selected UTF-8 section content without splitting a code point", async (t) => {
	const large: VaultFile[] = [{ ...files[1]!, path: "large.md", headings: [[1, "Large", 0]] }];
	const { cli, vaults } = await fixture(t, large, [], new Map([["large.md", "# Large\n" + "a🙂".repeat(100)]]));
	const result = await expandPrompt("@@obs@large#Large", vaults, cli, { maxNoteBytes: 80, maxChainBytes: 1_000 });
	assert.equal(result.changes[0]?.truncated, true);
	assert.match(result.text, /truncated/);
	assert.doesNotMatch(result.text, /�/);
});

test("applies the content byte cap separately to each selected note", async (t) => {
	const large: VaultFile[] = ["large-a.md", "large-b.md"].map((path) => ({
		...files[1]!, path, headings: [[1, "Large", 0]],
	}));
	const { cli, vaults, reads } = await fixture(t, large, [], new Map(large.map((file) => [file.path, "# Large\n" + "x".repeat(100)])));
	const result = await expandPrompt("@@obs+python#Large", vaults, cli, { maxNoteBytes: 20, maxChainBytes: 2_000 });
	assert.equal(result.changes[0]?.blocks, 2);
	assert.match(result.text, /# Large\nx{12}/);
	assert.doesNotMatch(result.text, /x{13}/);
	assert.deepEqual(reads, large.map((file) => file.path));
});

test("reads a note once even when a heading path matches multiple sections", async (t) => {
	const repeated: VaultFile = { ...files[1]!, path: "repeated.md", headings: [[2, "Same", 0], [2, "Same", 2]] };
	const { cli, vaults, reads } = await fixture(t, [repeated], [], new Map([[repeated.path, "## Same\nfirst\n## Same\nsecond"]]));
	const result = await expandPrompt("@@obs@repeated#Same", vaults, cli);
	assert.deepEqual(result.errors, []);
	assert.equal(result.changes[0]?.blocks, 2);
	assert.match(result.text, /first/);
	assert.match(result.text, /second/);
	assert.deepEqual(reads, [repeated.path]);
});

test("stops reading notes after the chain cap", async (t) => {
	const large: VaultFile[] = ["large-a.md", "large-b.md", "large-c.md"].map((path) => ({
		...files[1]!, path, headings: [[1, "Large", 0]],
	}));
	const { cli, vaults, reads } = await fixture(t, large, [], new Map(large.map((file) => [file.path, "# Large\n" + "x".repeat(100)])));
	const result = await expandPrompt("@@obs+python#Large", vaults, cli, { maxNoteBytes: 100, maxChainBytes: 450 });
	assert.equal(result.changes[0]?.truncated, true);
	assert.ok(reads.length < large.length);
});

test("the chain cap also bounds path-only reference lists", async (t) => {
	const { cli, vaults, reads } = await fixture(t);
	const result = await expandPrompt("@@obs", vaults, cli, { maxChainBytes: 300 });
	assert.equal(result.changes[0]?.blocks, 1);
	assert.equal(result.changes[0]?.truncated, true);
	assert.deepEqual(reads, []);
});

function execResult(stdout: string) {
	return { stdout, stderr: "", code: 0, killed: false, truncated: false };
}
