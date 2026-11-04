# pi-obsidian

A pi extension for human-assisted Obsidian references. Type a vault chain in the prompt and navigate files, folders, tags, and headings with autocomplete. On submit, pi gives the agent the resolved vault and file paths. Selecting an existing heading also includes that section's Markdown.

The surrounding instruction tells the agent what to do: read, summarize, or write. The extension does not interpret that instruction or write notes. The agent uses the bundled Obsidian skill for reads and writes.

## TODO

- [ ] Perhaps we could use a skill or another method to create a file-writing template.

## Requirements

- pi 1.5 or later
- Obsidian running with its CLI enabled and available as `obsidian`
- Node.js 22.19 or later for development

## Install

```sh
pi install https://github.com/Kovaxs/obsidian_pi
```

Run `/obsidian-setup`, choose a vault, and choose a keyword such as `obs`. The command writes `~/.config/pi-obsidian/config.json` (respecting `XDG_CONFIG_HOME`):

```json
{
  "vaults": {
    "obs": {
      "vault": "external_brain",
      "excludeFolders": ["Fleeting Notes", "Archive/Private"]
    },
    "work": { "vault": "work_vault" }
  }
}
```

Keywords may contain letters, numbers, `_`, and `-`. Multiple keywords can point to one vault; they share its index and watcher.

## Skill

The package also ships the `obsidian` skill (`skills/obsidian/SKILL.md`), declared under `pi.skills`, so installing the package makes the skill available to the agent. It teaches the agent to use the `obsidian` CLI for vault reads, writes, and handoff notes between sessions, and resolves the vault from the pi-obsidian config, the active vault, or an explicit request rather than a hardcoded path. Force it with `/skill:obsidian`.

### Excluded folders

The optional `excludeFolders` list hides a folder and all its descendants from file, tag, and heading suggestions, prompt expansion (including explicitly typed references), and new destination references. Omit it or use `[]` to include every folder.

Paths are relative to the vault root and case-sensitive. Use `Fleeting Notes` for the root folder or `Projects/Fleeting Notes` for a nested folder. `Fleeting Notes` does not hide `Fleeting Notes Archive` or a note named `Fleeting Notes.md`. These are literal folder paths, not glob patterns. Absolute paths and `..` are rejected; trailing slashes and a leading `./` are accepted.

Exclusions apply per keyword, so another keyword for the same vault can use a different list. The shared disk cache still contains metadata for the entire vault; this is a navigation filter, not a filesystem security boundary. `/obsidian-setup` preserves an existing keyword's exclusions. After editing the config, run `/reload` or restart pi.

## Reference syntax

```text
@@obs+python,docker@"uv dockerfile","other note"#Setup##Install
```

Every stage is optional:

- `+python,docker` requires both tags. `+python` also matches `python/uv`. After a parent tag, type `/` for its direct children. `▸` marks tags with children.
- `@"docker/uv dockerfile"` selects a note by vault-relative path. While typing, names and paths are fuzzy-matched; completion inserts the full path without `.md` to distinguish duplicate note names. Manually typed names are also accepted; an exact vault-relative path takes precedence over basename matches. Separate several names with commas.
- `@"Projects/Folder name"` references an existing folder by vault-relative path, including empty folders. Completion inserts a trailing `/` to identify it as a folder. An exact note path takes precedence over a same-named folder unless the reference ends with `/`.
- `#Setup##Install` selects a heading path. Hash count is tree depth, not the Markdown H1/H2 level, so skipped heading levels work.

A space outside double quotes ends a chain. Completion quotes names containing spaces or grammar characters. Tab reopens completion after a quoted name. Immediately after `#`, Tab shows the whole heading tree with indentation and inserts the full path to the selected heading.

Examples:

```text
Summarize @@obs@"project plan"
Create a note inside @@obs@"Projects/Folder name/"
Compare @@obs+python,docker
Use the install steps in @@obs@"uv dockerfile"#Setup##Install
```

A chain with no file stage can select many notes. A bare `@@obs` returns paths for every visible note, not their contents.

## Resolved references and section context

Each block includes the original chain, configured vault name, vault root, vault-relative path, absolute path, and whether the note or folder was found in the index. Note paths include `.md`; folder paths do not gain an extension.

- **Folder:** includes only the folder's path metadata, without listing or reading its notes. Tag and heading stages cannot select folders. Folder references can be combined with note references using commas.
- **File only:** includes path metadata, without reading or inserting the note's content. The agent can read it through the Obsidian skill.
- **Existing heading:** also includes its 1-based line number, Markdown heading level, and section content. The content includes the selected heading and stops before the next heading of the same or higher Markdown level.
- **New note or missing heading:** preserves the explicit destination and marks it as not found in the index. It does not read unrelated content, create anything, or treat the reference as permission to write.

For a new destination, type its vault-relative path; `.md` is added if omitted. Absolute paths, `..`, unknown folder paths ending with `/`, and destinations in excluded folders are rejected. Existing folders resolve as folders; unknown names without a trailing `/` still resolve as new note destinations. Tags only filter existing notes; a missing note cannot satisfy a tag filter. Unknown vault keywords, malformed chains, and failed searches remain unchanged and produce an error notice.

Selected section content is capped at **50,000 UTF-8 bytes per note**. The complete reference blocks, including metadata, are capped at **100,000 bytes per chain**. Truncation adds an explicit marker. Index status and heading locations describe the cached index; the skill should check the current note before writing.

## Cache and refresh

Indexes contain folder paths (including empty folders), note paths, modification times, inline and frontmatter tags, and heading positions. They are stored at `~/.cache/pi-obsidian/<vault>.json` (respecting `XDG_CACHE_HOME`) and written atomically.

Cached data is available immediately. Startup refreshes it in the background, and a recursive vault watcher batches changes for 250 ms before rebuilding through `obsidian eval`. If Obsidian is unavailable, the last cache remains usable and pi shows a warning. Older caches without folder metadata are rebuilt on the next successful refresh. If metadata predates a file modification, the extension retries once.

## Read and write instructions

Use ordinary prompts with the same reference syntax:

```text
Read @@obs@"Projects/New idea"
Read @@obs@"Projects/New idea"#Title
Write to @@obs@"Projects/New idea"#Title under an H2 heading "Second title"
```

The first prompt supplies the file path for the agent to read. The second also brings the existing `Title` section into context. The third supplies the destination and any existing section content; the agent uses the Obsidian skill to carry out the write. The note or heading may be new.

There are no note-saving or note-creation commands in this extension.

## Development

```sh
npm install --ignore-scripts
npm run check
node --test test/*.test.ts
```

Runtime code imports only Node built-ins and host-provided pi packages. Tests use the Node test runner with fake CLI executors; they do not require a live vault or write to one.
