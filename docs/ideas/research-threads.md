# Research threads (parked)

Status: idea only. Revisit after the core plugin (`docs/plan.md`) works.

## Problem

A research topic lives in Obsidian as a cluster of notes linked and tagged over days or weeks, for example `#research/pigsfood`. A new pi session starts with no memory of where the research stands. The user wants to load that cluster into the agent's context with one chain, so the agent knows the current stage.

## Measured data (vault `external_brain`, tag `#ai`, one `obsidian eval` call, 0.3 s)

- Seed notes carrying the tag: 15
- Links between seed notes: 16 (some are self-links from `[[own name]]` H1s; filter them)
- Linked notes without the tag: 7 (e.g. `Reference/Notes/DINO CFP article (a provisional name).md`)
- Notes outside the tag that link into it: 1
- Unresolved links: 8 (`PAPILA`, `CLIP alternatives`, `Representation Collapse`, ...). These are named topics with no note yet: research gaps.

The graph is cheap to build. The constraint is context size.

## Idea: layered loading

Layer 1, the map, always loaded (about 1-3k tokens): note list with dates and section names, links between notes, outside neighbours, unresolved links, open tasks, a timeline. No note text.

Layer 2, content within a token budget, in this order:
1. hub note
2. most connected notes
3. most recently changed notes
4. linked notes from outside the tag (only with explicit link depth)

Example map:

```
<obsidian_graph tag="#research/pigsfood" notes=12 links=31>
[1] Insect protein for pigs       2026-10-28  sections: Summary; Sources; Open questions
[2] Feed cost comparison          2026-10-30  sections: Table; Assumptions
links:      1->2,4  2->5  3->1
outside:    [13] FAO feed tables (linked from 1,2)
missing:    "Black soldier fly costs" (linked from 3)
open tasks: [3] - [ ] contact supplier
</obsidian_graph>
```

## Idea: hub note

The graph shows what exists, not what was concluded or what is next. One hub note per thread: tagged with the thread tag, property `type: hub`, sections Status / Findings / Open questions / Next steps.

Loop:
- End of session: `/obs-checkpoint` drafts a hub update; user edits and approves; written to Obsidian.
- Next session: `@@obs+research/pigsfood` loads the hub, the map, and as much other text as the budget allows.

## Candidate syntax

- `@@obs+research/pigsfood`: map + hub + text up to the budget.
- `@@obs+research/pigsfood~1`: also notes one link away from the tagged notes.
- Budget override per chain, e.g. `~1,20k`.
- Menu preview: `12 notes, 31 links, ~8k tokens` before submit.
- Display: collapsed in chat ("Loaded #research/pigsfood: 12 notes, ~8k tokens"), full text sent to the model.

## Open questions

1. Can the agent read more notes on its own from the graph, or does it ask the user to load them?
2. Is a hub-note convention needed, or is the most-linked note enough as hub?
3. Default budget: fixed in config (e.g. 10k tokens), or per chain?
4. Which other signals matter: open tasks, unresolved links, timeline, daily-note links?
