import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
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

async function fixture() {
	const cli = new ObsidianCli(async (_command, args) => {
		const stdout = args[0] === "vaults" ? "vault\t/vault\n" : `=> ${JSON.stringify(files)}\n`;
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
	return createObsidianAutocomplete(baseProvider(), { getStore: (keyword) => (keyword === "obs" ? store : undefined) });
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
