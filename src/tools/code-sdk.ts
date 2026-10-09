import type { AiCoderToolDescriptor } from "./tool-registry-types.js";

/**
 * JSON Schema → a TypeScript façade for the model, in the spirit of DSH's "generated SDK": the model should read
 * a callable signature, not infer one. The mapping is pragmatic (objects, arrays, primitives, enums, optionals)
 * and deliberately not a compiler — it never needs to be *correct* TypeScript, only unambiguous.
 */
function schemaType(schema: unknown, depth = 0): string {
  if (schema === null || typeof schema !== "object") return "unknown";
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum)) return record.enum.map(value => JSON.stringify(value)).join(" | ");
  const type = record.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "null") return "null";
  if (type === "array") {
    const items = Array.isArray(record.items) ? record.items[0] : record.items;
    return "Array<" + schemaType(items, depth + 1) + ">";
  }
  if (type === "object" || record.properties !== undefined) {
    if (depth > 4) return "Record<string, unknown>";
    const properties = (record.properties ?? {}) as Record<string, unknown>;
    const required = new Set(Array.isArray(record.required) ? record.required.map(String) : []);
    const fields = Object.entries(properties).map(([name, value]) =>
      name + (required.has(name) ? "" : "?") + ": " + schemaType(value, depth + 1));
    return fields.length === 0 ? "Record<string, unknown>" : "{ " + fields.join("; ") + " }";
  }
  if (Array.isArray(type)) return type.map(entry => schemaType({ type: entry }, depth)).join(" | ");
  return "unknown";
}

/** One callable per active tool, then the rules a program must follow. */
export function renderCodeSdk(descriptors: readonly AiCoderToolDescriptor[]): string {
  const signatures = [...descriptors]
    .sort((left, right) => (left.modelName < right.modelName ? -1 : left.modelName > right.modelName ? 1 : 0))
    .map((tool) => `declare function ${tool.modelName}(args: ${schemaType(tool.inputSchema)}): Promise<unknown>; // ${tool.title}`);
  return [
    "TOOLS, FROM INSIDE A PROGRAM",
    "",
    "Call `run_code` with a short program. Inside it, every active tool is a function that returns a Promise;",
    "the host executes the call, applies the usual approvals, and hands you the result. Programs start clean:",
    "nothing is remembered between runs, so read what you need and say what you found.",
    "",
    ...signatures,
    "",
    "console.log(...) is captured and returned with your value; return the value you want to keep.",
    "Batch independent calls into one program instead of many small runs. A call that needs approval pauses the",
    "program until the human answers; a call that is denied throws, so a program that expects refusal should",
    "catch it.",
  ].join("\n");
}
