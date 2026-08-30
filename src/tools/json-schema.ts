/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-08-21
 * @modify date 2026-08-28
 * @desc Deterministic validator for the JSON Schema subset accepted by AI Coder tools.
 */

import { compareAiCoderText } from "../deterministic-order.js";

export type AiCoderJsonSchema = Readonly<Record<string, unknown>>;

export type SchemaValidationResult = Readonly<{
  errors: readonly string[];
  valid: boolean;
}>;

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

const SUPPORTED_KEYWORDS = new Set([
  "$defs", "$id", "$ref", "$schema", "additionalProperties", "const",
  "default", "description", "enum", "items", "maxItems", "maxLength",
  "maximum", "minItems", "minLength", "minimum", "pattern", "properties",
  "required", "title", "type", "uniqueItems", "oneOf",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function valueType(value: unknown) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function decodePointerSegment(segment: string) {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: AiCoderJsonSchema, reference: string) {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return null;
  let current: unknown = root;
  for (const rawSegment of reference.slice(2).split("/")) {
    if (!isRecord(current)) return null;
    current = current[decodePointerSegment(rawSegment)];
  }
  return isRecord(current) ? current as AiCoderJsonSchema : null;
}

function canonicalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareAiCoderText)
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateNode(
  schema: AiCoderJsonSchema,
  value: unknown,
  path: string,
  errors: string[],
  root: AiCoderJsonSchema,
  referenceStack: ReadonlySet<string>,
) {
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalRef(root, schema.$ref);
    if (!resolved) {
      errors.push(`${path} dùng $ref không resolve được: ${schema.$ref}.`);
      return;
    }
    if (referenceStack.has(schema.$ref)) {
      errors.push(`${path} gặp vòng lặp $ref không được hỗ trợ: ${schema.$ref}.`);
      return;
    }
    validateNode(resolved, value, path, errors, root, new Set([...referenceStack, schema.$ref]));
    return;
  }

  if ("const" in schema && !Object.is(schema.const, value)) {
    errors.push(`${path} phải bằng ${String(schema.const)}.`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matchingBranches = schema.oneOf.reduce((count, branch) => {
      if (!isRecord(branch)) return count;
      const branchErrors: string[] = [];
      validateNode(branch as AiCoderJsonSchema, value, path, branchErrors, root, referenceStack);
      return branchErrors.length === 0 ? count + 1 : count;
    }, 0);
    if (matchingBranches !== 1) {
      errors.push(`${path} phải khớp chính xác một nhánh oneOf, nhận ${matchingBranches}.`);
    }
  }
  const expected = typeof schema.type === "string" ? schema.type : null;
  if (expected) {
    const actual = valueType(value);
    const typeMatches = expected === "number"
      ? typeof value === "number" && Number.isFinite(value)
      : expected === "object" ? isRecord(value) : expected === actual;
    if (!typeMatches) {
      errors.push(`${path} phải có type ${expected}, nhận ${actual}.`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} phải thuộc enum ${schema.enum.map(String).join(", ")}.`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} ngắn hơn minLength=${schema.minLength}.`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} dài hơn maxLength=${schema.maxLength}.`);
    }
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path} không khớp pattern ${schema.pattern}.`);
      } catch {
        errors.push(`${path} dùng pattern không hợp lệ: ${schema.pattern}.`);
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} nhỏ hơn minimum=${schema.minimum}.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} lớn hơn maximum=${schema.maximum}.`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path} ít hơn minItems=${schema.minItems}.`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path} vượt maxItems=${schema.maxItems}.`);
    if (schema.uniqueItems === true) {
      const canonicalItems = value.map(canonicalValue);
      if (new Set(canonicalItems).size !== canonicalItems.length) errors.push(`${path} phải có các phần tử duy nhất.`);
    }
    const itemSchema = isRecord(schema.items) ? schema.items as AiCoderJsonSchema : null;
    if (itemSchema) value.forEach((item, index) => validateNode(itemSchema, item, `${path}[${index}]`, errors, root, referenceStack));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties as Record<string, AiCoderJsonSchema> : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    required.forEach((key) => {
      if (!(key in value)) errors.push(`${path}.${key} là trường bắt buộc.`);
    });
    Object.entries(value).forEach(([key, item]) => {
      const propertySchema = properties[key];
      if (propertySchema) {
        validateNode(propertySchema, item, `${path}.${key}`, errors, root, referenceStack);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} không được khai báo trong schema.`);
      } else if (isRecord(schema.additionalProperties)) {
        validateNode(schema.additionalProperties as AiCoderJsonSchema, item, `${path}.${key}`, errors, root, referenceStack);
      }
    });
  }
}

function validateNonNegativeInteger(value: unknown, path: string, errors: string[]) {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) {
    errors.push(`${path} phải là integer không âm.`);
  }
}

