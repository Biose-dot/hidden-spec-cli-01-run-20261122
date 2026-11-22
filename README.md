# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all four to one specification (`SPEC.md`):

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- the V4A patch format,
- text-editor tool calls as JSON.

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. Every path in a patch is relative to
it. `PATCH` is the path of the patch file, relative to the working directory; when
it is absent or is `-`, the patch is read from standard input.

`--format=NAME` reads the patch in one format (`unified`, `search-replace`, `v4a`,
`json`); `auto`, the default, detects it. `--check` does everything but write.
`--strict` matches lines exactly.

Lines an edit names are found at the first of three matching tiers: exact, then
ignoring trailing whitespace, then ignoring leading and trailing whitespace. Every
file is changed or nothing is: when any edit fails, no file is written, and every
failure is reported.

Node 22 and its standard library only; nothing is installed before the program runs.

## Files

- `main.ts` — the CLI.
- `runner.ts` — the kit's runner (kept as the kit has it).
- `check.ts` — runs `main.ts` on the kit's public practice checks.
- `SPEC.md` — the whole contract.
- `LICENSE` — MIT.

## Practice checks

    node check.ts <practice.json>

100 of 100 passed (practice score 1000).
