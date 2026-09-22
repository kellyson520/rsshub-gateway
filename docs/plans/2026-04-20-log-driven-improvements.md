# RSSHub Gateway Log-Driven Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use the running `rsshub-gateway` container's recurring logs to identify a reproducible defect, implement the smallest tested fix, and push the verified change.

**Architecture:** First collect bounded gateway and upstream container logs without relying on the hanging Docker log stream. Classify repeated errors against the logger, request, retry, and health-check code paths. For each confirmed code defect, add a regression test before changing production code, implement the smallest fix, run focused and full tests, review the diff, rebuild/restart only when needed, and verify the live container behavior.

**Tech Stack:** Node.js ESM, Node test runner, Docker Compose, Git.

**Spec:** Running container logs and the existing repository test suite are the source of truth for this maintenance iteration.

## Global Constraints

- Do not modify secrets or commit credentials.
- Do not treat a timeout as a log diagnosis; use bounded commands and inspect complete outputs.
- Every bug fix must have a regression test with a red-then-green result.
- Preserve existing API and configuration behavior unless the logs demonstrate a defect.
- Push only after focused tests, full tests, live verification, and diff review succeed.

---

### Task 1: Capture and classify recurring container failures

**Files:**
- Read: Docker JSON logs for `rsshub-gateway` and `1Panel-rsshub-JhSx`
- Read: `src/infrastructure/logger.js`, `src/http-utils.js`, relevant request/error modules
- Create: `docs/diagnostics/2026-04-20-log-summary.md`

**Interfaces:**
- Consumes: Docker JSON log entries and existing source/test behavior.
- Produces: A timestamped list of recurring error signatures, frequency, affected route/module, and a concrete reproduction command or test target.

- [ ] **Step 1: Read bounded log entries and filter error signatures**

Run commands that read only the latest 500 entries or latest 24 hours from each known JSON log file, then classify `error`, `warn`, timeout, upstream status, and restart signatures.

- [ ] **Step 2: Trace each repeated signature to source code**

Read the exact caller and existing tests before deciding whether a log line is expected noise, deployment configuration, or a code defect.

- [ ] **Step 3: Record the diagnosis**

Write `docs/diagnostics/2026-04-20-log-summary.md` with evidence, reproduction, root cause, and chosen fix scope. If no reproducible code defect exists, document that and stop code changes.

- [ ] **Step 4: Verify the summary is tracked and contains no secrets**

Run `git diff --check` and inspect the summary for tokens, cookies, credentials, and full URLs containing secrets.

- [ ] **Step 5: Commit the diagnosis**

```bash
git add docs/diagnostics/2026-04-20-log-summary.md
git commit -m "docs: record rsshub gateway log diagnosis"
```

### Task 2: Add a failing regression test for the confirmed defect

**Files:**
- Create or modify: the smallest relevant `test/*.test.js`
- Read: the production module named in Task 1

**Interfaces:**
- Consumes: The concrete reproduction from `docs/diagnostics/2026-04-20-log-summary.md`.
- Produces: A deterministic test that fails before the fix for the diagnosed reason.

- [ ] **Step 1: Write one focused regression test**

Use the repository's existing Node test style and assert the intended behavior, not an implementation detail.

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
node --test test/<focused-test>.test.js
```

Expected: non-zero exit caused by the diagnosed defect, not a syntax/import/setup error.

- [ ] **Step 3: Commit the failing regression test**

```bash
git add test/<focused-test>.test.js
git commit -m "test: reproduce recurring gateway log failure"
```

### Task 3: Implement the minimal fix and verify GREEN

**Files:**
- Modify: exact production file(s) identified by the diagnosis
- Test: focused regression test from Task 2

**Interfaces:**
- Consumes: The failing regression test and root-cause trace.
- Produces: Correct behavior without unrelated refactoring.

- [ ] **Step 1: Implement the smallest root-cause fix**

Change only the necessary branch, timeout, retry, cleanup, or error classification behavior.

- [ ] **Step 2: Run the focused regression test**

```bash
node --test test/<focused-test>.test.js
```

Expected: exit code 0 and the regression test passes.

- [ ] **Step 3: Run the full test suite**

```bash
npm test
```

Expected: exit code 0 with no failed tests.

- [ ] **Step 4: Commit the implementation**

```bash
git add src test
 git commit -m "fix: resolve recurring gateway log failure"
```

### Task 4: Review, live verification, and push

**Files:**
- Read: complete `git diff`, compose/Dockerfile/entrypoint as needed
- Modify: documentation only if live verification reveals an operator-facing change

**Interfaces:**
- Consumes: Commits and test evidence from Tasks 1–3.
- Produces: Verified commit on `master` pushed to `origin/master`.

- [ ] **Step 1: Review the complete diff and check for secrets**

Run `git status`, `git diff origin/master..HEAD`, and `git diff --check`; inspect every changed file.

- [ ] **Step 2: Rebuild and restart the affected service if production code changed**

Use the repository's compose configuration, then verify the container reaches the expected running/healthy state.

- [ ] **Step 3: Exercise the original failing scenario**

Run the live health check or exact request reproduction and inspect fresh bounded logs for the original signature.

- [ ] **Step 4: Push the verified commit**

```bash
git push origin master
```

- [ ] **Step 5: Verify remote synchronization**

```bash
git status
 git log -1 --oneline
 git ls-remote origin refs/heads/master
```

Expected: clean worktree and remote commit equal to local HEAD.
