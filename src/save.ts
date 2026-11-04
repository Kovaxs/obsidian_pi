import { findChainSpans, parseChain } from "./chain.ts";
import { findHeadingNodes, runStages } from "./stages.ts";
import type { VaultFile, VaultIndex } from "./types.ts";

export interface SaveRequest {
	chain: string;
	draft?: string;
}

export interface SaveTarget {
	vault: string;
	file: VaultFile;
	sectionPath: string[];
}

/** Splits /obs-save arguments into one explicit target chain and optional draft text. */
export function parseSaveArguments(args: string): SaveRequest {
	const span = findChainSpans(args)[0];
	if (!span || span.start !== 0) throw new Error("Usage: /obs-save @@keyword@file[#Section] [text]");
	parseChain(span.raw);
	const draft = args.slice(span.end).trim();
	return { chain: span.raw, ...(draft ? { draft } : {}) };
}

/** Resolves a save chain, requiring exactly one explicitly named target note. */
export function resolveSaveTarget(index: VaultIndex, raw: string): SaveTarget {
	const chain = parseChain(raw);
	const fileStage = chain.segments.find((segment) => segment.kind === "files");
	if (!fileStage || fileStage.files.length !== 1 || !fileStage.files[0]) {
		throw new Error("The save target must name exactly one file with @");
	}
	const selection = runStages(index.files, chain.segments);
	if (selection.files.length !== 1 || !selection.files[0]) {
		throw new Error(`Expected one target note, found ${selection.files.length}`);
	}
	if (selection.sectionPath.length > 0 && findHeadingNodes(selection.files[0], selection.sectionPath).length === 0) {
		throw new Error(`Section "${selection.sectionPath.join(" > ")}" not found in ${selection.files[0].path}`);
	}
	return { vault: index.vault, file: selection.files[0], sectionPath: selection.sectionPath };
}
