import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  parseDeterministicFixture,
  type DeterministicFixture,
} from "../domain/fixture.js";

export interface LoadedFixture {
  readonly path: string;
  readonly fixture: DeterministicFixture;
}

async function loadFixtureFile(path: string): Promise<LoadedFixture> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read fixture '${path}': ${message}`, { cause: error });
  }
  try {
    return { path, fixture: parseDeterministicFixture(parsed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid fixture '${path}': ${message}`, { cause: error });
  }
}

async function collectFixtureFiles(directory: string): Promise<readonly string[]> {
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

function assertUniqueFixtureNames(fixtures: readonly LoadedFixture[]): void {
  const byName = new Map<string, string>();
  for (const fixture of fixtures) {
    const previous = byName.get(fixture.fixture.name);
    if (previous !== undefined) {
      throw new Error(`Duplicate fixture name '${fixture.fixture.name}' in '${previous}' and '${fixture.path}'.`);
    }
    byName.set(fixture.fixture.name, fixture.path);
  }
}

export async function loadFixtures(inputPath: string, cwd = process.cwd()): Promise<readonly LoadedFixture[]> {
  const absolutePath = resolve(cwd, inputPath);
  const info = await stat(absolutePath).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Fixture path '${absolutePath}' is unavailable: ${message}`, { cause: error });
  });

  if (info.isFile()) {
    return Object.freeze([await loadFixtureFile(absolutePath)]);
  }
  if (!info.isDirectory()) {
    throw new Error(`Fixture path '${absolutePath}' must be a JSON file or directory.`);
  }

  const entries = await collectFixtureFiles(absolutePath);
  if (entries.length === 0) {
    throw new Error(`Fixture directory '${absolutePath}' contains no .json files.`);
  }
  const loaded = Object.freeze(await Promise.all(entries.map(loadFixtureFile)));
  assertUniqueFixtureNames(loaded);
  return loaded;
}
