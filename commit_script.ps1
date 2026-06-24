# Commit 1
git add src/config/schema.ts src/config/validator.ts src/config/eventbus.ts src/config/loader.ts src/config/index.ts package.json package-lock.json
if ($LASTEXITCODE -eq 0) {
    git commit -m "fix: resolve TypeScript errors in config module and add @types/json-schema dependency"
}

# Commit 2
if ($LASTEXITCODE -eq 0) {
    git add src/config/database.ts src/security/mtls.ts src/tls/acme_rotation.ts src/diagnostics/tracer.ts index.js
    git commit -m "feat: migrate database, mtls, tls, tracer, and entrypoint to centralized config with hot-reload"
}

# Commit 3
if ($LASTEXITCODE -eq 0) {
    git add tests/config.test.ts .github/workflows/test.yml package.json
    git commit -m "test: add comprehensive config tests and add config suite to CI matrix"
}

# Show log
git log --oneline -5
