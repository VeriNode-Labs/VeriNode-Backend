#!/bin/bash
mkdir -p .git/hooks
cp scripts/pre-commit-hook .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit