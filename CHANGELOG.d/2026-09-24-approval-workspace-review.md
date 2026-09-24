# Request-scoped approvals and scratch workspace review

Abort host approval prompts when their request expires or resolves; reject late approvals without canceling the parent run. Allow NodeToolExecutor hosts to choose their approval timeout.

Add the optional NodeWorkspaceReviewExecutor for stable, bounded before/after text review without Git. It attests real diff-review evidence without weakening validation requirements. Update the prompt to use this tool when available.

Validation: core verify (121 tests), 16 lab executor regressions and CLI end-to-end scratch-project completion, including a live provider run.
