import assert from "node:assert/strict";
import test from "node:test";
import { CombinedAutocompleteProvider, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { createObsidianAutocomplete } from "../src/autocomplete.ts";
import { ObsidianCli } from "../src/obsidian-cli.ts";
import { VaultIndexStore } from "../src/vault-index.ts";
import type { VaultFile } from "../src/types.ts";

const files: VaultFile[] = [
	{
		path: "uv dockerfile.md",
		mtime: 1,
		tags: ["#python/uv", "#docker"],
		headings: [
			[1, "Setup", 0],
			[2, "Multi stage build", 1],
			[1, "Usage", 3],
		],
	},
	{ path: "networking.md", mtime: 2, tags: ["#networking/dns", "#networking/reverse-proxy"], headings: [] },
];

async function fixture(excludeFolders: string[] = [], indexFiles = files) {
	const cli = new ObsidianCli(async (_command, args) => {
		const stdout = args[0] === "vaults" ? "vault\t/vault\n" : `=> ${JSON.stringify(indexFiles)}\n`;
		return {
			stdout,
			stderr: "",
			code: 0,
			killed: false,
			truncated: false,
		};
	});
	const store = new VaultIndexStore(cli, "vault", { cacheDir: "/tmp/pi-obsidian-autocomplete-tests" });
	await store.refresh();
	store.stop();
	return createObsidianAutocomplete(baseProvider(), {
		getStore: (keyword) => (keyword === "obs" || keyword === "all" ? store : undefined),
		getExcludedFolders: (keyword) => (keyword === "obs" ? excludeFolders : undefined),
	});
}

test("suggests files with fuzzy matching and quoted insertion", async () => {
	const provider = await fixture();
	const line = '@@obs@"uv dock';
	const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	assert.equal(suggestions?.items[0]?.value, '@@obs@"uv dockerfile"');
	const applied = provider.applyCompletion([line], 0, line.length, suggestions!.items[0]!, suggestions!.prefix);
	assert.deepEqual(applied, { lines: ['@@obs@"uv dockerfile"'], cursorLine: 0, cursorCol: 21 });
});

test("suggests root tags with child markers and counts", async () => {
	const provider = await fixture();
	const suggestions = await provider.getSuggestions(["@@obs+"], 0, 6, { signal: new AbortController().signal });
	assert.deepEqual(suggestions?.items.map((item) => item.label), ["docker", "networking ▸", "python ▸"]);
});

test("suggests direct tag children after a slash", async () => {
	const provider = await fixture();
	const suggestions = await provider.getSuggestions(["@@obs+networking/"], 0, 17, { signal: new AbortController().signal });
	assert.deepEqual(suggestions?.items.map((item) => item.value), [
		"@@obs+networking/dns",
		"@@obs+networking/reverse-proxy",
	]);
});

test("narrows files by completed tags", async () => {
	const provider = await fixture();
	const suggestions = await provider.getSuggestions(["@@obs+python@"], 0, 13, { signal: new AbortController().signal });
	assert.deepEqual(suggestions?.items.map((item) => item.label), ["uv dockerfile"]);
});

test("Tab after # returns the full indented heading tree", async () => {
	const provider = await fixture();
	const line = '@@obs@"uv dockerfile"#';
	const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal, force: true });
	assert.deepEqual(suggestions?.items.map((item) => item.label), ["Setup", "  Multi stage build", "Usage"]);
	assert.equal(suggestions?.items[1]?.value, '@@obs@"uv dockerfile"#Setup##"Multi stage build"');
});

test("regular section suggestions filter the current depth", async () => {
	const provider = await fixture();
	const line = '@@obs@"uv dockerfile"#Setup##Multi';
	const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	assert.deepEqual(suggestions?.items.map((item) => item.label), ["Multi stage build"]);
});

test("delegates non-vault autocomplete", async () => {
	const provider = await fixture();
	const suggestions = await provider.getSuggestions(["@src"], 0, 4, { signal: new AbortController().signal });
	assert.equal(suggestions?.items[0]?.value, "delegated");
});

