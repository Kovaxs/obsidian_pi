import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { Segment } from "./chain.ts";
import type { Heading, VaultFile } from "./types.ts";

export interface Selection {
	files: VaultFile[];
	sectionPath: string[];
}

export interface HeadingNode {
	heading: Heading;
	children: HeadingNode[];
}

export interface HeadingTreeEntry {
	path: string[];
	node: HeadingNode;
}

export interface TagSuggestion {
	name: string;
	hasChildren: boolean;
	noteCount: number;
}

/** Applies every chain segment in order to narrow the current note selection. */
export function runStages(files: VaultFile[], segments: Segment[]): Selection {
	let selection: Selection = { files, sectionPath: [] };
	for (const segment of segments) selection = narrow(selection, segment);
	return selection;
}

/** Narrows a selection with one tag, file, or section stage. */
export function narrow(selection: Selection, segment: Segment): Selection {
	if (segment.kind === "tags") {
		const tags = segment.tags.filter(Boolean).map(normalizeTag);
		return {
			...selection,
			files: selection.files.filter((file) =>
				tags.every((tag) => file.tags.some((candidate) => tagMatches(normalizeTag(candidate), tag))),
			),
		};
	}
	if (segment.kind === "files") {
		const names = new Set(segment.files.filter(Boolean).map((name) => name.toLocaleLowerCase()));
		return {
			...selection,
			files: selection.files.filter((file) => fileNames(file).some((name) => names.has(name.toLocaleLowerCase()))),
		};
	}
	return { ...selection, sectionPath: segment.path.filter(Boolean) };
}

/** Returns notes ordered by fzf-style fuzzy matching of their names and paths. */
export function suggestFiles(selection: Selection, query: string): VaultFile[] {
	if (!query) return [...selection.files].sort((a, b) => noteName(a.path).localeCompare(noteName(b.path)));
	return fuzzyFilter(selection.files, query, (file) => `${noteName(file.path)} ${file.path}`);
}

/** Suggests one tag level and reports child markers and matching note counts. */
export function suggestTags(selection: Selection, query: string): TagSuggestion[] {
	const separator = query.lastIndexOf("/");
	const parent = separator >= 0 ? query.slice(0, separator + 1) : "";
	const fragment = separator >= 0 ? query.slice(separator + 1) : query;
	const suggestions = new Map<string, { files: Set<string>; hasChildren: boolean }>();

	for (const file of selection.files) {
		for (const rawTag of file.tags) {
			const tag = normalizeTag(rawTag);
			if (!tag.startsWith(parent) || tag.length <= parent.length) continue;
			const child = tag.slice(parent.length).split("/")[0] ?? "";
			if (!child) continue;
			const name = `${parent}${child}`;
			const suggestion = suggestions.get(name) ?? { files: new Set<string>(), hasChildren: false };
			suggestion.files.add(file.path);
			if (tag.startsWith(`${name}/`)) suggestion.hasChildren = true;
			suggestions.set(name, suggestion);
		}
	}

	const values = [...suggestions.entries()].map(([name, value]) => ({
		name,
		hasChildren: value.hasChildren,
		noteCount: value.files.size,
	}));
	const filtered = fragment ? fuzzyFilter(values, fragment, (item) => item.name.slice(parent.length)) : values;
	return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

/** Builds the actual heading hierarchy, independent of skipped Markdown levels. */
export function buildHeadingTree(file: VaultFile): HeadingNode[] {
	const roots: HeadingNode[] = [];
	const stack: HeadingNode[] = [];
	for (const heading of file.headings) {
		const node: HeadingNode = { heading, children: [] };
		while ((stack.at(-1)?.heading[0] ?? 0) >= heading[0]) stack.pop();
		const parent = stack.at(-1);
		if (parent) parent.children.push(node);
		else roots.push(node);
		stack.push(node);
	}
	return roots;
}

/** Finds every heading matching a case-insensitive path in one note. */
export function findHeadingNodes(file: VaultFile, path: string[]): HeadingNode[] {
	let nodes = buildHeadingTree(file);
	let matches = nodes;
	for (const name of path) {
		matches = nodes.filter((node) => node.heading[1].toLocaleLowerCase() === name.toLocaleLowerCase());
		nodes = matches.flatMap((node) => node.children);
	}
	return matches;
}

/** Flattens a heading tree into selectable full paths, depth first. */
export function flattenHeadingTree(file: VaultFile): HeadingTreeEntry[] {
	const entries: HeadingTreeEntry[] = [];
	const visit = (nodes: HeadingNode[], parents: string[]): void => {
		for (const node of nodes) {
			const path = [...parents, node.heading[1]];
			entries.push({ path, node });
			visit(node.children, path);
		}
	};
	visit(buildHeadingTree(file), []);
	return entries;
}

export function noteName(path: string): string {
	const basename = path.split("/").at(-1) ?? path;
	return basename.endsWith(".md") ? basename.slice(0, -3) : basename;
}

function tagMatches(candidate: string, requested: string): boolean {
	return candidate === requested || candidate.startsWith(`${requested}/`);
}

function normalizeTag(tag: string): string {
	const withoutPrefix = tag.startsWith("#") ? tag.slice(1) : tag;
	return withoutPrefix.endsWith("/") ? withoutPrefix.slice(0, -1) : withoutPrefix;
}

function fileNames(file: VaultFile): string[] {
	const basename = file.path.split("/").at(-1) ?? file.path;
	return [noteName(file.path), basename, file.path, file.path.replace(/\.md$/, "")];
}
