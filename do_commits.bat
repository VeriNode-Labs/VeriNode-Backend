@echo off
taskkill /f /im git.exe 2>nul
if exist .git\index.lock del /f .git\index.lock

git add src/config/database.ts src/security/mtls.ts src/tls/acme_rotation.ts src/diagnostics/tracer.ts index.js
if %errorlevel% equ 0 (
    git commit -m "feat: migrate database, mtls, tls, tracer, and entrypoint to centralized config with hot-reload"
) else (
    echo "git add failed for commit 2"
    exit /b 1
)

git add tests/config.test.ts .github/workflows/test.yml package.json
if %errorlevel% equ 0 (
    git commit -m "test: add comprehensive config tests and add config suite to CI matrix"
) else (
    echo "git add failed for commit 3"
    exit /b 1
)

git log --oneline -5
