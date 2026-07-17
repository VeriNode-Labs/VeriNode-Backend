# TODO - Config Runtime Auditing (Drift Detection)

- [ ] Implement baseline loader (read committed baseline config files; start with config.json.example)
- [ ] Implement runtime snapshot collector (interval 5 minutes; uses getConfig())
- [ ] Implement diff comparator (value changes + added/removed keys) using stable flattening
- [ ] Implement snapshot storage (in-memory + JSONL on disk optional via env)
- [ ] Implement PagerDuty notifier + alert routing policy (deployment-scoped critical drift)
- [x] Wire auditor into index.js after config init

- [x] Add dashboard endpoints: GET /debug/config-drift and history

- [x] Add unit tests for flatten+diff and alert policy


- [ ] Run tests and ensure build passes

