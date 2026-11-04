import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, saveConfig, validateKeyword } from "../src/config.ts";

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
