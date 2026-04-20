import { nanoid } from "nanoid";
import { ID_PREFIXES } from "./constants.js";

export type EntityType = keyof typeof ID_PREFIXES;

export function generateId(entity: EntityType): string {
  return ID_PREFIXES[entity] + nanoid(21);
}
