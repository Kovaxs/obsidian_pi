import assert from "node:assert/strict";
import test from "node:test";
import {
	buildHeadingTree,
	findHeadingNodes,
	flattenHeadingTree,
	noteName,
	runStages,
	suggestFiles,
	suggestTags,
} from "../src/stages.ts";
import type { VaultFile } from "../src/types.ts";

const files: VaultFile[] = [
	{
		path: "docker/uv dockerfile.md",
		mtime: 1,
		tags: ["#python/uv", "#docker"],
		headings: [
			[2, "Setup", 0],
			[4, "Install", 1],
			[3, "Multi stage build", 3],
			[2, "Usage", 5],
		],
	},
	{
		path: "docker/other note.md",
		mtime: 2,
		tags: ["#python", "#docker"],
		headings: [[1, "Setup", 0]],
	},
	{ path: "networking/dns.md", mtime: 3, tags: ["#networking/dns"], headings: [] },
];

test("tag stages require every tag and include child tags", () => {
	const python = runStages(files, [{ kind: "tags", tags: ["python"] }]);
	assert.deepEqual(python.files.map((file) => file.path), files.slice(0, 2).map((file) => file.path));
	const both = runStages(files, [{ kind: "tags", tags: ["python/uv", "docker"] }]);
	assert.deepEqual(both.files.map((file) => file.path), [files[0]?.path]);
});

test("file stages match exact names case-insensitively and accept multiple notes", () => {
	const selection = runStages(files, [{ kind: "files", files: ["UV DOCKERFILE", "other note"] }]);
	assert.equal(selection.files.length, 2);
	assert.equal(noteName(selection.files[0]?.path ?? ""), "uv dockerfile");
});

test("file suggestions use fuzzy tokens", () => {
	const suggestions = suggestFiles({ files, sectionPath: [] }, "uv dock");
	assert.equal(suggestions[0]?.path, "docker/uv dockerfile.md");
});

test("tag suggestions expose one child level and note counts", () => {
	const roots = suggestTags({ files, sectionPath: [] }, "");
	assert.deepEqual(roots.find((tag) => tag.name === "python"), { name: "python", hasChildren: true, noteCount: 2 });
	const children = suggestTags({ files, sectionPath: [] }, "networking/");
	assert.deepEqual(children, [{ name: "networking/dns", hasChildren: false, noteCount: 1 }]);
});

test("heading paths follow nesting depth rather than Markdown heading numbers", () => {
	const selection = runStages(files, [
		{ kind: "files", files: ["uv dockerfile"] },
		{ kind: "section", path: ["Setup", "Install"] },
	]);
	assert.deepEqual(selection.sectionPath, ["Setup", "Install"]);
	const matches = findHeadingNodes(selection.files[0] ?? files[0]!, selection.sectionPath);
	assert.equal(matches[0]?.heading[2], 1);
});

test("heading trees flatten to full paths in document order", () => {
	const tree = buildHeadingTree(files[0]!);
	assert.equal(tree[0]?.children.length, 2);
	assert.deepEqual(flattenHeadingTree(files[0]!).map((entry) => entry.path), [
		["Setup"],
		["Setup", "Install"],
		["Setup", "Multi stage build"],
		["Usage"],
	]);
});
