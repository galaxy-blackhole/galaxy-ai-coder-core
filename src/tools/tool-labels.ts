/**
 * Human names for the tools the model calls. The model sees `list_files`; the user should read
 * "Liệt kê". Every host that shows a tool call (the TUI timeline, the webview transcript) reads this
 * table, so a new tool is named once.
 */
export const TOOL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  /* Short verbs, the way the reference reads: "Đọc · <tệp>" beats "Đọc (<tệp>)". */
  run_command: "Lệnh", "command.run": "Lệnh", git_operation: "Git", "git.exec": "Git",
  read_file: "Đọc", "workspace.read": "Đọc", write_file: "Ghi", "workspace.write": "Ghi",
  edit_file: "Sửa", "workspace.edit": "Sửa", list_directory: "Liệt kê", "workspace.list": "Liệt kê",
  search_files: "Tìm", "workspace.glob": "Tìm", search_text: "Tìm", "workspace.grep": "Tìm",
  search_tools: "Tìm công cụ", detect_project: "Nhận diện dự án", validate_project: "Kiểm thử dự án", "project.validate": "Kiểm thử dự án",
  review_changes: "Kiểm tra thay đổi", task_checkpoint: "Cập nhật kế hoạch", update_checkpoint: "Cập nhật kế hoạch", list_files: "Liệt kê", glob_files: "Tìm", memory_search: "Tìm bộ nhớ",
  memory_remember: "Lưu bộ nhớ", memory_forget: "Xóa bộ nhớ", skill_list: "Liệt kê skills", skill_load: "Đọc skill", skill_read: "Đọc tài liệu skill",
  tool_output_read: "Đọc kết quả", "tool_output.read": "Đọc kết quả", "code.run": "Chạy", run_code: "Chạy",
  /* First-party MCP tools (orbit / nebula) — friendly names hide call mechanics. */
  orbit_knowledge_topics: "Danh mục tri thức Orbit", orbit_knowledge_read: "Tra cứu tri thức Orbit",
  orbit_scaffold_module: "Tạo module Orbit", orbit_scaffold_graphql: "Tạo GraphQL Orbit",
  orbit_security_review: "Rà soát bảo mật", list_components: "Danh sách component Galaxy",
  get_component: "Xem component Galaxy", get_component_source: "Đọc source component",
  get_coverage: "Tra độ phủ component", search_components: "Tìm component Galaxy",
});

/** Model-facing MCP names look like mcp_<server>_<tool>_<hash12>; strip both and fall back to words. */
export function labelForModelName(name: string): string | undefined {
  if (!name.startsWith("mcp_")) return TOOL_LABELS[name];
  const stripped = name.replace(/_[0-9a-f]{8,16}$/, "").replace(/^mcp_/, "");
  if (TOOL_LABELS[stripped] !== undefined) return TOOL_LABELS[stripped];
  const withoutServer = stripped.replace(/^[^_]+_/, "");
  /* The server prefix names the host, not the action, so the fallback drops it. */
  return TOOL_LABELS[withoutServer] ?? withoutServer.replaceAll("_", " ");
}

/** Untrusted text reaches a single line: control characters go, runs of whitespace collapse. */
function oneLine(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : character;
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * What a tool call is called in the UI: "Chạy lệnh (npm test)", "Đọc tệp (src/app.ts)". The raw name is the
 * fallback, and the detail prefers a description the model wrote for a shell command over the raw command.
 */
export function toolLabel(name: string, args: Readonly<Record<string, unknown>> = {}): string {
  const described = name === "run_command" || name === "command.run"
    ? (typeof args.description === "string" && args.description.trim().length > 0 ? args.description.trim() : undefined)
    : undefined;
  const detail = (described ?? args.command) ?? (Array.isArray(args.checks) ? `${String(args.path ?? ".")}: ${args.checks.join(", ")}` : undefined) ?? args.path ?? (Array.isArray(args.paths) ? args.paths.join(", ") : undefined) ?? args.query ?? args.id ?? args.key ?? args.name ?? "";
  const label = labelForModelName(name);
  const action = (name === "git_operation" || name === "git.exec") ? `git ${String(args.action ?? "status")}` : "";
  /* A blank or whitespace-only detail would render as an empty pair of brackets — drop it instead. */
  const suffix = [action, detail]
    .map(value => (typeof value === "string" ? value.trim() : ""))
    .filter(value => value.length > 0)
    .join(" ");
  return oneLine(`${label ?? name}${suffix.length > 0 ? ` (${suffix})` : ""}`);
}