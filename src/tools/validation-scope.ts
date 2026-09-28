/**
 * Scope of a project check, from the project path the check ran in.
 *
 * A check run inside a subproject only proves that subproject. Recording it as
 * `scope: "workspace"` claimed the whole tree, so an unrelated write (a README, a
 * sibling package) invalidated it and the run had to validate everything again:
 * the gymflow E2E lost a full re-validation to a backend edit invalidating
 * frontend lint and build.
 */
export function validationScopeForProjectPath(projectPath: string): Readonly<{ paths?: readonly string[]; scope: "paths" | "workspace" }> {
  const normalized = projectPath.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized === "" || normalized === "."
    ? Object.freeze({ scope: "workspace" as const })
    : Object.freeze({ paths: Object.freeze([normalized]), scope: "paths" as const });
}
