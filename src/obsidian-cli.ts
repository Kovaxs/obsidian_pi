import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { Heading, VaultFile, VaultIndex, VaultLocation } from "./types.ts";

export type Exec = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const COMMAND_TIMEOUT_MS = 10_000;

// Keep this script self-contained: Obsidian's eval context does not expose API helper globals.
const INDEX_SCRIPT = `JSON.stringify(app.vault.getMarkdownFiles().map(f=>{const c=app.metadataCache.getFileCache(f);const inline=(c?.tags||[]).map(t=>t.tag);const raw=c?.frontmatter?.tags??[];const front=(Array.isArray(raw)?raw:[raw]).flatMap(v=>String(v).split(",")).map(v=>v.trim()).filter(Boolean).map(v=>v.startsWith("#")?v:"#"+v);return {path:f.path,mtime:f.stat.mtime,tags:[...new Set([...inline,...front])],headings:(c?.headings||[]).map(h=>[h.level,h.heading,h.position.start.line])}}))`;

export class ObsidianCli {
	private readonly exec: Exec;
	private readonly vaultPaths = new Map<string, string>();

	constructor(exec: Exec) {
		this.exec = exec;
	}

	async listVaults(): Promise<VaultLocation[]> {
		const result = await this.run(["vaults", "verbose"]);
		const vaults: VaultLocation[] = [];
		for (const line of result.stdout.split("\n")) {
			if (!line.trim()) continue;
			const separator = line.indexOf("\t");
			if (separator <= 0) continue;
			const name = line.slice(0, separator).trim();
			const path = line.slice(separator + 1).trim();
			if (name && path) {
				vaults.push({ name, path });
				this.vaultPaths.set(name, path);
			}
		}
		return vaults;
	}

	async buildIndex(vault: string): Promise<VaultIndex> {
		const vaultPath = await this.getVaultPath(vault);
		const result = await this.runVault(vault, ["eval", `code=${INDEX_SCRIPT}`]);
		const files = parseIndexOutput(result.stdout);
		return { generatedAt: Date.now(), vault, vaultPath, files };
	}

	async readNote(vault: string, path: string): Promise<string> {
		const result = await this.runVault(vault, ["read", `path=${path}`]);
		return result.stdout;
	}

	async appendNote(vault: string, path: string, content: string, heading?: string): Promise<void> {
		const args = ["append", `path=${path}`, `content=${content}`];
		if (heading) args.push(`heading=${heading}`);
		await this.runVault(vault, args);
	}

	private async getVaultPath(vault: string): Promise<string> {
		const cached = this.vaultPaths.get(vault);
		if (cached) return cached;
		const vaults = await this.listVaults();
		const location = vaults.find((candidate) => candidate.name === vault);
		if (!location) throw new Error(`Obsidian vault not found: ${vault}`);
		return location.path;
	}

	private async runVault(vault: string, args: string[]): Promise<ExecResult> {
		return this.run([`vault=${vault}`, ...args]);
	}

	private async run(args: string[]): Promise<ExecResult> {
		const result = await this.exec("obsidian", args, { timeout: COMMAND_TIMEOUT_MS });
		if (result.code !== 0) {
			const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
			throw new Error(`obsidian ${args[0]} failed: ${detail}`);
		}
		return result;
	}
}

function parseIndexOutput(output: string): VaultFile[] {
	let text = output.trim();
	if (text.startsWith("=>")) text = text.slice(2).trim();
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error("Obsidian eval returned invalid JSON");
	}
	if (!Array.isArray(value)) throw new Error("Obsidian eval did not return a file list");
	return value.map(parseVaultFile);
}

function parseVaultFile(value: unknown): VaultFile {
	if (!isRecord(value)) throw new Error("Obsidian eval returned an invalid file entry");
	if (typeof value.path !== "string" || typeof value.mtime !== "number") {
		throw new Error("Obsidian eval returned a file without path or mtime");
	}
	if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === "string")) {
		throw new Error(`Invalid tags for ${value.path}`);
	}
	if (!Array.isArray(value.headings)) throw new Error(`Invalid headings for ${value.path}`);
	const headings = value.headings.map((heading): Heading => {
		if (
			!Array.isArray(heading) ||
			typeof heading[0] !== "number" ||
			typeof heading[1] !== "string" ||
			typeof heading[2] !== "number"
		) {
			throw new Error(`Invalid heading for ${value.path}`);
		}
		return [heading[0], heading[1], heading[2]];
	});
	return { path: value.path, mtime: value.mtime, tags: [...value.tags], headings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
