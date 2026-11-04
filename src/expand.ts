import { join, posix } from "node:path";
import { findChainSpans, parseChain, type Chain } from "./chain.ts";
import { visibleFiles, visibleFolders } from "./config.ts";
import type { ObsidianCli } from "./obsidian-cli.ts";
import { findHeadingNodes, runStages } from "./stages.ts";
import type { VaultIndexStore } from "./vault-index.ts";
import type { Heading, VaultFile, VaultIndex } from "./types.ts";

export const DEFAULT_MAX_NOTE_BYTES = 50_000;
export const DEFAULT_MAX_CHAIN_BYTES = 100_000;

export interface VaultProvider {
	getStore(keyword: string): VaultIndexStore | undefined;
	getExcludedFolders(keyword: string): string[] | undefined;
}

export interface ExpansionChange {
	chain: string;
	files: number;
	blocks: number;
	truncated: boolean;
}

export interface ExpansionResult {
	text: string;
	changes: ExpansionChange[];
	errors: string[];
}

export interface ExpansionOptions {
	maxNoteBytes?: number;
	maxChainBytes?: number;
}

type PathReference =
	| { kind: "existing"; file: VaultFile; path: string }
	| { kind: "new"; path: string }
	| { kind: "folder"; path: string };

interface ExpansionBlock {
	reference: PathReference;
	sectionPath: string[];
	heading?: Heading;
	text?: string;
}

/** Resolves chains to note or folder paths, including content only for existing selected sections. */
export async function expandPrompt(
	input: string,
	vaults: VaultProvider,
	cli: ObsidianCli,
	options: ExpansionOptions = {},
): Promise<ExpansionResult> {
	const spans = findChainSpans(input);
	const changes: ExpansionChange[] = [];
	const errors: string[] = [];
	if (spans.length === 0) return { text: input, changes, errors };

	let output = "";
	let previousEnd = 0;
	for (const span of spans) {
		output += input.slice(previousEnd, span.start);
		try {
			const expansion = await expandChain(span.raw, vaults, cli, options);
			output += expansion.text;
			changes.push({ chain: span.raw, files: expansion.files, blocks: expansion.blocks, truncated: expansion.truncated });
		} catch (error) {
			output += span.raw;
			errors.push(`${span.raw}: ${errorMessage(error)}`);
		}
		previousEnd = span.end;
	}
	output += input.slice(previousEnd);
	return { text: output, changes, errors };
}

async function expandChain(
	raw: string,
	vaults: VaultProvider,
	cli: ObsidianCli,
	options: ExpansionOptions,
): Promise<{ text: string; files: number; blocks: number; truncated: boolean }> {
	const chain = parseChain(raw);
	const store = vaults.getStore(chain.keyword);
	if (!store) throw new Error(`unknown vault keyword "${chain.keyword}"; run /obsidian-setup`);
	const index = await store.ensureIndex();
	const references = resolveReferences(index, chain, vaults.getExcludedFolders(chain.keyword));
	const sectionPath = chain.segments.find((segment) => segment.kind === "section")?.path ?? [];
	const maxNoteBytes = options.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES;
	const maxChainBytes = options.maxChainBytes ?? DEFAULT_MAX_CHAIN_BYTES;
	let chainBytes = 0;
	let truncated = false;
	const rendered: string[] = [];

	outer: for (const reference of references) {
		if (chainBytes >= maxChainBytes) {
			truncated = true;
			break;
		}
		const blocks = await selectFileBlocks(reference, sectionPath, index.vault, cli);
		let noteBytes = 0;
		for (const block of blocks) {
			const header = renderHeader(raw, index, block);
			const endMarker = `\n[End Obsidian ${reference.kind === "folder" ? "folder" : "note"}]`;
			const separator = rendered.length > 0 ? "\n\n" : "";
			const available = maxChainBytes - chainBytes - byteLength(separator + header + endMarker);
			if (available < 0 || (block.text !== undefined && noteBytes >= maxNoteBytes)) {
				truncated = true;
				break outer;
			}
			const limit = Math.min(maxNoteBytes - noteBytes, available);
			const truncatedContent = truncateUtf8(block.text ?? "", limit);
			truncated ||= truncatedContent.truncated;
			noteBytes += byteLength(truncatedContent.text);
			const renderedBlock = `${separator}${header}${truncatedContent.text}${endMarker}`;
			rendered.push(renderedBlock);
			chainBytes += byteLength(renderedBlock);
			if (truncatedContent.truncated) break;
		}
	}

	let text = rendered.join("");
	if (truncated) text += `\n\n[Obsidian expansion truncated: ${maxNoteBytes} content bytes per note, ${maxChainBytes} bytes per chain]`;
	return { text, files: references.length, blocks: rendered.length, truncated };
}