test("exclusions hide notes, tags, and headings while preserving an unrestricted alias", async () => {
	const hidden: VaultFile = {
		path: "Fleeting Notes/deep/secret.md",
		mtime: 1,
		tags: ["#secret", "#docker"],
		headings: [[1, "Secret heading", 0]],
	};
	const provider = await fixture(["Fleeting Notes"], [...files, hidden]);
	const options = { signal: new AbortController().signal, force: true };
	for (const line of ["@@obs", "@@obs+", "@@obs#"]) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, options);
		assert.ok(suggestions);
		assert.ok(suggestions.items.every((item) => !/secret/i.test(`${item.label} ${item.description}`)));
		if (line === "@@obs+") {
			assert.equal(suggestions.items.find((item) => item.label === "docker")?.description, "1 note(s)");
		}
	}
	for (const line of ["@@all", "@@all+", "@@all#"]) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, options);
		assert.ok(suggestions?.items.some((item) => /secret/i.test(item.label)));
	}
});

test("preserves slash-command completion through the real pi provider", async () => {
	const current = new CombinedAutocompleteProvider(
		[{ name: "reload" }, { name: "obsidian-setup" }],
		process.cwd(),
	);
	const provider = createObsidianAutocomplete(current, { getStore: () => undefined, getExcludedFolders: () => undefined });
	for (const line of ["/", "/rel", "  /rel", "/obsidian-s"]) {
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			signal: new AbortController().signal,
		});
		assert.ok(suggestions);
		const item = suggestions.items[0];
		assert.ok(item);
		const expected = current.applyCompletion([line], 0, line.length, item, suggestions.prefix);
		const actual = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
		assert.deepEqual(actual, expected);
		assert.ok(actual.lines[0]?.trimStart().startsWith("/"));
		assert.ok(actual.lines[0]?.endsWith(" "));
	}
});

test("delegates command arguments and file attachment insertion", async () => {
	const current = new CombinedAutocompleteProvider(
		[{ name: "deploy", getArgumentCompletions: () => [{ value: "production", label: "production" }] }],
		process.cwd(),
	);
	const provider = createObsidianAutocomplete(current, { getStore: () => undefined, getExcludedFolders: () => undefined });
	const line = "/deploy pro";
	const suggestions = await provider.getSuggestions([line], 0, line.length, {
		signal: new AbortController().signal,
	});
	assert.ok(suggestions);
	const item = suggestions.items[0];
	assert.ok(item);
	assert.deepEqual(
		provider.applyCompletion([line], 0, line.length, item, suggestions.prefix),
		current.applyCompletion([line], 0, line.length, item, suggestions.prefix),
	);

	const attachment = { value: "@src/index.ts", label: "index.ts" };
	assert.deepEqual(
		provider.applyCompletion(["Read @src"], 0, 9, attachment, "@src"),
		current.applyCompletion(["Read @src"], 0, 9, attachment, "@src"),
	);
});

test("inserts full paths to distinguish notes with the same basename", async () => {
	const duplicateFiles: VaultFile[] = ["Projects/New idea.md", "Archive/New idea.md"].map((path) => ({
		path, mtime: 1, tags: [], headings: [],
	}));
	const provider = await fixture([], duplicateFiles);
	const line = '@@obs@"New idea';
	const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	assert.deepEqual(suggestions?.items.map((item) => item.value).sort(), [
		'@@obs@"Archive/New idea"', '@@obs@"Projects/New idea"',
	]);
});

test("heading suggestions respect an exact root path when basenames are duplicated", async () => {
	const duplicateFiles: VaultFile[] = ["note.md", "Projects/note.md"].map((path, index) => ({
		path, mtime: 1, tags: [], headings: [[1, index === 0 ? "Root heading" : "Nested heading", 0]],
	}));
	const provider = await fixture([], duplicateFiles);
	const line = "@@obs@note#";
	const suggestions = await provider.getSuggestions([line], 0, line.length, {
		signal: new AbortController().signal, force: true,
	});
	assert.deepEqual(suggestions?.items.map((item) => item.label), ["Root heading"]);
});

test("keeps earlier selected paths quoted when completing multiple files", async () => {
	const provider = await fixture();
	const line = '@@obs@"uv dockerfile",net';
	const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
	assert.equal(suggestions?.items[0]?.value, '@@obs@"uv dockerfile",networking');
});

function baseProvider(): AutocompleteProvider {
	return {
		async getSuggestions() {
			return { prefix: "@src", items: [{ value: "delegated", label: "delegated" }] };
		},
		applyCompletion(lines, cursorLine, cursorCol, item: AutocompleteItem) {
			return { lines, cursorLine, cursorCol: cursorCol + item.value.length };
		},
	};
}
