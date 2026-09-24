import type { OutputFormat } from "../domain/cli-options.js";

export interface OutputWriter {
  readonly write: (text: string) => void;
  readonly writeError: (text: string) => void;
}

export const processOutputWriter: OutputWriter = Object.freeze({
  write: (text: string) => process.stdout.write(`${text}\n`),
  writeError: (text: string) => process.stderr.write(`${text}\n`),
});

export function renderOutput(value: unknown, format: OutputFormat): string {
  if (format === "json") return JSON.stringify(value, null, 2);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((entry) => String(entry)).join("\n");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${typeof entry === "string" ? entry : JSON.stringify(entry)}`)
      .join("\n");
  }
  return String(value);
}
