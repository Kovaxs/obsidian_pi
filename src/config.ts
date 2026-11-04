import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ObsidianConfig {
	vaults: Record<string, { vault: string }>;
}

/** Loads vault keyword mappings, returning an empty config before setup. */
export async function loadConfig(path = defaultConfigPath()): Promise<ObsidianConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return { vaults: {} };
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`Invalid JSON in ${path}`);
	}
	if (!isRecord(value) || !isRecord(value.vaults)) throw new Error(`Invalid pi-obsidian config in ${path}`);
	const vaults: ObsidianConfig["vaults"] = {};
	for (const [keyword, entry] of Object.entries(value.vaults)) {
		validateKeyword(keyword);
		if (!isRecord(entry) || typeof entry.vault !== "string" || !entry.vault) {
			throw new Error(`Invalid vault mapping for "${keyword}" in ${path}`);
		}
		vaults[keyword] = { vault: entry.vault };
	}
	return { vaults };
}

/** Validates and atomically writes vault keyword mappings. */
export async function saveConfig(config: ObsidianConfig, path = defaultConfigPath()): Promise<void> {
	for (const [keyword, entry] of Object.entries(config.vaults)) {
		validateKeyword(keyword);
		if (!entry.vault) throw new Error(`Missing vault for "${keyword}"`);
	}
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

export function validateKeyword(keyword: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(keyword)) throw new Error("Keywords may contain only letters, numbers, _ and -");
}

export function defaultConfigPath(): string {
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-obsidian", "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
