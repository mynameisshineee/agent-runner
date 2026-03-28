# Open-source release guide (`biklabs/agent-runner`)

## 1) Create standalone repo from subtree

From `/Users/shine/crm-pm-front`:

```bash
git subtree split --prefix=scripts/agent-runner -b codex/agent-runner-split
```

## 2) Create GitHub repo

```bash
gh repo create biklabs/agent-runner --public --description "BIKLabs terminal-first agent orchestrator" --confirm
```

## 3) Push split branch

```bash
git push git@github.com:biklabs/agent-runner.git codex/agent-runner-split:main
```

## 4) Cleanup local split branch

```bash
git branch -D codex/agent-runner-split
```

## Optional: verify contents quickly

```bash
git ls-tree --name-only -r codex/agent-runner-split
```
