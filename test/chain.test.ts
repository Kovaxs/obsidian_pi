import assert from "node:assert/strict";
import test from "node:test";
import { findChainSpans, formatName, parseChain, parsePartialChain } from "../src/chain.ts";

test("parses a full tag, file, and nested section chain", () => {
	assert.deepEqual(parseChain('@@obs+python,docker@"uv dockerfile","other note"#Setup##"Multi stage"'), {
		keyword: "obs",
		segments: [
			{ kind: "tags", tags: ["python", "docker"] },
			{ kind: "files", files: ["uv dockerfile", "other note"] },
			{ kind: "section", path: ["Setup", "Multi stage"] },
		],
	});
});

test("parses every optional stage combination", () => {
	assert.deepEqual(parseChain("@@obs"), { keyword: "obs", segments: [] });
	assert.deepEqual(parseChain("@@obs@uv").segments, [{ kind: "files", files: ["uv"] }]);
	assert.deepEqual(parseChain("@@obs+python#Usage").segments, [
		{ kind: "tags", tags: ["python"] },
		{ kind: "section", path: ["Usage"] },
	]);
});

test("parses escaped quotes in names and formats reserved characters", () => {
	const chain = parseChain('@@obs@"a \\"quoted\\" note"#"Section #1"');
	assert.deepEqual(chain.segments, [
		{ kind: "files", files: ['a "quoted" note'] },
		{ kind: "section", path: ["Section #1"] },
	]);
	assert.equal(formatName("plain"), "plain");
	assert.equal(formatName("two words"), '"two words"');
	assert.equal(formatName('a "quote"'), '"a \\"quote\\""');
});

test("retains partial names for autocomplete", () => {
	assert.deepEqual(parsePartialChain('@@obs+python,@"uv dock').segments, [
		{ kind: "tags", tags: ["python", ""] },
		{ kind: "files", files: ["uv dock"] },
	]);
});

test("finds multiple chains with spaces in quoted names", () => {
	assert.deepEqual(findChainSpans('Read @@obs@"uv dockerfile"#Setup and @@work+project, please.'), [
		{ raw: '@@obs@"uv dockerfile"#Setup', start: 5, end: 32 },
		{ raw: "@@work+project,", start: 37, end: 52 },
	]);
});

test("rejects malformed complete chains", () => {
	assert.throws(() => parseChain("@@obs@"), /file name/i);
	assert.throws(() => parseChain("@@obs##Child"), /depth/);
	assert.throws(() => parseChain("@@obs@file+tag"), /tags must precede/i);
	assert.throws(() => parseChain('@@obs@"unclosed'), /unclosed quote/i);
});
