export interface TagSegment {
	kind: "tags";
	tags: string[];
}

export interface FileSegment {
	kind: "files";
	files: string[];
}

export interface SectionSegment {
	kind: "section";
	path: string[];
}

export type Segment = TagSegment | FileSegment | SectionSegment;

export interface Chain {
	keyword: string;
	segments: Segment[];
}

export interface ChainSpan {
	raw: string;
	start: number;
	end: number;
}

/** Parses a complete @@vault chain, rejecting incomplete names and stage ordering. */
export function parseChain(raw: string): Chain {
	return parse(raw, false);
}

/** Parses the chain currently being typed, retaining empty partial names. */
export function parsePartialChain(raw: string): Chain {
	return parse(raw, true);
}

/** Finds whitespace-delimited chains while allowing spaces inside quoted names. */
export function findChainSpans(text: string): ChainSpan[] {
	const spans: ChainSpan[] = [];
	let start = -1;
	let quoted = false;
	let escaped = false;

	for (let index = 0; index <= text.length; index += 1) {
		const character = text[index];
		if (start < 0) {
			if (character === "@" && text[index + 1] === "@") start = index;
			continue;
		}

		if (escaped) {
			escaped = false;
			continue;
		}
		if (quoted && character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (character === undefined || (!quoted && /\s/.test(character))) {
			spans.push({ raw: text.slice(start, index), start, end: index });
			start = -1;
			quoted = false;
			if (character === "@" && text[index + 1] === "@") start = index;
		}
	}
	return spans;
}

/** Quotes and escapes a file or section name when the chain grammar requires it. */
export function formatName(name: string): string {
	if (name && !/[\s",#@+\\]/.test(name)) return name;
	return JSON.stringify(name);
}

function parse(raw: string, partial: boolean): Chain {
	if (!raw.startsWith("@@")) throw new Error("A vault chain must start with @@");
	let position = 2;
	while (position < raw.length && !"+@#".includes(raw[position] ?? "")) position += 1;
	const keyword = raw.slice(2, position);
	if (!keyword) throw new Error("Missing vault keyword after @@");
	const segments: Segment[] = [];
	let lastStage = -1;

	while (position < raw.length) {
		const marker = raw[position];
		if (marker === "+") {
			if (lastStage >= 0) throw new Error("Tags must precede files and sections");
			const end = findUnquotedStageEnd(raw, position + 1);
			const value = raw.slice(position + 1, end);
			const tags = value.split(",");
			if (!partial && tags.some((tag) => !tag)) throw new Error("Empty tag in chain");
			segments.push({ kind: "tags", tags });
			position = end;
			lastStage = 0;
			continue;
		}
		if (marker === "@") {
			if (lastStage >= 1) throw new Error("Only one file stage is allowed");
			position += 1;
			const files: string[] = [];
			while (position < raw.length) {
				const parsed = partial ? readPartialName(raw, position, ",#+@") : readName(raw, position, ",#+@");
				if (!partial && !parsed.value) throw new Error("Empty file name in chain");
				files.push(parsed.value);
				position = parsed.position;
				if (raw[position] !== ",") break;
				position += 1;
				if (position === raw.length) {
					if (!partial) throw new Error("Missing file name after comma");
					files.push("");
					break;
				}
			}
			if (!partial && files.length === 0) throw new Error("Missing file name after @");
			segments.push({ kind: "files", files });
			lastStage = 1;
			continue;
		}
		if (marker === "#") {
			if (lastStage >= 2) throw new Error("Only one section stage is allowed");
			const path: string[] = [];
			let previousDepth = 0;
			while (raw[position] === "#") {
				let depth = 0;
				while (raw[position] === "#") {
					depth += 1;
					position += 1;
				}
				if (!partial && depth !== previousDepth + 1) {
					throw new Error("Section depth must increase one level at a time");
				}
				const parsed = partial ? readPartialName(raw, position, "#") : readName(raw, position, "#");
				if (!partial && !parsed.value) throw new Error("Empty section name in chain");
				path.push(parsed.value);
				position = parsed.position;
				previousDepth = depth;
			}
			segments.push({ kind: "section", path });
			lastStage = 2;
			continue;
		}
		if (/\s/.test(marker ?? "")) throw new Error("Unquoted spaces end a vault chain");
		throw new Error(`Unexpected character in vault chain: ${marker}`);
	}

	return { keyword, segments };
}

function findUnquotedStageEnd(raw: string, start: number): number {
	let position = start;
	while (position < raw.length && !"@#".includes(raw[position] ?? "")) {
		if (/\s/.test(raw[position] ?? "")) break;
		position += 1;
	}
	return position;
}

function readName(raw: string, start: number, terminators: string): { value: string; position: number } {
	if (raw[start] === '"') return readQuotedName(raw, start, false);
	let position = start;
	while (position < raw.length && !terminators.includes(raw[position] ?? "") && !/\s/.test(raw[position] ?? "")) {
		position += 1;
	}
	return { value: raw.slice(start, position), position };
}

function readPartialName(raw: string, start: number, terminators: string): { value: string; position: number } {
	if (raw[start] === '"') return readQuotedName(raw, start, true);
	return readName(raw, start, terminators);
}

function readQuotedName(raw: string, start: number, partial: boolean): { value: string; position: number } {
	let value = "";
	let position = start + 1;
	while (position < raw.length) {
		const character = raw[position] ?? "";
		if (character === '"') return { value, position: position + 1 };
		if (character === "\\") {
			const escaped = raw[position + 1];
			if (escaped === undefined) {
				if (!partial) throw new Error("Unclosed escape in quoted name");
				value += "\\";
				position += 1;
				continue;
			}
			const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
			value += escapes[escaped] ?? escaped;
			position += 2;
			continue;
		}
		value += character;
		position += 1;
	}
	if (!partial) throw new Error("Unclosed quote in vault chain");
	return { value, position };
}
