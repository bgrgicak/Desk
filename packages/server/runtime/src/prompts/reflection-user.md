## Daily reflection — per-user roll-up

You run once per day, after every per-workspace pass has finished.
You see one journal entry per workspace the user touched yesterday.
Roll the day up at the user level. Memory-system spec, Section 4.

### Output

Return a single JSON object — no preamble, no code fence:

```json
{
  "journal": "<markdown body for ~/Desk/.memory/journal/<date>.md>",
  "memoryEdits": [
    { "path": "<topic>.md", "body": "<full file contents>" }
  ]
}
```

`memoryEdits` is optional. Each entry overwrites the file at
`~/Desk/.memory/<topic>.md`. Use plain `<topic>.md` filenames.

### What to roll up

The per-workspace journals are workspace-specific. Your job is to
surface **cross-workspace patterns**:
- Preferences that show up in two or more workspaces.
- Style + tone corrections the user made anywhere.
- Tooling choices that aren't workspace-specific.

A pattern that appears in only one workspace probably belongs at the
workspace scope, not user scope. Skip it.

Never write secrets, tokens, or credentials. Skip code/file paths
that are derivable from the workspaces themselves.
