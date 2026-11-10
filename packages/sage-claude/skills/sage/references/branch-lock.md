# Lock the default branch

**Lock the default branch** once it first exists on GitHub: after the user approves its first creation, or after the first merge into a new repo.

`<branch>` is the branch just created, main or master. The user's choice (gate G15) covers this step for every new project. Turn on branch protection with this one command, then read it back with `gh api --hostname github.com repos/<owner>/<repo>/branches/<branch>/protection`:

```
gh api --hostname github.com -X PUT repos/<owner>/<repo>/branches/<branch>/protection --input - <<'EOF'
{"required_pull_request_reviews": {"required_approving_review_count": 0}, "enforce_admins": true, "allow_force_pushes": false, "allow_deletions": false, "required_status_checks": null, "restrictions": null}
EOF
```

In the read-back, check these four fields:
- `enforce_admins.enabled`: true
- `allow_force_pushes.enabled`: false
- `allow_deletions.enabled`: false
- `required_pull_request_reviews.required_approving_review_count`: 0

When all four match, tell the user in one line: `<branch>` now changes only through pull requests. When a field differs, tell the user which field and its value. When GitHub refuses (403 or 404), tell the user that the lock is not on, the status, and the likely causes: a private repo on GitHub Free, a token without admin rights, or no such branch. The permission prompt stops mistakes, not an agent that holds the GitHub token. This lock stops direct changes, but an agent with the owner's admin token can also remove it.