function validateSchemaDefinitionNode(
  schema: unknown,
  path: string,
  errors: string[],
  root: AiCoderJsonSchema,
) {
  if (!isRecord(schema)) {
    errors.push(`${path} phải là JSON Schema object.`);
    return;
  }
  Object.keys(schema).forEach((keyword) => {
    if (!SUPPORTED_KEYWORDS.has(keyword)) errors.push(`${path}.${keyword} không thuộc JSON Schema subset được hỗ trợ.`);
  });
  if (schema.type !== undefined && (typeof schema.type !== "string" || !JSON_SCHEMA_TYPES.has(schema.type))) {
    errors.push(`${path}.type không hợp lệ.`);
  }
  if (schema.$ref !== undefined) {
    if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#")) {
      errors.push(`${path} chỉ hỗ trợ local $ref.`);
    } else if (!resolveLocalRef(root, schema.$ref)) {
      errors.push(`${path} dùng $ref không resolve được: ${schema.$ref}.`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      errors.push(`${path}.pattern phải là string.`);
    } else {
      try { new RegExp(schema.pattern); } catch { errors.push(`${path}.pattern không phải regular expression hợp lệ.`); }
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    errors.push(`${path}.enum phải là array không rỗng.`);
  }
  if (Array.isArray(schema.enum)) {
    const canonicalItems = schema.enum.map(canonicalValue);
    if (new Set(canonicalItems).size !== canonicalItems.length) errors.push(`${path}.enum không được chứa giá trị trùng.`);
  }
  if (schema.oneOf !== undefined && (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0)) {
    errors.push(`${path}.oneOf phải là array schema không rỗng.`);
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) errors.push(`${path}.required phải là array.`);
  if (Array.isArray(schema.required)) {
    if (schema.required.some((item) => typeof item !== "string" || item.length === 0)) errors.push(`${path}.required chỉ được chứa string không rỗng.`);
    const required = schema.required.filter((item): item is string => typeof item === "string");
    if (new Set(required).size !== required.length) errors.push(`${path}.required không được chứa tên trùng.`);
    if (isRecord(schema.properties)) {
      const declaredProperties = schema.properties;
      required.forEach((key) => {
        if (!(key in declaredProperties)) errors.push(`${path}.required chứa property không được khai báo: ${key}.`);
      });
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" && !isRecord(schema.additionalProperties)) {
    errors.push(`${path}.additionalProperties phải là boolean hoặc schema.`);
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") errors.push(`${path}.uniqueItems phải là boolean.`);
  validateNonNegativeInteger(schema.minLength, `${path}.minLength`, errors);
  validateNonNegativeInteger(schema.maxLength, `${path}.maxLength`, errors);
  validateNonNegativeInteger(schema.minItems, `${path}.minItems`, errors);
  validateNonNegativeInteger(schema.maxItems, `${path}.maxItems`, errors);
  if (typeof schema.minLength === "number" && typeof schema.maxLength === "number" && schema.minLength > schema.maxLength) errors.push(`${path}.minLength không được lớn hơn maxLength.`);
  if (typeof schema.minItems === "number" && typeof schema.maxItems === "number" && schema.minItems > schema.maxItems) errors.push(`${path}.minItems không được lớn hơn maxItems.`);
  if (schema.minimum !== undefined && (typeof schema.minimum !== "number" || !Number.isFinite(schema.minimum))) errors.push(`${path}.minimum phải là finite number.`);
  if (schema.maximum !== undefined && (typeof schema.maximum !== "number" || !Number.isFinite(schema.maximum))) errors.push(`${path}.maximum phải là finite number.`);
  if (typeof schema.minimum === "number" && typeof schema.maximum === "number" && schema.minimum > schema.maximum) errors.push(`${path}.minimum không được lớn hơn maximum.`);

  if (schema.items !== undefined) validateSchemaDefinitionNode(schema.items, `${path}.items`, errors, root);
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((branch, index) => {
      validateSchemaDefinitionNode(branch, `${path}.oneOf[${index}]`, errors, root);
    });
  }
  if (isRecord(schema.additionalProperties)) validateSchemaDefinitionNode(schema.additionalProperties, `${path}.additionalProperties`, errors, root);
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) errors.push(`${path}.properties phải là object.`);
    else Object.entries(schema.properties).forEach(([key, child]) => validateSchemaDefinitionNode(child, `${path}.properties.${key}`, errors, root));
  }
  if (schema.$defs !== undefined) {
    if (!isRecord(schema.$defs)) errors.push(`${path}.$defs phải là object.`);
    else Object.entries(schema.$defs).forEach(([key, child]) => validateSchemaDefinitionNode(child, `${path}.$defs.${key}`, errors, root));
  }
}

/** Validates that a schema itself belongs to the deterministic subset supported by this runtime. */
export function validateAiCoderJsonSchemaDefinition(schema: unknown): SchemaValidationResult {
  const errors: string[] = [];
  if (!isRecord(schema)) errors.push("$ phải là JSON Schema object.");
  else validateSchemaDefinitionNode(schema, "$", errors, schema);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function assertAiCoderJsonSchemaDefinition(schema: unknown, label: string): asserts schema is AiCoderJsonSchema {
  const result = validateAiCoderJsonSchemaDefinition(schema);
  if (!result.valid) throw new Error(`${label} không hợp lệ: ${result.errors.join(" ")}`);
}

export function validateAiCoderJsonSchema(schema: AiCoderJsonSchema, value: unknown): SchemaValidationResult {
  const definition = validateAiCoderJsonSchemaDefinition(schema);
  if (!definition.valid) return definition;
  const errors: string[] = [];
  validateNode(schema, value, "$", errors, schema, new Set());
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function assertAiCoderJsonSchema(schema: AiCoderJsonSchema, value: unknown, label: string) {
  const result = validateAiCoderJsonSchema(schema, value);
  if (!result.valid) throw new Error(`${label} không hợp lệ: ${result.errors.join(" ")}`);
}
