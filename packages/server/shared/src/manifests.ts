import { z } from "zod";

/**
 * Memory-system spec, P4.1 — manifest schemas for `desk.app.json` and
 * `desk.fragment.json`.
 *
 * Both manifests now declare `description` and an optional `params`
 * schema so the discovery tool (`find_artifacts`, P4.6) can match on
 * them and the agent knows what to pass when embedding a fragment
 * inline (P4.7).
 *
 * `params` is a bespoke compact format keyed by param name; the value
 * is a string describing the type. A trailing `?` on the key marks the
 * param as optional. Example:
 *
 *   "params": {
 *     "note_id":   "string",
 *     "mode?":     "edit | view"
 *   }
 *
 * Why bespoke instead of JSON Schema:
 * - Agents read these manifests as part of their workflow; the compact
 *   form is dramatically less token-heavy than nested JSON Schema.
 * - Internally the agent can still wrap each entry as an enum-of-string
 *   when validation is required.
 */

// Param name is `name` or `name?`. Lowercase, digits, dashes, underscores.
const PARAM_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*\??$/;

const ParamsSchema = z
  .record(z.string(), z.string().min(1))
  .refine(
    (obj) => Object.keys(obj).every((k) => PARAM_NAME_PATTERN.test(k)),
    {
      message:
        "Param names must match /^[a-zA-Z][a-zA-Z0-9_-]*\\??$/ (a trailing '?' marks optional).",
    },
  );

export type ManifestParams = z.infer<typeof ParamsSchema>;

const APP_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const AppManifestSchema = z
  .object({
    name: z.string().regex(APP_NAME_PATTERN),
    displayName: z.string().optional(),
    description: z.string().min(1, "App description is required"),
    version: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    fragments: z.array(z.string()).optional(),
    params: ParamsSchema.optional(),
  })
  .strict();

export type AppManifest = z.infer<typeof AppManifestSchema>;

export const FragmentManifestSchema = z
  .object({
    name: z.string().regex(APP_NAME_PATTERN),
    description: z.string().min(1, "Fragment description is required"),
    capabilities: z.array(z.string()).optional(),
    params: ParamsSchema.optional(),
  })
  .strict();

export type FragmentManifest = z.infer<typeof FragmentManifestSchema>;

/**
 * Returns whether a param key marks an optional param. A trailing `?`
 * on the key is the optional marker.
 */
export function isOptionalParamKey(key: string): boolean {
  return key.endsWith("?");
}

/** Strips the trailing `?` from an optional param key. */
export function stripOptionalMarker(key: string): string {
  return key.endsWith("?") ? key.slice(0, -1) : key;
}
