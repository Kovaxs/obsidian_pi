import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, saveConfig, validateKeyword, visibleFiles } from "../src/config.ts";
import type { VaultFile } from "../src/types.ts";

test("loads an empty config before setup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-obsidian-config-"));
	try {
		assert.deepEqual(await loadConfig(join(directory, "config.json")), { vaults: {} });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("atomically saves and reloads keyword mappings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-obsidian-config-"));
	const path = join(directory, "nested", "config.json");
	try {
		const config = { vaults: { obs: { vault: "external_brain" }, work: { vault: "work_vault" } } };
		await saveConfig(config, path);
		assert.deepEqual(await loadConfig(path), config);
		assert.match(await readFile(path, "utf8"), /external_brain/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("round-trips and normalizes excluded folders per keyword", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-obsidian-config-"));
	const path = join(directory, "config.json");
	try {
		await saveConfig({
			vaults: {
				obs: { vault: "external_brain", excludeFolders: ["./Fleeting Notes/", "Archive\\\\Private"] },
				all: { vault: "external_brain" },
			},
		}, path);
		assert.deepEqual(await loadConfig(path), {
			vaults: {
				obs: { vault: "external_brain", excludeFolders: ["Fleeting Notes", "Archive/Private"] },
				all: { vault: "external_brain" },
			},
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects malformed exclusion lists and paths outside the vault", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-obsidian-config-"));
	const path = join(directory, "config.json");
	try {
		for (const excludeFolders of ["Fleeting Notes", null, [1], [""], [" "], ["/private"], ["../private"], ["Notes/../private"], ["C:\\private"], ["."]]) {
			await writeFile(path, JSON.stringify({ vaults: { obs: { vault: "vault", excludeFolders } } }));
			await assert.rejects(() => loadConfig(path), /excludeFolders|Excluded folder/);
		}
		await assert.rejects(
			() => saveConfig({ vaults: { obs: { vault: "vault", excludeFolders: ["../private"] } } }, path),
			/Excluded folder/,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("excludes folder descendants without hiding similar names or changing the index", () => {
	const files: VaultFile[] = [
		"Fleeting Notes/note.md",
		"Fleeting Notes/deep/note.md",
		"Fleeting Notes Archive/note.md",
		"Projects/Fleeting Notes/note.md",
		"Fleeting Notes.md",
		"Archive/Private/note.md",
	].map((path) => ({ path, mtime: 1, tags: [], headings: [] }));
	assert.deepEqual(visibleFiles(files, ["Fleeting Notes", "Archive/Private"]).map((file) => file.path), [
		"Fleeting Notes Archive/note.md",
		"Projects/Fleeting Notes/note.md",
		"Fleeting Notes.md",
	]);
	assert.equal(files.length, 6);
	assert.equal(visibleFiles(files), files);
	assert.equal(visibleFiles(files, []), files);
});

test("validates keywords and rejects invalid mappings", async () => {
	assert.throws(() => validateKeyword("two words"), /Keywords/);
	assert.throws(() => validateKeyword(""), /Keywords/);
	const directory = await mkdtemp(join(tmpdir(), "pi-obsidian-config-"));
	const path = join(directory, "config.json");
	try {
		await saveConfig({ vaults: {} }, path);
		await writeFile(path, '{"vaults":{"obs":{}}}');
		await assert.rejects(() => loadConfig(path), /Invalid vault mapping/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
