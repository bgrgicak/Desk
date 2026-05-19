<!--
Thanks for the PR. Keep this template; check off each box before
requesting review. See CONTRIBUTING.md for the rationale.
-->

## Summary

<!-- 1–3 sentences. What changed, and why. -->

## Test plan

<!-- How you verified the change. -->

- [ ] `npm run typecheck` clean
- [ ] `npm run test:host` clean
- [ ] Where applicable: `npm run ci:local` clean
- [ ]
- [ ]

## Reviewer checklist

The author should answer "yes" to each that applies. The reviewer
verifies in the diff.

- [ ] Test added for the new behaviour
- [ ] If a new route was added — auth-checked, ownership-checked,
      Zod-validated input, returns `{code, message, details?}` on error,
      rate-limited where bruteforce is possible
- [ ] If a sandbox env var was added — provider key reads logged to
      `provider_key_access_log`
- [ ] New external integration uses the generic connector store (no
      one-off table)
- [ ] No `console.*` in server source (`packages/server/**/src/`)
- [ ] No source file > 600 lines without a deliberate justification
- [ ] New form uses `react-hook-form` + Zod (when the pattern is
      established repo-wide)
- [ ] New `.unwrap()` call wrapped in a `.catch()` that surfaces the
      error to the user
- [ ] OpenAPI spec regenerated (`npm run openapi`) if any route added
      or changed
