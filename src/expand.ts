import { findChainSpans, parseChain } from "./chain.ts";
import type { ObsidianCli } from "./obsidian-cli.ts";
import { findHeadingNodes, runStages } from "./stages.ts";
import type { VaultIndexStore } from "./vault-index.ts";
import type { Heading, VaultFile } from "./types.ts";

export const DEFAULT_MAX_NOTE_BYTES = 50_000;
export const DEFAULT_MAX_CHAIN_BYTES = 100_000;

export interface VaultProvider {
	getStore(keyword: string): VaultIndexStore | undefined;
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

interface ExpansionBlock {
	path: string;
	section?: string;
	text: string;
}

/** Replaces every resolvable vault chain with its selected note content. */
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
	const selection = runStages(index.files, chain.segments);
	if (selection.files.length === 0) throw new Error("no notes match this chain");

	const maxNoteBytes = options.maxNoteBytes ?? DEFAULT_MAX_NOTE_BYTES;
	const maxChainBytes = options.maxChainBytes ?? DEFAULT_MAX_CHAIN_BYTES;
	let chainBytes = 0;
	let truncated = false;
	const rendered: string[] = [];

	outer: for (const file of selection.files) {
		const content = await cli.readNote(index.vault, file.path);
		let noteBytes = 0;
		for (const block of selectFileBlocks(file, content, selection.sectionPath)) {
			const header = renderHeader(raw, block);
			const endMarker = "\n[End Obsidian note]";
			const available = maxChainBytes - chainBytes - byteLength(header) - byteLength(endMarker);
			if (available <= 0 || noteBytes >= maxNoteBytes) {
				truncated = true;
				break outer;
			}
			const limit = Math.min(maxNoteBytes - noteBytes, available);
			const truncatedContent = truncateUtf8(block.text, limit);
			truncated ||= truncatedContent.truncated;
			noteBytes += byteLength(truncatedContent.text);
			const renderedBlock = `${header}${truncatedContent.text}${endMarker}`;
			rendered.push(renderedBlock);
			chainBytes += byteLength(renderedBlock);
			if (truncatedContent.truncated) break;
			if (chainBytes >= maxChainBytes) {
				truncated = true;
				break outer;
			}
		}
	}

	let text = rendered.join("\n\n");
	if (truncated) text += `\n\n[Obsidian expansion truncated: ${maxNoteBytes} bytes per note, ${maxChainBytes} bytes per chain]`;
	return { text, files: selection.files.length, blocks: rendered.length, truncated };
}

function selectFileBlocks(file: VaultFile, content: string, sectionPath: string[]): ExpansionBlock[] {
	if (sectionPath.length === 0) return [{ path: file.path, text: content.trimEnd() }];
	const matches = findHeadingNodes(file, sectionPath);
	if (matches.length === 0) throw new Error(`section "${sectionPath.join(" > ")}" not found in ${file.path}`);
	const lines = content.split("\n");
	return matches.map((match) => {
		const heading = match.heading;
		const end = findSectionEnd(file.headings, heading, lines.length);
		return {
			path: file.path,
			section: sectionPath.join(" > "),
			text: lines.slice(heading[2], end).join("\n").trimEnd(),
		};
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

function renderHeader(raw: string, block: ExpansionBlock): string {
	const section = block.section ? `\nSection: ${block.section}` : "";
	return `[Obsidian note]\nReference: ${raw}\nPath: ${block.path}${section}\n\n`;
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (byteLength(text) <= maxBytes) return { text, truncated: false };
	const encoded = new TextEncoder().encode(text);
	const truncated = new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes)));
	return { text: truncated, truncated: true };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
