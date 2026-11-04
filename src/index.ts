import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createObsidianAutocomplete } from "./autocomplete.ts";
import { loadConfig, saveConfig, validateKeyword } from "./config.ts";
import { expandPrompt } from "./expand.ts";
import { ObsidianCli } from "./obsidian-cli.ts";
import { VaultIndexStore } from "./vault-index.ts";

export default function (pi: ExtensionAPI): void {
	const cli = new ObsidianCli((command, args, options) => pi.exec(command, args, options));
	const stores = new Map<string, VaultIndexStore>();
	const storesByVault = new Map<string, VaultIndexStore>();

	async function registerVault(keyword: string, vault: string, ctx: ExtensionContext): Promise<void> {
		let store = storesByVault.get(vault);
		if (!store) {
			store = new VaultIndexStore(cli, vault, {
				onError: (error) => {
					if (ctx.hasUI) ctx.ui.notify(error.message, "warning");
				},
			});
			storesByVault.set(vault, store);
			await store.loadCache();
			store.start();
		}
		stores.set(keyword, store);
	}

	pi.registerCommand("obsidian-setup", {
		description: "Map a keyword to an Obsidian vault",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("Obsidian setup requires interactive UI", "error");
				return;
			}
			try {
				const vaults = await cli.listVaults();
				if (vaults.length === 0) {
					ctx.ui.notify("No Obsidian vaults found", "error");
					return;
				}
				const options = vaults.map((vault) => `${vault.name} — ${vault.path}`);
				const selected = await ctx.ui.select("Obsidian vault", options);
				if (!selected) return;
				const vault = vaults[options.indexOf(selected)];
				if (!vault) return;
				const keyword = args.trim() || (await ctx.ui.input("Keyword (used as @@keyword)", "obs"));
				if (!keyword) return;
				validateKeyword(keyword);
				const config = await loadConfig();
				config.vaults[keyword] = { vault: vault.name };
				await saveConfig(config);
				await registerVault(keyword, vault.name, ctx);
				ctx.ui.notify(`Mapped @@${keyword} to ${vault.name}`, "info");
			} catch (error) {
				ctx.ui.notify(`Obsidian setup failed: ${errorMessage(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) =>
			createObsidianAutocomplete(current, { getStore: (keyword) => stores.get(keyword) }),
		);
		try {
			const config = await loadConfig();
			await Promise.all(
				Object.entries(config.vaults).map(([keyword, entry]) => registerVault(keyword, entry.vault, ctx)),
			);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`Could not load pi-obsidian config: ${errorMessage(error)}`, "error");
		}
	});

	pi.on("session_shutdown", () => {
		for (const store of stores.values()) store.stop();
		stores.clear();
		storesByVault.clear();
	});

	pi.on("input", async (event, ctx) => {
		const result = await expandPrompt(
			event.text,
			{ getStore: (keyword) => stores.get(keyword) },
			cli,
		);
		if (ctx.hasUI) {
			for (const error of result.errors) ctx.ui.notify(`Obsidian: ${error}`, "error");
			for (const change of result.changes) {
				const suffix = change.truncated ? " (truncated)" : "";
				ctx.ui.notify(`Obsidian: expanded ${change.blocks} block(s) from ${change.files} note(s)${suffix}`, "info");
			}
		}
		if (result.changes.length === 0) return { action: "continue" };
		return { action: "transform", text: result.text, ...(event.images ? { images: event.images } : {}) };
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
