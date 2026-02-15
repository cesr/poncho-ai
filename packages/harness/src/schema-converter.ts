import { z } from "zod";
import type { JsonSchema } from "@poncho-ai/sdk";

/**
 * Cache for converted schemas to avoid reprocessing
 */
const schemaCache = new WeakMap<JsonSchema, z.ZodType>();

/**
 * Converts a JSON Schema object to a Zod schema
 *
 * Supports:
 * - Primitives: string, number, integer, boolean, null
 * - Objects with properties
 * - Arrays
 * - Enums
 * - Required/optional fields
 * - Nested structures
 *
 * Falls back to z.any() for unsupported patterns
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodType {
  // Check cache first
  if (schemaCache.has(schema)) {
    return schemaCache.get(schema)!;
  }

  const zodSchema = convertSchema(schema);
  schemaCache.set(schema, zodSchema);
  return zodSchema;
}

function convertSchema(schema: JsonSchema): z.ZodType {
  // Handle enum
  if (schema.enum) {
    if (schema.enum.length === 0) {
      return z.never();
    }
    // Create enum from values
    const [first, ...rest] = schema.enum as [
      string | number | boolean | null,
      ...(string | number | boolean | null)[],
    ];
    return z.enum([String(first), ...rest.map(String)] as [string, ...string[]]);
  }

  // Handle by type
  switch (schema.type) {
    case "string":
      return z.string().describe(schema.description ?? "");

    case "number":
    case "integer": {
      let zodNumber = z.number();
      if (schema.type === "integer") {
        zodNumber = zodNumber.int();
      }
      if (typeof schema.minimum === "number") {
        zodNumber = zodNumber.min(schema.minimum);
      }
      if (typeof schema.maximum === "number") {
        zodNumber = zodNumber.max(schema.maximum);
      }
      return zodNumber.describe(schema.description ?? "");
    }

    case "boolean":
      return z.boolean().describe(schema.description ?? "");

    case "null":
      return z.null().describe(schema.description ?? "");

    case "array": {
      if (!schema.items) {
        return z.array(z.any()).describe(schema.description ?? "");
      }
      const itemSchema = convertSchema(schema.items);
      return z.array(itemSchema).describe(schema.description ?? "");
    }

    case "object": {
      if (!schema.properties) {
        return z.record(z.any()).describe(schema.description ?? "");
      }

      const shape: Record<string, z.ZodType> = {};
      const required = new Set(schema.required ?? []);

      for (const [key, propSchema] of Object.entries(schema.properties)) {
        let propZodSchema = convertSchema(propSchema);

        // Make optional if not in required list
        if (!required.has(key)) {
          propZodSchema = propZodSchema.optional();
        }

        shape[key] = propZodSchema;
      }

      return z.object(shape).describe(schema.description ?? "");
    }

    default:
      // Fallback for unsupported or missing type
      return z.any().describe(schema.description ?? "");
  }
}