function resolveReferences(index: VaultIndex, chain: Chain, excludeFolders: string[] = []): PathReference[] {
	const fileStage = chain.segments.find((segment) => segment.kind === "files");
	if (!fileStage) {
		const selection = runStages(visibleFiles(index.files, excludeFolders), chain.segments);
		if (selection.files.length === 0) throw new Error("no notes match this chain");
		return selection.files.map((file) => ({ kind: "existing", file, path: file.path }));
	}

	const references = new Map<string, PathReference>();
	const tags = chain.segments.filter((segment) => segment.kind === "tags");
	const folders = visibleFolders(index.folders, excludeFolders);
	for (const name of fileStage.files) {
		const normalized = normalizeReferencePath(name);
		const folderPath = normalized.replace(/\/$/, "");
		const folder = index.folders.find((path) => path.toLocaleLowerCase() === folderPath.toLocaleLowerCase());
		const path = normalized.endsWith(".md") ? normalized : `${normalized}.md`;
		const matches = normalized.endsWith("/") ? [] : runStages(index.files, [{ kind: "files", files: [path] }]).files;
		const exactNote = matches.some((file) => file.path.toLocaleLowerCase() === path.toLocaleLowerCase());
		// Exact note paths win collisions, but basename matches must not hide a folder's full path.
		if (folder && !exactNote) {
			if (!folders.includes(folder)) throw new Error(`no notes match "${name}": folder is excluded`);
			if (tags.length > 0 || chain.segments.some((segment) => segment.kind === "section")) {
				throw new Error("folder references cannot select tags or headings; select a note instead");
			}
			references.set(`${folder}/`, { kind: "folder", path: folder });
		} else if (normalized.endsWith("/")) {
			throw new Error("folder paths must name an existing folder relative to the vault");
		} else if (matches.length > 0) {
			const selected = runStages(visibleFiles(matches, excludeFolders), tags).files;
			if (selected.length === 0) throw new Error(`no notes match "${name}" with these tags and folder exclusions`);
			for (const file of selected) references.set(file.path, { kind: "existing", file, path: file.path });
		} else {
			// Typed destinations are user input: keep them inside the vault and honor keyword exclusions.
			if (excludeFolders.some((folder) => path.startsWith(`${folder}/`))) {
				throw new Error(`no notes match "${name}": destination is in an excluded folder`);
			}
			if (tags.length > 0) throw new Error(`no notes match "${name}": a new destination cannot match tag filters`);
			references.set(path, { kind: "new", path });
		}
	}
	return [...references.values()];
}

function normalizeReferencePath(name: string): string {
	const path = name.replace(/\\/g, "/");
	const normalized = posix.normalize(path);
	// Unlike indexed paths, typed destinations have not passed through Obsidian's vault API.
	if (
		path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.split("/").includes("..") ||
		normalized === "." || posix.basename(normalized) === ".md"
	) {
		throw new Error("paths must name a note or folder relative to the vault and cannot contain ..");
	}
	return normalized;
}

async function selectFileBlocks(
	reference: PathReference,
	sectionPath: string[],
	vault: string,
	cli: ObsidianCli,
): Promise<ExpansionBlock[]> {
	if (reference.kind !== "existing" || sectionPath.length === 0) return [{ reference, sectionPath }];
	const file = reference.file;
	const matches = findHeadingNodes(file, sectionPath);
	if (matches.length === 0) return [{ reference, sectionPath }];
	const content = await cli.readNote(vault, file.path);
	const lines = content.split("\n");
	return matches.map((match) => {
		const heading = match.heading;
		const end = findSectionEnd(file.headings, heading, lines.length);
		return { reference, sectionPath, heading, text: lines.slice(heading[2], end).join("\n").trimEnd() };
	});
}

function findSectionEnd(headings: Heading[], selected: Heading, lineCount: number): number {
	const start = headings.indexOf(selected);
	for (let index = start + 1; index < headings.length; index += 1) {
		const heading = headings[index];
		if (heading && heading[0] <= selected[0]) return heading[2];
	}
	return lineCount;
}

function renderHeader(raw: string, index: VaultIndex, block: ExpansionBlock): string {
	const lines = [
		`[Obsidian ${block.reference.kind === "folder" ? "folder" : "note"}]`,
		`Reference: ${raw}`,
		`Vault: ${index.vault}`,
		`Vault path: ${index.vaultPath}`,
		`Path: ${block.reference.path}`,
		`Absolute path: ${join(index.vaultPath, block.reference.path)}`,
		block.reference.kind === "folder"
			? "Folder: found in index"
			: `Note: ${block.reference.kind === "existing" ? "found in index" : "not found in index (new destination)"}`,
	];
	if (block.sectionPath.length > 0) {
		lines.push(`Section: ${block.sectionPath.join(" > ")}`);
		if (block.heading) lines.push(`Line: ${block.heading[2] + 1}`, `Heading level: H${block.heading[0]}`);
		else lines.push("Section status: not found in index (intended heading path)");
	}
	lines.push(block.text === undefined ? "Content: not included" : "Content:");
	return `${lines.join("\n")}\n\n`;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (byteLength(text) <= maxBytes) return { text, truncated: false };
	const encoded = new TextEncoder().encode(text);
	const truncated = new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes)), { stream: true });
	return { text: truncated, truncated: true };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
