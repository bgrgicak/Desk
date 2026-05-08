import { z } from "zod";

const MANIFEST_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const PARAM_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*\??$/;

const ParamsSchema = z
  .record(z.string(), z.string().min(1))
  .refine((obj) => Object.keys(obj).every((key) => PARAM_NAME_PATTERN.test(key)), {
    message: "Param names must start with a letter and may end with '?' to mark optional.",
  });

export type ManifestParams = z.infer<typeof ParamsSchema>;

export const AppManifestSchema = z
  .object({
    name: z.string().regex(MANIFEST_NAME_PATTERN),
    displayName: z.string().optional(),
    description: z.string().min(1, "App description is required"),
    version: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    fragments: z.array(z.string()).optional(),
    params: ParamsSchema.optional(),
  })
  .passthrough();

export type AppManifest = z.infer<typeof AppManifestSchema>;

export const FragmentManifestSchema = z
  .object({
    name: z.string().regex(MANIFEST_NAME_PATTERN),
    description: z.string().min(1, "Fragment description is required"),
    capabilities: z.array(z.string()).optional(),
    params: ParamsSchema.optional(),
  })
  .passthrough();

export type FragmentManifest = z.infer<typeof FragmentManifestSchema>;

export function isOptionalParamKey(key: string): boolean {
  return key.endsWith("?");
}

export function stripOptionalMarker(key: string): string {
  return key.endsWith("?") ? key.slice(0, -1) : key;
}
