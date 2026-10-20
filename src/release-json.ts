import { parseDocument } from "yaml";
import { ReleaseError } from "./release-error.ts";

type Schema = { type?: string; const?: unknown; enum?: unknown[]; oneOf?: Schema[]; required?: string[]; properties?: Record<string, Schema>; additionalProperties?: boolean; pattern?: string; minLength?: number; items?: Schema };
export function matchesSchema(schema: Schema, value: unknown): boolean {
  if (schema.oneOf) return schema.oneOf.filter((entry) => matchesSchema(entry, value)).length === 1;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "null") return value === null;
  if (schema.type === "string") return typeof value === "string" && value.length >= (schema.minLength ?? 0) && (!schema.pattern || new RegExp(schema.pattern, "u").test(value));
  if (schema.type === "array") return Array.isArray(value) && (!schema.items || value.every((entry) => matchesSchema(schema.items!, entry)));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return (schema.required ?? []).every((key) => Object.hasOwn(object, key)) && Object.entries(object).every(([key, entry]) => schema.properties?.[key] ? matchesSchema(schema.properties[key]!, entry) : schema.additionalProperties !== false);
  }
  return true;
}
export function parseReleaseJson(bytes: Uint8Array): unknown {
  try {
    if (bytes.byteLength > 256 * 1024) throw new Error("Release JSON exceeds 256 KiB");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    // JSON.parse alone accepts duplicate keys. YAML's JSON reader detects them.
    const document = parseDocument(text, { uniqueKeys: true, schema: "json" });
    if (document.errors.length) throw new Error("Release JSON contains duplicate or invalid keys");
    return value;
  } catch (error) {
    throw new ReleaseError("PLAN_INVALID", error instanceof Error ? error.message : "Invalid release JSON");
  }
}
