---
name: obsidian
description: Read, search, and write notes in the user's Obsidian vault through the Obsidian CLI. Use for any request about Obsidian, vault notes, research notes, finding notes on a topic, pulling a note or section into context, tags, properties, backlinks, tasks, daily notes, or saving findings to a note. Also use to share context or handoff notes between pi sessions or agents through the vault. Prefer codemode whenever a task needs several CLI calls or large outputs.
---

# Obsidian vault through the CLI

Use the `obsidian` CLI for all vault access. Do not read or edit the `.md` files directly unless the user asks.

## Find the vault

The CLI acts on the vault that Obsidian has open. Resolve which vault that should be, in this order:

1. The prompt or the pi-obsidian reference names one (`@@obs@"note"` carries the configured vault name and root).
2. `~/.config/pi-obsidian/config.json` (honouring `XDG_CONFIG_HOME`) maps keywords to vaults under `vaults.<keyword>.vault`.
3. `obsidian vault info=name` and `obsidian vault info=path` report the active vault; `obsidian vaults` lists them all.

If the target stays ambiguous across several vaults, ask the user before reading or writing. Read the paths from those sources at runtime; never assume a fixed location.

## Rules

1. **Codemode first.** If the `codemode` tool is available, use it for any task that needs more than one CLI call, any search across several queries, or any output that may be large. Call `tools.bash({ command })` inside the script, and return only the parts you need with `text()`. Use one plain `bash` call only for a single short command. If codemode is unavailable in this session, run the same commands with `bash`.
2. **Check options before writing.** The CLI silently treats unknown `key=value` arguments as content. Example: `obsidian append file="X" content=x total` appended a stray `x` to a real note. Confirm the option names with `obsidian --help`, grep for the command's block, and do a read-only check first.
3. **Errors can exit 0.** A missing file prints `Error: File "..." not found.` with exit code 0. Check the output text (`/^Error:/m`) rather than only the exit code. Redirect stderr with `2>/dev/null`, because Obsidian's Chromium prints GPU/vaapi/ozone noise to stderr.
4. **Writes need care.**
   - Read the note first and confirm the target.
   - Prefer `append`, `prepend`, `property:set`, and `create` for new files.
   - Do not use `create overwrite`, or write through `eval`, on an existing note without the user's OK.
   - Rename, move, or delete only when the user asked for it.
   - Read the note back after every write.
5. **Names change.** Notes get renamed, including by the user, between calls. Before a multi-step operation, confirm the exact name with `obsidian files ext=md` or `search`, and use the name that matches. Use `obsidian history:list` only as a hint, because it can list names that no longer exist.
6. **`obsidian eval code='...'`** runs JavaScript inside the Obsidian app (`app.vault`). Use it only when no command covers the need. Keep it read-only unless the user asked for the change.

## Command cheat sheet

Tested output formats are marked. An empty result may be plain text, such as `No backlinks found.`, so wrap `JSON.parse` in try/catch.

**Find and read**
- `search query="text" [path=folder] [limit=n] [format=json]`: returns a JSON array of file names (tested).
- `search:context query="text" [path=folder] [limit=n] format=json`: returns `[{file, matches:[{line, text}]}]` (tested). Best for research snippets.
- `read file="Note name"` or `path="folder/Note.md"`: returns full text including frontmatter (tested).
- `outline file="..." format=json`: returns `[{level, heading, line}]`, 1-based lines matching `read` output (tested).
- `properties file="..." format=json`: returns `{key: value}` (tested). `property:read name=x file=...` reads one value.
- `tags format=json counts sort=count`: returns `[{tag, count}]`, tags include `#` (tested). `tag name=x verbose` lists files for one tag.
- `backlinks file="..." format=json` and `links file="..."`: the note graph (backlinks tested, empty case is plain text).
- `unresolved`, `orphans`, `recents`, `files [folder=path]`, `file file="..."`: vault hygiene and listing.
- `tasks todo verbose [path=...]`, `daily:read`, `daily:path`: tasks and the daily note.
- `vault info=path`: returns the active vault's absolute path (tested); `vault info=name` returns its name.

