# Tail-anchored tool output bounding

The head/tail limiter could cut the final JSON value mid-token when token/byte estimates drifted, dropping fields such as `"truncated":true` from bounded results. The tail is now anchored to the value end, the head source excludes the tail region, and estimator drift is absorbed by shrinking the head.

Validation: core 125/125 (new tail-intact regression), testing unit 107/107 plus deterministic e2e fixtures, CLI 20/20.
