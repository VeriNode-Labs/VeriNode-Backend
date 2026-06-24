# Dependency Update Policy

## Scanning
- Dependencies scanned daily via Dependabot and Snyk
- npm ecosystem covered

## Severity Handling
| Severity | Action |
|----------|--------|
| Critical | Auto-create PR, block CI, immediate alert |
| High | Auto-create PR, alert |
| Medium | Weekly summary report |
| Low | Weekly summary report |

## PR Process
1. Dependabot/Snyk opens PR with patch
2. CI must pass on PR
3. Critical/High: merge within 24 hours
4. Medium/Low: merge within 7 days
