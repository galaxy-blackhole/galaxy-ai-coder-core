import type { AgentEmbeddingPort } from "../../src/agent/index.js";

/** A small labeled recall set: Vietnamese notes with paraphrase and cross-lingual queries. */
export const RECALL_NOTES: readonly (readonly [string, string])[] = Object.freeze([
  ["test-run", "Quy trình chạy kiểm thử tự động cho dự án"],
  ["db-config", "Cấu hình kết nối cơ sở dữ liệu PostgreSQL"],
  ["deploy", "Các bước triển khai ứng dụng lên máy chủ production"],
  ["auth", "Xác thực người dùng bằng JWT và refresh token"],
  ["logging", "Ghi log có cấu trúc và thu thập lỗi"],
  ["i18n", "Đa ngôn ngữ hóa giao diện và định dạng ngày tháng"],
  ["perf", "Tối ưu hiệu năng truy vấn và bộ nhớ đệm"],
  ["ci", "Tự động hóa quy trình tích hợp và phát hành"],
]);
export const RECALL_QUERIES: readonly (readonly [string, string])[] = Object.freeze([
  ["làm sao để test", "test-run"],
  ["how to connect a database", "db-config"],
  ["release the app to live servers", "deploy"],
  ["dang nhap nguoi dung", "auth"],
  ["collect errors", "logging"],
  ["translate the interface", "i18n"],
  ["speed up queries with a cache", "perf"],
  ["automate integration", "ci"],
]);

const GROUPS = ["test", "db", "deploy", "auth", "logging", "i18n", "perf", "ci"] as const;
const KEYWORDS: Readonly<Record<string, string>> = Object.freeze({
  "kiểm thử": "test", "test": "test", "testing": "test",
  "cơ sở dữ liệu": "db", "database": "db", "postgresql": "db", "connect": "db", "kết nối": "db",
  "triển khai": "deploy", "production": "deploy", "live servers": "deploy", "máy chủ": "deploy",
  "xác thực": "auth", "jwt": "auth", "login": "auth", "đăng nhập": "auth", "dang nhap": "auth", "nguoi dung": "auth", "người dùng": "auth", "refresh token": "auth",
  "log": "logging", "lỗi": "logging", "errors": "logging",
  "đa ngôn ngữ": "i18n", "interface": "i18n", "translate": "i18n", "giao diện": "i18n",
  "hiệu năng": "perf", "cache": "perf", "queries": "perf", "bộ nhớ đệm": "perf", "truy vấn": "perf",
  "tích hợp": "ci", "phát hành": "ci", "automate": "ci", "integration": "ci", "tự động hóa": "ci",
});
function vector(text: string): number[] {
  const lower = text.toLowerCase();
  const result: number[] = GROUPS.map((): number => 0);
  for (const [keyword, group] of Object.entries(KEYWORDS)) {
    if (!lower.includes(keyword)) continue;
    const index = GROUPS.indexOf(group as (typeof GROUPS)[number]);
    if (index >= 0) result[index] = (result[index] ?? 0) + 1;
  }
  if (!result.some(value => value !== 0)) result[GROUPS.length - 1] = 0.5;
  return result;
}
/** Deterministic keyword-group embedder: stands in for a real model in offline tests. */
export function fakeEmbeddings(): AgentEmbeddingPort {
  return { model: "fake-recall-v1", async embed(texts) { return texts.map(vector); } };
}

export async function measureRecall(
  memory: { search(query: string, options?: { limit?: number }): Promise<readonly { key: string }[]> },
  queries: readonly (readonly [string, string])[] = RECALL_QUERIES,
): Promise<{ at1: number; at3: number; misses: string[] }> {
  let at1 = 0; let at3 = 0; const misses: string[] = [];
  for (const [query, expected] of queries) {
    const keys = (await memory.search(query, { limit: 3 })).map(record => record.key);
    if (keys[0] === expected) at1 += 1;
    if (keys.includes(expected)) at3 += 1; else misses.push(`${query} -> ${keys.join(",") || "none"} (want ${expected})`);
  }
  return { at1: at1 / queries.length, at3: at3 / queries.length, misses };
}
