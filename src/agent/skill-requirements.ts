/**
 * Companion-server requirements a skill declares in its frontmatter.
 *
 * A skill teaches call shapes; the MCP server that answers them is installed separately and can be
 * older. Measured: the 2026-10-02 gymflow run paired blackhole-cli 2.0.13 (its bundled
 * `orbit-framework` skill documents `orbit_knowledge_read { symbol }` and `{ section }`) with
 * orbit-mcp 0.4.0 (whose schema declares `required: ["id"]` and no `symbol`). The harness validates
 * arguments against that schema before the call reaches the server, so four calls died with
 * `data must have required property 'id'` and the agent fell back to grepping `node_modules` for
 * shapes the generated surface already carried.
 *
 * Declaring the range lets the host warn about exactly that skew instead of shipping it.
 */
export interface SkillRequirement {
  /** MCP server name as configured in the agent config, e.g. `orbit`. */
  readonly server: string;
  /** Comparator range over the version the server reports during initialize, e.g. `>=0.4.1`. */
  readonly range: string;
}

const SERVER_NAME = /^[a-zA-Z0-9_-]{1,48}$/;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
const MAX_REQUIREMENTS = 16;

/** `*` and an empty string mean "any version": a declared range nobody can violate. */
export function isUnboundedRequirementRange(range: string): boolean {
  return range.trim() === "" || range.trim() === "*";
}

/** True when every comparator in the range is well formed. */
export function isValidRequirementRange(range: string): boolean {
  if (isUnboundedRequirementRange(range)) return true;
  return comparatorsOf(range) !== undefined;
}

/**
 * Frontmatter shape: a mapping of server name to comparator range, e.g.
 * `requires: { orbit: ">=0.4.1" }`. Returns undefined when the field is absent.
 */
export function parseSkillRequires(value: unknown): readonly SkillRequirement[] | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("requires must be a mapping of MCP server name to version range.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new Error("requires must name at least one MCP server.");
  if (entries.length > MAX_REQUIREMENTS) throw new Error(`requires accepts at most ${MAX_REQUIREMENTS} servers.`);
  const requirements: SkillRequirement[] = [];
  for (const [server, range] of entries) {
    if (!SERVER_NAME.test(server)) throw new Error(`requires has an invalid MCP server name: ${server}.`);
    if (typeof range !== "string" || !isValidRequirementRange(range)) {
      throw new Error(`requires["${server}"] must be a version range such as ">=0.4.1".`);
    }
    requirements.push(Object.freeze({ server, range: range.trim() }));
  }
  return Object.freeze(requirements.sort((left, right) => (left.server < right.server ? -1 : left.server > right.server ? 1 : 0)));
}

type ParsedVersion = Readonly<{ major: number; minor: number; patch: number; prerelease: readonly (string | number)[] }>;

function parseVersion(value: string): ParsedVersion | undefined {
  const match = VERSION.exec(value.trim());
  if (!match) return undefined;
  const prerelease = match[4] === undefined
    ? []
    : match[4].split(".").map(part => (/^\d+$/.test(part) ? Number(part) : part));
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: Object.freeze(prerelease),
  });
}

/** Semver precedence: a prerelease sorts below its release; numeric identifiers sort before text. */
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function comparatorsOf(range: string): readonly Readonly<{ operator: string; version: ParsedVersion }>[] | undefined {
  const parts = range.split(/[\s,]+/).filter(part => part.length > 0);
  if (parts.length === 0) return undefined;
  const comparators: Array<Readonly<{ operator: string; version: ParsedVersion }>> = [];
  for (const part of parts) {
    const match = COMPARATOR.exec(part);
    if (!match) return undefined;
    const version = parseVersion(match[2]!);
    if (!version) return undefined;
    comparators.push(Object.freeze({ operator: match[1] ?? "=", version }));
  }
  return Object.freeze(comparators);
}

/**
 * True when the reported version satisfies the declared range. An unparseable version never
 * satisfies a bounded range: the host must not claim compatibility it cannot prove.
 */
export function satisfiesVersion(version: string, range: string): boolean {
  if (isUnboundedRequirementRange(range)) return true;
  const comparators = comparatorsOf(range);
  if (!comparators) return false;
  const reported = parseVersion(version);
  if (!reported) return false;
  return comparators.every(({ operator, version: expected }) => {
    const order = compareVersions(reported, expected);
    if (operator === ">=") return order >= 0;
    if (operator === ">") return order > 0;
    if (operator === "<=") return order <= 0;
    if (operator === "<") return order < 0;
    return order === 0;
  });
}
