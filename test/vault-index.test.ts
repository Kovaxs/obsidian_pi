import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ObsidianCli } from "../src/obsidian-cli.ts";
import { VaultIndexStore } from "../src/vault-index.ts";
import type { VaultFile, VaultIndex } from "../src/types.ts";

const fileEntry: VaultFile = {
	path: "note.md",
	mtime: 10,
	tags: ["#python", "#python/uv"],
	headings: [[1, "Note", 0]],
};

test("ObsidianCli builds an index and reads notes with explicit vault arguments", async () => {
	const calls: string[][] = [];
	const cli = new ObsidianCli(async (_command, args) => {
		calls.push(args);
		if (args[0] === "vaults") {
			return result("external_brain\t/vault\n");
		}
		if (args[1] === "eval") {
			const code = args[2]?.slice("code=".length);
			assert.ok(code);
			const output: unknown = runInNewContext(code, {
				app: {
					vault: {
						getAllFolders: () => [{ path: "/" }, { path: "Empty folder" }, { path: "Projects" }],
						getMarkdownFiles: () => [{ path: fileEntry.path, stat: { mtime: fileEntry.mtime } }],
					},
					metadataCache: {
						getFileCache: () => ({
							frontmatter: { tags: ["python", "python/uv"] },
							headings: [{ level: 1, heading: "Note", position: { start: { line: 0 } } }],
						}),
					},
				},
			});
			assert.equal(typeof output, "string");
			return result(`=> ${output}\n`);
		}
		return result("note text\n");
	});

	assert.deepEqual(await cli.listVaults(), [{ name: "external_brain", path: "/vault" }]);
	const index = await cli.buildIndex("external_brain");
	assert.equal(index.vaultPath, "/vault");
	assert.deepEqual(index.files[0], fileEntry);
	assert.deepEqual(index.folders, ["Empty folder", "Projects"]);
	assert.equal(await cli.readNote("external_brain", "note.md"), "note text\n");
	assert.deepEqual(calls[2], ["vault=external_brain", "read", "path=note.md"]);
});

test("ObsidianCli reports CLI stderr", async () => {
	const cli = new ObsidianCli(async () => ({ ...result(""), code: 1, stderr: "Obsidian is not running" }));
	await assert.rejects(() => cli.buildIndex("missing"), /Obsidian is not running/);
});

test("VaultIndexStore writes an atomic cache and reloads it", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "pi-obsidian-"));
	try {
		const cli = new ObsidianCli(async (_command, args) => {
			if (args[0] === "vaults") return result("vault\t/vault\n");
			return result(`=> ${JSON.stringify({ files: [fileEntry], folders: ["Empty folder"] })}\n`);
		});
		const store = new VaultIndexStore(cli, "vault", { cacheDir });
		const index = await store.refresh();
		const cached = JSON.parse(await readFile(join(cacheDir, "vault.json"), "utf8")) as VaultIndex;
		assert.equal(cached.vault, "vault");
		assert.equal(cached.files.length, 1);
		assert.deepEqual(cached.folders, ["Empty folder"]);
		assert.equal(index.files[0]?.path, "note.md");

		const restored = new VaultIndexStore(cli, "vault", { cacheDir });
		await restored.loadCache();
		assert.equal(restored.index?.files[0]?.path, "note.md");
		assert.deepEqual(restored.index?.folders, ["Empty folder"]);
		restored.stop();
		store.stop();
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});

test("VaultIndexStore retries when file mtimes are newer than metadata", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "pi-obsidian-"));
	try {
		let builds = 0;
		const cli = new ObsidianCli(async (_command, args) => {
			if (args[0] === "vaults") return result("vault\t/vault\n");
			builds += 1;
			const mtime = builds === 1 ? Date.now() + 5_000 : 10;
			return result(`=> ${JSON.stringify({ files: [{ ...fileEntry, mtime }], folders: [] })}\n`);
		});
		const store = new VaultIndexStore(cli, "vault", { cacheDir });
		await store.refresh();
		assert.equal(builds, 2);
		store.stop();
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});

test("VaultIndexStore serves the last cache when Obsidian is unavailable", async () => {
	const cacheDir = await mkdtemp(join(tmpdir(), "pi-obsidian-"));
	try {
		const cached: VaultIndex = {
			generatedAt: 1,
			vault: "vault",
			vaultPath: join(cacheDir, "missing-vault"),
			files: [fileEntry],
			folders: [],
		};
		await writeFile(join(cacheDir, "vault.json"), JSON.stringify(cached));
		let reported = "";
		const cli = new ObsidianCli(async () => {
			throw new Error("offline");
		});
		const store = new VaultIndexStore(cli, "vault", {
			cacheDir,
			onError: (error) => {
				reported = error.message;
			},
		});
		await store.loadCache();
		const index = await store.refresh();
		assert.equal(index.files[0]?.path, "note.md");
		assert.match(reported, /offline/);
		store.stop();
	} finally {
		await rm(cacheDir, { recursive: true, force: true });
	}
});

test("ObsidianCli rejects malformed folder inventories", async () => {
	for (const folders of [undefined, "Projects", [42]]) {
		const cli = new ObsidianCli(async (_command, args) => args[0] === "vaults"
			? result("vault\t/vault\n")
			: result(JSON.stringify({ files: [], folders })));
		await assert.rejects(() => cli.buildIndex("vault"), /folder list/);
	}
});

test("VaultIndexStore rebuilds a cache that lacks folder metadata", async (t) => {
	const cacheDir = await mkdtemp(join(tmpdir(), "pi-obsidian-old-cache-"));
	t.after(() => rm(cacheDir, { recursive: true, force: true }));
	await writeFile(join(cacheDir, "vault.json"), JSON.stringify({
		generatedAt: 1, vault: "vault", vaultPath: "/vault", files: [fileEntry],
	}));
	const cli = new ObsidianCli(async (_command, args) => args[0] === "vaults"
		? result("vault\t/vault\n")
		: result(JSON.stringify({ files: [fileEntry], folders: ["Empty"] })));
	const store = new VaultIndexStore(cli, "vault", { cacheDir });
	t.after(() => store.stop());
	await store.loadCache();
	assert.equal(store.index, undefined);
	assert.deepEqual((await store.ensureIndex()).folders, ["Empty"]);
});

test("VaultIndexStore refreshes after empty folder creation and removal", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-obsidian-watch-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const vaultPath = join(directory, "vault");
	await mkdir(vaultPath);
	let folders: string[] = [];
	let builds = 0;
	const cli = new ObsidianCli(async (_command, args) => {
		if (args[0] === "vaults") return result(`vault\t${vaultPath}\n`);
		builds += 1;
		return result(JSON.stringify({ files: [], folders }));
	});
	const store = new VaultIndexStore(cli, "vault", { cacheDir: join(directory, "cache") });
	t.after(() => store.stop());
	await store.refresh();
	folders = ["Empty"];
	await mkdir(join(vaultPath, "Empty"));
	await waitFor(() => builds >= 2 && store.index?.folders.includes("Empty") === true);
	const previousBuilds = builds;
	folders = [];
	await rm(join(vaultPath, "Empty"), { recursive: true });
	await waitFor(() => builds > previousBuilds && store.index?.folders.length === 0);
});

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for the vault watcher");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

function result(stdout: string) {
	return { stdout, stderr: "", code: 0, killed: false, truncated: false };
}