**Write (confirm first, read back after)**
- `append file="..." content="..." [heading="Section"]`: has no `total` option. Use `inline` to avoid a leading newline.
- `prepend file="..." content="..."`.
- `property:set name=tags type=list value="a,b,c" file="..."`: tested. Creates frontmatter if missing.
- `create path="folder/New note.md" content="..."`: new files only. Pick a unique name rather than using `overwrite`.
- `rename file="Old" name="New"` and `move file="..." to="folder/"`: confirm first.
- `delete`: confirm first.

Quote values that contain spaces. Use `\n` for newlines in `content`.

## Codemode recipes

Base helper for every script:

```js
// @options: {"max_output_tokens": 4000, "timeout_ms": 120000}
const ob = (args) => tools.bash({ command: `obsidian ${args} 2>/dev/null`, timeout: 60 });
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const esc = (s) => String(s).replace(/"/g, '\\"');
```

**A. Research search across several topics, returning snippets only**
```js
const queries = ["anomaly detection", "time warp edit distance"];
const res = await Promise.allSettled(queries.map(q => ob(`search:context query="${esc(q)}" format=json limit=5`)));
const hits = [];
res.forEach((r, i) => {
  if (r.status !== "fulfilled") return;
  const data = parse(r.value.output);
  if (Array.isArray(data)) for (const f of data) hits.push({ q: queries[i], file: f.file, lines: f.matches.slice(0, 3) });
});
text(JSON.stringify(hits, null, 1).slice(0, 6000));
```

**B. Pull one section of a note into context**
```js
const F = "Research - Anomaly detection methods for irregularly sampled executions"; // current name; check with `obsidian files`
const want = "Isolation Forest";
const outline = parse((await ob(`outline file="${F}" format=json`)).output) || [];
const body = (await ob(`read file="${F}"`)).output.split("\n");
const h = outline.find(x => x.heading.includes(want));
if (!h) text("Heading not found. Available: " + outline.map(x => x.heading).join(" | "));
else {
  const next = outline.find(x => x.line > h.line && x.level <= h.level);
  text(body.slice(h.line - 1, next ? next.line - 1 : undefined).join("\n"));
}
```

**C. Note neighbourhood: outgoing links, backlinks, and tags in one call**
```js
const F = "Fix - snap apps fail with transient scope NoSuchUnit";
const [out, back, props] = await Promise.all([
  ob(`links file="${F}"`), ob(`backlinks file="${F}" format=json`), ob(`properties file="${F}" format=json`),
]);
text("LINKS:\n" + out.output.trim() + "\n\nBACKLINKS:\n" + back.output.trim() + "\n\nPROPERTIES:\n" + props.output.trim());
```

**D. Writes: shell-quote values, then run one at a time after the user confirms**
```js
const sh = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const F = "Some note";
const body = "Finding: ...\nSource: ...";                  // real newlines become \n
const cmd = `obsidian append file=${sh(F)} content=${sh(body.replace(/\n/g, "\\n"))}`;
// review cmd, then: const r = await tools.bash({ command: cmd + " 2>/dev/null" });
// then read the note back and confirm the new text is at the end.
```

## Shared context between sessions and agents

Use the vault as a shared store. Each writer uses its own note, so no two sessions overwrite each other.

- **Publish:** create a new note under `agent-inbox/` with a unique name, for example `agent-inbox/2026-11-04-1220-<topic>-<session>.md`. Then set `property:set name=tags type=list value="handoff,<topic>" file=...` and `status` (for example `open`).
- **Retrieve:** `search:context query="..." path=agent-inbox format=json`, or `tags counts` to see which topics exist. Load only the matching snippets or sections (recipe B).
- **Never** overwrite another session's note. Append only if the user asks to add to it.
- The `agent-inbox/` folder is a convention in this skill. Create it by creating its first note, and only when the user asks for handoff notes.

## Pi-specific notes

- This skill ships with the [pi-obsidian](https://github.com/Kovaxs/obsidian_pi) package and loads wherever that package is installed. Run `/reload` in a session that was already open to pick up edits.
- Obsidian must be running for the CLI to work. If a call hangs or fails, try a simple `obsidian vault info=name` first.
