# Incremental Ollama streaming

Decode NDJSON as bytes arrive instead of buffering the complete HTTP response. Share the stateful normalizer with replay, retain byte limits and UTF-8 correctness, and cancel body readers when requests or consumers stop. Late errors do not emit a duplicate started event.

Validation: core verify, 13 transport tests, 7 normalizer tests and recorded replay; delayed HTTP→CLI rendering verifies deltas before EOF.
