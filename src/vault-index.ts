import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ObsidianCli } from "./obsidian-cli.ts";
import type { VaultIndex } from "./types.ts";

const WATCH_DEBOUNCE_MS = 250;
const METADATA_RETRY_DELAY_MS = 100;

export interface VaultIndexOptions {
	cacheDir?: string;
	onError?: (error: Error) => void;
}

/** Keeps one cached vault index fresh and shares it across keywords and sessions. */
export class VaultIndexStore {
	readonly vault: string;
	private readonly cli: ObsidianCli;
	private readonly cacheDir: string;
	private readonly onError: ((error: Error) => void) | undefined;
	private current?: VaultIndex;
	private watcher: FSWatcher | undefined;
	private debounce: NodeJS.Timeout | undefined;
	private refreshPromise: Promise<VaultIndex> | undefined;
	private refreshAgain = false;
	private lastErrorMessage: string | undefined;
	private stopped = false;

	constructor(cli: ObsidianCli, vault: string, options: VaultIndexOptions = {}) {
		this.cli = cli;
		this.vault = vault;
		this.cacheDir = options.cacheDir ?? defaultCacheDir();
		this.onError = options.onError;
	}

	get index(): VaultIndex | undefined {
		return this.current;
	}

	async loadCache(): Promise<void> {
		try {
			const text = await readFile(this.cachePath(), "utf8");
			const cached = parseCachedIndex(text, this.vault);
			if (!this.current || cached.generatedAt > this.current.generatedAt) this.current = cached;
			this.startWatcher();
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			this.reportError(new Error(`Could not load cached index for ${this.vault}: ${errorMessage(error)}`));
		}
	}

	async ensureIndex(): Promise<VaultIndex> {
		if (this.current) return this.current;
		return this.refresh();
	}

	refresh(): Promise<VaultIndex> {
		if (this.stopped) return Promise.reject(new Error(`Vault index is closed: ${this.vault}`));
		this.refreshAgain = true;
		this.refreshPromise ??= this.runRefreshLoop().finally(() => {
			this.refreshPromise = undefined;
		});
		return this.refreshPromise;
	}

	start(): void {
		this.stopped = false;
		void this.refresh().catch(() => {
			// The last cached index remains available; refresh reports the failure.
		});
	}

	stop(): void {
		this.stopped = true;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = undefined;
		this.watcher?.close();
		this.watcher = undefined;
	}

	private async runRefreshLoop(): Promise<VaultIndex> {
		let latest: VaultIndex | undefined;
		do {
			this.refreshAgain = false;
			try {
				latest = await this.buildFreshIndex();
				this.current = latest;
				await writeCache(this.cachePath(), latest);
				this.lastErrorMessage = undefined;
				this.startWatcher();
			} catch (error) {
				this.reportError(new Error(`Could not refresh Obsidian vault ${this.vault}: ${errorMessage(error)}`));
				if (this.current) return this.current;
				throw error;
			}
		} while (this.refreshAgain && !this.stopped);
		if (!latest) throw new Error(`No index available for ${this.vault}`);
		return latest;
	}

	private async buildFreshIndex(): Promise<VaultIndex> {
		let index = await this.cli.buildIndex(this.vault);
		if (index.files.some((file) => file.mtime > index.generatedAt)) {
			await delay(METADATA_RETRY_DELAY_MS);
			index = await this.cli.buildIndex(this.vault);
		}
		return index;
	}

	private startWatcher(): void {
		if (this.watcher || this.stopped || !this.current?.vaultPath) return;
		try {
			this.watcher = watch(this.current.vaultPath, { recursive: true }, (_event, filename) => {
				if (filename && !filename.toString().endsWith(".md")) return;
				this.scheduleRefresh();
			});
			this.watcher.on("error", (error) => {
				this.watcher?.close();
				this.watcher = undefined;
				this.reportError(new Error(`Could not watch Obsidian vault ${this.vault}: ${error.message}`));
			});
		} catch (error) {
			this.reportError(new Error(`Could not watch Obsidian vault ${this.vault}: ${errorMessage(error)}`));
		}
	}

	private scheduleRefresh(): void {
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => {
			this.debounce = undefined;
			void this.refresh().catch(() => {
				// Keep serving the cached index after a failed watcher refresh.
			});
		}, WATCH_DEBOUNCE_MS);
	}

	private reportError(error: Error): void {
		if (error.message === this.lastErrorMessage) return;
		this.lastErrorMessage = error.message;
		this.onError?.(error);
	}

	private cachePath(): string {
		return join(this.cacheDir, `${encodeURIComponent(this.vault)}.json`);
	}
}

async function writeCache(path: string, index: VaultIndex): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(temporary, `${JSON.stringify(index)}\n`, "utf8");
	await rename(temporary, path);
}

function parseCachedIndex(text: string, vault: string): VaultIndex {
	const value = JSON.parse(text) as Partial<VaultIndex>;
	if (
		value.vault !== vault ||
		typeof value.vaultPath !== "string" ||
		typeof value.generatedAt !== "number" ||
		!Array.isArray(value.files)
	) {
		throw new Error("invalid cache shape");
	}
	return value as VaultIndex;
}

function defaultCacheDir(): string {
	return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-obsidian");
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
