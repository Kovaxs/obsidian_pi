# pi-obsidian

A pi extension for user-directed Obsidian reads and writes. Type a vault chain in the prompt, navigate it with autocomplete, and pi replaces it with the referenced Markdown before the model sees the prompt.

The extension never registers a vault-writing agent tool. The only write path is the reviewed `/obs-save` command.

## Requirements

- pi 1.5 or later
- Obsidian running with its CLI enabled and available as `obsidian`
- Node.js 22.19 or later for development

## Install

```sh
pi install git:github.com/YOUR_USER/pi-obsidian
```

For a local checkout:

```sh
pi install /Users/kovaxs/workspace/obsidian_pi
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

### Excluded folders

The optional `excludeFolders` list hides a folder and all its descendants from file, tag, and heading suggestions, prompt expansion (including explicitly typed references), and `/obs-save`. Omit it or use `[]` to include every folder.

Paths are relative to the vault root and case-sensitive. Use `Fleeting Notes` for the root folder or `Projects/Fleeting Notes` for a nested folder. `Fleeting Notes` does not hide `Fleeting Notes Archive` or a note named `Fleeting Notes.md`. These are literal folder paths, not glob patterns. Absolute paths and `..` are rejected; trailing slashes and a leading `./` are accepted.

Exclusions apply per keyword, so another keyword for the same vault can use a different list. The shared disk cache still contains metadata for the entire vault; this is a navigation filter, not a filesystem security boundary. `/obsidian-setup` preserves an existing keyword's exclusions. After editing the config, run `/reload` or restart pi.

## Reference syntax

```text
@@obs+python,docker@"uv dockerfile","other note"#Setup##Install
```

Every stage is optional:

- `+python,docker` requires both tags. `+python` also matches `python/uv`. After a parent tag, type `/` for its direct children. `▸` marks tags with children.
- `@"uv dockerfile"` selects a note by exact name after completion. While typing, names and paths are fuzzy-matched. Separate several names with commas.
- `#Setup##Install` selects a heading path. Hash count is tree depth, not the Markdown H1/H2 level, so skipped heading levels work.

A space outside double quotes ends a chain. Completion quotes names containing spaces or grammar characters. Tab reopens completion after a quoted name. Immediately after `#`, Tab shows the whole heading tree with indentation and inserts the full path to the selected heading.

Examples:

```text
Summarize @@obs@"project plan"
Compare @@obs+python,docker
Use the install steps in @@obs@"uv dockerfile"#Setup##Install
```

A chain with no file stage can select many notes. A bare `@@obs` selects the entire vault; use it cautiously.

## Expansion format and limits

Each block includes the original chain, note path, optional section path, content, and an end marker. Sections include their heading and stop before the next heading of the same or higher Markdown level.

Expansion is capped at **50,000 UTF-8 bytes per note** and **100,000 bytes per chain**. Truncation adds an explicit marker. Unresolved or malformed chains remain unchanged and produce an error notice.

## Cache and refresh

Indexes contain note paths, modification times, inline and frontmatter tags, and heading positions. They are stored at `~/.cache/pi-obsidian/<vault>.json` (respecting `XDG_CACHE_HOME`) and written atomically.

Cached data is available immediately. Startup refreshes it in the background, and a recursive vault watcher batches changes for 250 ms before rebuilding through `obsidian eval`. If Obsidian is unavailable, the last cache remains usable and pi shows a warning. If metadata predates a file modification, the extension retries once.

## Reviewed writes

First ask the agent for a draft, then run:

```text
/obs-save @@obs@"note"#Section
```

The review editor opens with the latest assistant text. Edit it and submit, then confirm the exact vault, note, and section. To supply draft text directly:

```text
/obs-save @@obs@"note"#Section Text to append
```

The target must name exactly one existing note with `@`. Tags and a section may further qualify it. The command uses `obsidian append`; cancellation or a failed confirmation performs no write.

## Development

```sh
npm install --ignore-scripts
npm run check
node --test test/*.test.ts
```

Runtime code imports only Node built-ins and host-provided pi packages. Tests use the Node test runner with fake CLI executors; they do not require a live vault or write to one.
