#!/usr/bin/env node
/**
 * Dumps the current OpenAPI spec to packages/server/docs/openapi.json.
 * Usage: npx tsx packages/server/api/src/scripts/dump-openapi.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { generateOpenApiSpec } from "../openapi.js";
import { withModule } from "@agent-desk/shared/logger";
const log = withModule("api/scripts/dump-openapi");

const spec = generateOpenApiSpec();
const outPath = path.resolve(import.meta.dirname, "../../../docs/openapi.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(spec, null, 2) + "\n");
log.info(`Written to ${outPath}`);
