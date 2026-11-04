import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { findChainSpans, formatName, parsePartialChain, type Chain, type Segment } from "./chain.ts";
import {
	findHeadingNodes,
	flattenHeadingTree,
	noteName,
	runStages,
	suggestFiles,
	suggestTags,
	type Selection,
} from "./stages.ts";
import type { VaultIndexStore } from "./vault-index.ts";
import type { VaultFile } from "./types.ts";

const MAX_SUGGESTIONS = 30;

export interface AutocompleteVaults {
	getStore(keyword: string): VaultIndexStore | undefined;
}

/** Creates the stacked autocomplete provider for @@ vault chains. */
export function createObsidianAutocomplete(
	current: AutocompleteProvider,
	vaults: AutocompleteVaults,
): AutocompleteProvider {
	return {
		triggerCharacters: ["@", "#", "+"],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const span = findChainSpans((lines[cursorLine] ?? "").slice(0, cursorCol)).at(-1);
			if (!span || span.end !== cursorCol) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			let chain: Chain;
			try {
				chain = parsePartialChain(span.raw);
			} catch {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			const store = vaults.getStore(chain.keyword);
			if (!store) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const index = store.index;
			if (!index) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const items = getItems(chain, index.files, options.force === true).slice(0, MAX_SUGGESTIONS);
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return { prefix: span.raw, items };
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			const line = lines[cursorLine] ?? "";
			const start = cursorCol - prefix.length;
			if (start < 0 || line.slice(start, cursorCol) !== prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}
			const nextLines = [...lines];
			nextLines[cursorLine] = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
			return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function getItems(chain: Chain, files: VaultFile[], force: boolean): AutocompleteItem[] {
	const active = chain.segments.at(-1);
	if (!active) return fileItems({ files, sectionPath: [] }, "", chain);
	const completed = chain.segments.slice(0, -1);
	const previous = runStages(files, completed);

	if (active.kind === "tags") {
		const fragment = active.tags.at(-1) ?? "";
		const completedTags = active.tags.slice(0, -1);
		const selection = completedTags.length > 0 ? runStages(previous.files, [{ kind: "tags", tags: completedTags }]) : previous;
		return suggestTags(selection, fragment).map((tag) => {
			const tags = [...completedTags, tag.name];
			return {
				value: `${renderChain(chain.keyword, completed)}+${tags.join(",")}`,
				label: `${tag.name}${tag.hasChildren ? " ▸" : ""}`,
				description: `${tag.noteCount} note(s)${tag.hasChildren ? "; type / for children" : ""}`,
			};
		});
	}

	if (active.kind === "files") {
		const query = active.files.at(-1) ?? "";
		const completedFiles = active.files.slice(0, -1);
		return fileItems(previous, query, chain, completed, completedFiles);
	}

	const selection = runStages(previous.files, completed);
	const fragment = active.path.at(-1) ?? "";
	const parentPath = active.path.slice(0, -1);
	if (force && parentPath.length === 0 && fragment === "") return headingTreeItems(chain, completed, selection);
	const candidates = selection.files.flatMap((file) => {
		const parents = parentPath.length > 0 ? findHeadingNodes(file, parentPath) : findHeadingNodes(file, []);
		return parents.flatMap((parent) => (parentPath.length > 0 ? parent.children : [parent])).map((node) => ({ file, node }));
	});
	return candidates
		.filter(({ node }) => fuzzyTextMatch(fragment, node.heading[1]))
		.map(({ file, node }) => ({
			value: `${renderChain(chain.keyword, completed)}${renderSection([...parentPath, node.heading[1]])}`,
			label: node.heading[1],
			description: file.path,
		}));
}

function fileItems(
	selection: Selection,
	query: string,
	chain: Chain,
	completedSegments: Segment[] = chain.segments,
	completedFiles: string[] = [],
): AutocompleteItem[] {
	return suggestFiles(selection, query).map((file) => {
		const files = [...completedFiles, formatName(noteName(file.path))].join(",");
		return {
			value: `${renderChain(chain.keyword, completedSegments)}@${files}`,
			label: file.path.replace(/\.md$/, ""),
			description: `${file.tags.join(" ")}${file.headings.length > 0 ? ` · ${file.headings.length} headings` : ""}`,
		};
	});
}

function headingTreeItems(chain: Chain, completed: Segment[], selection: Selection): AutocompleteItem[] {
	return selection.files.flatMap((file) =>
		flattenHeadingTree(file).map((entry) => ({
			value: `${renderChain(chain.keyword, completed)}${renderSection(entry.path)}`,
			label: `${"  ".repeat(entry.path.length - 1)}${entry.node.heading[1]}`,
			description: file.path,
		})),
	);
}

function renderChain(keyword: string, segments: Segment[]): string {
	return `@@${keyword}${segments.map(renderSegment).join("")}`;
}

function renderSegment(segment: Segment): string {
	if (segment.kind === "tags") return `+${segment.tags.join(",")}`;
	if (segment.kind === "files") return `@${segment.files.map(formatName).join(",")}`;
	return renderSection(segment.path);
}

function renderSection(path: string[]): string {
	return path.map((name, index) => `${"#".repeat(index + 1)}${formatName(name)}`).join("");
}

function fuzzyTextMatch(query: string, text: string): boolean {
	let position = 0;
	const normalized = text.toLocaleLowerCase();
	for (const character of query.toLocaleLowerCase()) {
		position = normalized.indexOf(character, position);
		if (position < 0) return false;
		position += 1;
	}
	return true;
}
