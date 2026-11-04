import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
			assert.ok(args[2]?.includes("frontmatter"));
			return result(`=> ${JSON.stringify([fileEntry])}\n`);
		}
		return result("note text\n");
	});

	assert.deepEqual(await cli.listVaults(), [{ name: "external_brain", path: "/vault" }]);
	const index = await cli.buildIndex("external_brain");
	assert.equal(index.vaultPath, "/vault");
	assert.deepEqual(index.files[0], fileEntry);
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
			return result(`=> ${JSON.stringify([fileEntry])}\n`);
		});
		const store = new VaultIndexStore(cli, "vault", { cacheDir });
		const index = await store.refresh();
		const cached = JSON.parse(await readFile(join(cacheDir, "vault.json"), "utf8")) as VaultIndex;
		assert.equal(cached.vault, "vault");
		assert.equal(cached.files.length, 1);
		assert.equal(index.files[0]?.path, "note.md");

		const restored = new VaultIndexStore(cli, "vault", { cacheDir });
		await restored.loadCache();
		assert.equal(restored.index?.files[0]?.path, "note.md");
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
			return result(`=> ${JSON.stringify([{ ...fileEntry, mtime }])}\n`);
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

function result(stdout: string) {
	return { stdout, stderr: "", code: 0, killed: false, truncated: false };
}
