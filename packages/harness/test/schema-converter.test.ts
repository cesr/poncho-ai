import { describe, it, expect } from "vitest";
import { z } from "zod";
import { jsonSchemaToZod } from "../src/schema-converter.js";
import type { JsonSchema } from "@poncho-ai/sdk";

describe("jsonSchemaToZod", () => {
  describe("primitives", () => {
    it("converts string property", () => {
      const schema: JsonSchema = {
        type: "string",
        description: "A string value",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse("hello")).toBe("hello");
      expect(() => zodSchema.parse(123)).toThrow();
    });

    it("converts number property", () => {
      const schema: JsonSchema = {
        type: "number",
        description: "A number value",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(123)).toBe(123);
      expect(zodSchema.parse(123.45)).toBe(123.45);
      expect(() => zodSchema.parse("hello")).toThrow();
    });

    it("converts integer property", () => {
      const schema: JsonSchema = {
        type: "integer",
        description: "An integer value",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(123)).toBe(123);
      expect(() => zodSchema.parse(123.45)).toThrow();
      expect(() => zodSchema.parse("hello")).toThrow();
    });

    it("converts boolean property", () => {
      const schema: JsonSchema = {
        type: "boolean",
        description: "A boolean value",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(true)).toBe(true);
      expect(zodSchema.parse(false)).toBe(false);
      expect(() => zodSchema.parse("hello")).toThrow();
    });

    it("converts null property", () => {
      const schema: JsonSchema = {
        type: "null",
        description: "A null value",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(null)).toBe(null);
      expect(() => zodSchema.parse("hello")).toThrow();
    });
  });

  describe("number constraints", () => {
    it("converts number with minimum", () => {
      const schema: JsonSchema = {
        type: "number",
        minimum: 0,
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(0)).toBe(0);
      expect(zodSchema.parse(10)).toBe(10);
      expect(() => zodSchema.parse(-1)).toThrow();
    });

    it("converts number with maximum", () => {
      const schema: JsonSchema = {
        type: "number",
        maximum: 100,
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(100)).toBe(100);
      expect(zodSchema.parse(50)).toBe(50);
      expect(() => zodSchema.parse(101)).toThrow();
    });

    it("converts number with min and max", () => {
      const schema: JsonSchema = {
        type: "number",
        minimum: 0,
        maximum: 100,
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(0)).toBe(0);
      expect(zodSchema.parse(50)).toBe(50);
      expect(zodSchema.parse(100)).toBe(100);
      expect(() => zodSchema.parse(-1)).toThrow();
      expect(() => zodSchema.parse(101)).toThrow();
    });
  });

  describe("enums", () => {
    it("converts string enum", () => {
      const schema: JsonSchema = {
        enum: ["red", "green", "blue"],
        description: "A color",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse("red")).toBe("red");
      expect(zodSchema.parse("green")).toBe("green");
      expect(zodSchema.parse("blue")).toBe("blue");
      expect(() => zodSchema.parse("yellow")).toThrow();
    });

    it("converts number enum", () => {
      const schema: JsonSchema = {
        enum: [1, 2, 3],
        description: "A number choice",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse("1")).toBe("1");
      expect(zodSchema.parse("2")).toBe("2");
      expect(zodSchema.parse("3")).toBe("3");
    });

    it("handles empty enum as never", () => {
      const schema: JsonSchema = {
        enum: [],
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(() => zodSchema.parse("anything")).toThrow();
    });
  });

  describe("arrays", () => {
    it("converts array of strings", () => {
      const schema: JsonSchema = {
        type: "array",
        items: { type: "string" },
        description: "An array of strings",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse(["hello", "world"])).toEqual(["hello", "world"]);
      expect(() => zodSchema.parse([1, 2, 3])).toThrow();
    });

    it("converts array of objects", () => {
      const schema: JsonSchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "number" },
          },
          required: ["name"],
        },
        description: "An array of objects",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(
        zodSchema.parse([
          { name: "Alice", age: 30 },
          { name: "Bob" },
        ]),
      ).toEqual([
        { name: "Alice", age: 30 },
        { name: "Bob" },
      ]);
      expect(() => zodSchema.parse([{ age: 30 }])).toThrow();
    });

    it("converts array without items as array of any", () => {
      const schema: JsonSchema = {
        type: "array",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse([1, "hello", true])).toEqual([1, "hello", true]);
    });
  });

  describe("objects", () => {
    it("converts simple object", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name"],
        description: "A person object",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse({ name: "Alice", age: 30 })).toEqual({
        name: "Alice",
        age: 30,
      });
      expect(zodSchema.parse({ name: "Bob" })).toEqual({ name: "Bob" });
      expect(() => zodSchema.parse({ age: 30 })).toThrow();
    });

    it("converts nested object", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name"],
          },
          score: { type: "number" },
        },
        required: ["user"],
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(
        zodSchema.parse({
          user: { name: "Alice", email: "alice@example.com" },
          score: 95,
        }),
      ).toEqual({
        user: { name: "Alice", email: "alice@example.com" },
        score: 95,
      });
      expect(zodSchema.parse({ user: { name: "Bob" } })).toEqual({
        user: { name: "Bob" },
      });
      expect(() => zodSchema.parse({ score: 95 })).toThrow();
    });

    it("converts object without properties as record", () => {
      const schema: JsonSchema = {
        type: "object",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse({ foo: "bar", baz: 123 })).toEqual({
        foo: "bar",
        baz: 123,
      });
    });
  });

  describe("required vs optional", () => {
    it("makes properties optional when not in required array", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          required1: { type: "string" },
          required2: { type: "number" },
          optional1: { type: "string" },
          optional2: { type: "boolean" },
        },
        required: ["required1", "required2"],
      };

      const zodSchema = jsonSchemaToZod(schema);

      // All required fields present
      expect(
        zodSchema.parse({
          required1: "hello",
          required2: 42,
          optional1: "world",
          optional2: true,
        }),
      ).toEqual({
        required1: "hello",
        required2: 42,
        optional1: "world",
        optional2: true,
      });

      // Only required fields
      expect(zodSchema.parse({ required1: "hello", required2: 42 })).toEqual({
        required1: "hello",
        required2: 42,
      });

      // Missing required field
      expect(() => zodSchema.parse({ required1: "hello" })).toThrow();
    });

    it("treats all fields as optional when required array is empty", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          field1: { type: "string" },
          field2: { type: "number" },
        },
        required: [],
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse({})).toEqual({});
      expect(zodSchema.parse({ field1: "hello" })).toEqual({ field1: "hello" });
    });

    it("treats all fields as optional when required array is missing", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          field1: { type: "string" },
          field2: { type: "number" },
        },
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse({})).toEqual({});
      expect(zodSchema.parse({ field1: "hello" })).toEqual({ field1: "hello" });
    });
  });

  describe("descriptions", () => {
    it("preserves description for primitives", () => {
      const schema: JsonSchema = {
        type: "string",
        description: "User's full name",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.description).toBe("User's full name");
    });

    it("preserves description for objects", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        description: "A user object",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.description).toBe("A user object");
    });
  });

  describe("fallback behavior", () => {
    it("falls back to z.any() for unsupported type", () => {
      const schema: JsonSchema = {
        type: "custom-type" as any,
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse("anything")).toBe("anything");
      expect(zodSchema.parse(123)).toBe(123);
      expect(zodSchema.parse({ foo: "bar" })).toEqual({ foo: "bar" });
    });

    it("falls back to z.any() for missing type", () => {
      const schema: JsonSchema = {
        description: "No type specified",
      };

      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse("anything")).toBe("anything");
      expect(zodSchema.parse(123)).toBe(123);
    });
  });

  describe("caching", () => {
    it("returns the same instance for the same schema object", () => {
      const schema: JsonSchema = {
        type: "string",
        description: "A string",
      };

      const zodSchema1 = jsonSchemaToZod(schema);
      const zodSchema2 = jsonSchemaToZod(schema);

      expect(zodSchema1).toBe(zodSchema2);
    });

    it("returns different instances for different schema objects", () => {
      const schema1: JsonSchema = {
        type: "string",
        description: "A string",
      };

      const schema2: JsonSchema = {
        type: "string",
        description: "A string",
      };

      const zodSchema1 = jsonSchemaToZod(schema1);
      const zodSchema2 = jsonSchemaToZod(schema2);

      expect(zodSchema1).not.toBe(zodSchema2);
    });
  });

  describe("complex real-world examples", () => {
    it("converts a typical tool input schema", () => {
      const schema: JsonSchema = {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
          filters: {
            type: "object",
            properties: {
              category: {
                enum: ["docs", "code", "issues"],
                description: "Filter by category",
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 100,
                description: "Maximum number of results",
              },
            },
          },
          options: {
            type: "array",
            items: {
              type: "string",
            },
            description: "Additional options",
          },
        },
        required: ["query"],
      };

      const zodSchema = jsonSchemaToZod(schema);

      // Valid input
      expect(
        zodSchema.parse({
          query: "test",
          filters: { category: "docs", limit: 10 },
          options: ["verbose", "debug"],
        }),
      ).toEqual({
        query: "test",
        filters: { category: "docs", limit: 10 },
        options: ["verbose", "debug"],
      });

      // Minimal valid input
      expect(zodSchema.parse({ query: "test" })).toEqual({ query: "test" });

      // Invalid: missing required field
      expect(() => zodSchema.parse({})).toThrow();

      // Invalid: wrong enum value
      expect(() =>
        zodSchema.parse({ query: "test", filters: { category: "invalid" } }),
      ).toThrow();

      // Invalid: limit out of range
      expect(() =>
        zodSchema.parse({ query: "test", filters: { limit: 101 } }),
      ).toThrow();
    });
  });
});
