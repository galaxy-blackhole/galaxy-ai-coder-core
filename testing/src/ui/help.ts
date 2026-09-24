export const GALAXY_CODE_VERSION = "2.0.0-alpha.8";

export const HELP_TEXT = `Galaxy Blackhole — deterministic laboratory for @galaxy-stack/ai-coder-core

Usage:
  blackhole doctor [--json]
  blackhole tools [--json]
  blackhole prompt <task> [--json]
  blackhole run [task] --fixture <file> [--workspace <dir>] [--json]
  blackhole eval --fixture <file-or-directory> [--workspace <dir>] [--json]
  blackhole campaign --fixture <ordered-directory> [--workspace <dir>] [--json]
  blackhole health --live --scenario <file-or-ordered-directory> [--workspace <empty-dir>]
                     [--store-dir <dir>] [--run-id <id>] [--resume]
                     [--pause-after-tool-calls <count>] [--record <file>]
                     [--model <name>] [--base-url <url>] [--config <file>] [--json]
  blackhole version
  blackhole help

Deterministic run/eval/campaign commands never call a hosted model. The health
command is the explicit opt-in live path. A scenario directory runs as an
ordered progressive campaign against one workspace. It reads the manual provider entry in
~/.galaxy/config.json by default and never prints its API key. Durable live
resume requires --workspace, --store-dir, --run-id, and --resume.`;
