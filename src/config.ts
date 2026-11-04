import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { VaultFile } from "./types.ts";

export interface VaultConfig {
	vault: string;
	excludeFolders?: string[];
}

export interface ObsidianConfig {
	vaults: Record<string, VaultConfig>;
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
		vaults[keyword] = parseVaultConfig(entry, keyword);
	}
	return { vaults };
}

/** Validates and atomically writes vault keyword mappings. */
export async function saveConfig(config: ObsidianConfig, path = defaultConfigPath()): Promise<void> {
	const vaults: ObsidianConfig["vaults"] = {};
	for (const [keyword, entry] of Object.entries(config.vaults)) {
		validateKeyword(keyword);
		vaults[keyword] = parseVaultConfig(entry, keyword);
	}
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temporary, `${JSON.stringify({ vaults }, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

export function validateKeyword(keyword: string): void {
	if (!/^[A-Za-z0-9_-]+$/.test(keyword)) throw new Error("Keywords may contain only letters, numbers, _ and -");
}

export function defaultConfigPath(): string {
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-obsidian", "config.json");
}

/** Removes notes inside configured vault-relative folders without changing the shared index. */
export function visibleFiles(files: VaultFile[], excludeFolders: string[] = []): VaultFile[] {
	if (excludeFolders.length === 0) return files;
	return files.filter((file) => !excludeFolders.some((folder) => file.path.startsWith(`${folder}/`)));
}

/** Removes excluded folders and their descendants from the folder inventory. */
export function visibleFolders(folders: string[], excludeFolders: string[] = []): string[] {
	if (excludeFolders.length === 0) return folders;
	return folders.filter((path) => !excludeFolders.some((folder) => path === folder || path.startsWith(`${folder}/`)));
}

function parseVaultConfig(value: unknown, keyword: string): VaultConfig {
	// Config JSON is user input, including when callers save a new mapping.
	if (!isRecord(value) || typeof value.vault !== "string" || !value.vault) {
		throw new Error(`Invalid vault mapping for "${keyword}"`);
	}
	if (value.excludeFolders === undefined) return { vault: value.vault };
	if (!Array.isArray(value.excludeFolders)) {
		throw new Error(`excludeFolders for "${keyword}" must be an array of vault-relative folder paths`);
	}
	const excludeFolders = value.excludeFolders.map((folder: unknown) => {
		if (typeof folder !== "string" || !folder.trim()) {
			throw new Error(`excludeFolders for "${keyword}" must contain non-empty folder paths`);
		}
		const path = folder.replace(/\\/g, "/");
		const normalized = posix.normalize(path).replace(/\/$/, "");
		if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..") || normalized === ".") {
			throw new Error(`Excluded folder "${folder}" must be relative to the vault and cannot contain ..`);
		}
		return normalized;
	});
	return { vault: value.vault, excludeFolders };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
