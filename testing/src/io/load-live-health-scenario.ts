import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { parseLiveHealthScenario, type LiveHealthScenario } from "../domain/live-health-scenario.js";

export interface LoadedLiveHealthScenario {
  readonly path: string;
  readonly scenario: LiveHealthScenario;
}

async function loadScenarioFile(absolutePath: string): Promise<LoadedLiveHealthScenario> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read live health scenario '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return Object.freeze({ path: absolutePath, scenario: parseLiveHealthScenario(input) });
  } catch (error) {
    throw new Error(`Invalid live health scenario '${absolutePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function collectScenarioFiles(directory: string): Promise<readonly string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    }
  };
  await visit(directory);
  return Object.freeze(files.sort());
}

export async function loadLiveHealthScenarios(path: string, cwd = process.cwd()): Promise<readonly LoadedLiveHealthScenario[]> {
  const absolutePath = resolve(cwd, path);
  const info = await stat(absolutePath).catch((error: unknown) => {
    throw new Error(`Live health scenario path '${absolutePath}' is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  const files = info.isFile()
    ? Object.freeze([absolutePath])
    : info.isDirectory()
      ? await collectScenarioFiles(absolutePath)
      : null;
  if (files === null) throw new Error(`Live health scenario path '${absolutePath}' must be a JSON file or directory.`);
  if (files.length === 0) throw new Error(`Live health scenario directory '${absolutePath}' contains no .json files.`);
  const loaded = Object.freeze(await Promise.all(files.map(loadScenarioFile)));
  const names = new Map<string, string>();
  for (const item of loaded) {
    const previous = names.get(item.scenario.name);
    if (previous !== undefined) {
      throw new Error(`Duplicate live health scenario name '${item.scenario.name}' in '${previous}' and '${item.path}'.`);
    }
    names.set(item.scenario.name, item.path);
  }
  return loaded;
}

export async function loadLiveHealthScenario(path: string, cwd = process.cwd()): Promise<LiveHealthScenario> {
  const loaded = await loadLiveHealthScenarios(path, cwd);
  if (loaded.length !== 1) throw new Error(`Expected one live health scenario file, received ${loaded.length}.`);
  return loaded[0]!.scenario;
}
