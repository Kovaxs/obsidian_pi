import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createObsidianAutocomplete } from "./autocomplete.ts";
import { expandPrompt } from "./expand.ts";
import { ObsidianCli } from "./obsidian-cli.ts";
import { VaultIndexStore } from "./vault-index.ts";

export default function (pi: ExtensionAPI): void {
	const cli = new ObsidianCli((command, args, options) => pi.exec(command, args, options));
	const stores = new Map<string, VaultIndexStore>();

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) =>
			createObsidianAutocomplete(current, { getStore: (keyword) => stores.get(keyword) }),
		);
	});

	pi.on("session_shutdown", () => {
		for (const store of stores.values()) store.stop();
		stores.clear();
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
