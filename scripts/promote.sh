#!/usr/bin/env bash
set -e

STAGE=${1:-""}

if [ "$STAGE" = "staging" ]; then
  gh pr create --base staging --head dev --title "chore(release): promote dev to staging" --body "Promoting tested dev changes to staging."
elif [ "$STAGE" = "main" ]; then
  gh pr create --base main --head staging --title "chore(release): promote staging to main" --body "Promoting validated staging release to production main."
else
  echo "Usage: ./scripts/promote.sh [staging|main]"
  exit 1
fi
