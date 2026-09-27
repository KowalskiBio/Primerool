## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature>/` in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Git

- Commit messages and PR descriptions get **no co-authorship / AI attribution lines** (no `Co-Authored-By: Claude …`, no "Generated with Claude Code").

## Deployment

- The VM is reached via the SSH alias `proxmox1` (`ssh proxmox1`).
- Its source checkout is `~/primerool-src`; the live deployment is `~/Primerool` (systemd `--user` `primerool.service`, behind nginx).
- To deploy: push the branch, then run `ssh proxmox1 'cd ~/primerool-src && ./scripts/deploy_vm.sh'`. The script deploys whichever branch that checkout is on (fast-forwarding it from `origin`), backs up the live dir, health-checks, and rolls back on failure.
