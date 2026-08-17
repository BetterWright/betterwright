---
name: full-stack-e2e-review
description: Run a rigorous end-to-end product or feature review across architecture, data, APIs, permissions, billing, tests, and real browser UX. Use for requests such as review this branch end to end, test everything, ensure no bugs, perform a full visual pass, or validate a multi-user workflow before merge or deploy.
---
# Full-stack end-to-end review

Treat the task as a closed-loop product validation, not as "run the existing test suite." Build evidence across code, live services, APIs, and ordinary browser interactions. Do not claim full coverage while a requested layer remains untested.

Hosts load only this skill's name and description until the user asks for an end-to-end review. When that happens, follow the ladder below. Load BetterWright's `browser` skill or MCP tool guidance before driving the browser — this playbook does not repeat that protocol.

## 1. Establish the real system and review boundary

1. Read repository instructions and relevant skills first.
2. Inspect the branch diff, recent commits, migrations, environment files, and existing tests.
3. If a prior agent, branch, PR, or environment booted the stack, resolve its exact refs and inspect its environment metadata, setup scripts, transcript/start logs, and diff before reuse. Record both setup and feature refs; avoid copying setup files into the reviewed working tree unless necessary.
4. Map the feature through every affected layer:
   - data model and migrations
   - authorization and ownership rules
   - backend services, routes, jobs, and third-party gates
   - CLI or SDK surfaces
   - frontend state and actions
   - billing, quotas, lifecycle, and recovery paths
5. Write a short review matrix before testing. Its rows are user journeys or invariants; its columns are code inspection, focused test, live API, desktop UI, and mobile UI. Mark every cell passed, failed, not applicable, or blocked.

Use independent subagents in parallel for bounded exploration, setup reconstruction, or visual review. Keep blockers and the final integration in the parent. Give subagents exact files, URLs, actors, fixtures, expected results, prohibited side effects, and required evidence.

## Browser harness

This skill defines what to prove, not one vendor's browser syntax.

When BetterWright is available through MCP, CLI, or a native tool:

1. Verify the integration with `browser_doctor` or `betterwright doctor`, then prove navigation and screenshot output before the review. Confirm its network policy permits the local test hosts; loopback must remain allowed for localhost applications.
2. Use the host agent's normal shell, repository, file, and test-runner tools for environment setup, database fixtures, raw API checks, code edits, and durable regression tests. BetterWright's browser sandbox has no host filesystem, process, module-loader, or unrestricted network-interception access and is not a replacement for Playwright Test or the project's test runner.
3. Use one named BetterWright session per independent browser lane. Sessions share a cookie jar, so use separate BetterWright profiles for different user identities. For parallel role testing over MCP, configure separate server aliases with distinct `BETTERWRIGHT_PROFILE` values; otherwise test roles sequentially with explicit sign-out/sign-in and verify identity after every switch.
4. Capture `debug` images while diagnosing and a visually inspected `proof` image for each important completed flow. Keep command output, API matrices, test results, and repository diffs as host-agent evidence.

With another browser harness, preserve the same semantics: fresh observed locators, action verification, isolated identities, mobile and desktop viewports, ordinary user controls, and proof screenshots.

## 2. Model realistic fixtures

Create deterministic local or test-only fixtures that expose boundary failures. Use the application's real persistence layer where practical; do not mock away the behavior being reviewed.

Cover the smallest meaningful matrix:

- actors: owner, admin, member, outsider, and empty/new user
- scopes: personal and shared/tenant scope
- resources: owned by the actor, owned by another member, archived or failed, and empty state
- account states: active, not started/free, past due or suspended when relevant
- collaboration: pending invitation and at least two members
- limits: below limit, at limit, and disallowed action

Use fake credentials and test-only auth helpers. For OAuth-only applications, seed test users and mint local sessions through the application's supported session mechanism without bypassing authorization middleware. Never reuse or expose production secrets. Make fixture scripts idempotent so they can be rerun after fixes.

## 3. Boot and prove the stack

1. Inspect install and database-preparation scripts before running them. Confirm all database URLs and external services are disposable local/test resources; never reset, migrate, or seed shared or production infrastructure without explicit approval.
2. Start long-lived services through a persistent, inspectable mechanism. Keep startup commands separate from health checks.
3. Verify each required port or health endpoint and inspect recent logs. A running process is not proof that the service is healthy.
4. Record the exact URLs, ports, test actors, and known unavailable integrations.
5. Distinguish harness problems from product failures. Repair the harness only when the change is isolated, reversible, and within the requested scope; otherwise mark it blocked.

## 4. Review code for missing invariants

Do not rely only on tests that already exist. Trace each journey and actively search for holes such as:

- scope identifiers accepted inconsistently across endpoints
- owner-only fields, URLs, tokens, IPs, or secrets leaking after partial redaction
- UI actions enabled even though the API will reject them
- list, detail, metrics, snapshots, search, or billing endpoints using different tenancy fences
- actor identity confused with billing subject or resource owner
- permission checks missing on mutation paths
- "personal" behavior differing between UI, CLI, API, and stored identifiers
- stale, loading, empty, partial-error, retry, and past-due states
- migration, rollback, idempotency, concurrency, and post-credit or post-plan behavior

For sensitive fields, assert absence as well as presence. For mutations, verify both the response and persisted state.

## 5. Execute the proof ladder

Run from narrow and fast to broad and realistic:

1. Focused unit or integration tests around changed invariants.
2. Typecheck, lint, or compile every affected package.
3. Live HTTP/API checks against the running stack.
4. CLI or SDK checks if the feature is exposed there.
5. Real browser interaction and visual review.
6. Broader regression suites after any fix.

For live API checks, build an explicit actor-by-scenario matrix. Verify status code and response body for positive and negative cases, including:

- personal versus shared scope
- owner versus non-owner resource access
- each role's read and mutation rights
- outsider isolation
- invitation, billing, quota, and lifecycle gates
- sensitive-field redaction
- consistency across list, detail, metrics, snapshots, and related endpoints

Do not use a destructive billing, invitation, deletion, or external side effect merely to prove a button works. Prefer local fakes, dry runs, seeded states, or stop before submission and mark the final step blocked when approval is required.

## 6. Perform a true visual and interaction pass

Use ordinary browser controls. Click through; do not infer UI behavior from source or screenshots alone.

For each actor and state:

1. Start from a clean authenticated entry point.
2. Walk navigation, switchers, tabs, menus, dropdowns, inline editors, dialogs, and back/refresh paths.
3. Check enabled actions and disabled reasons against the permission matrix.
4. Confirm submitted or selected state persists after navigation or reload when it should.
5. Inspect loading flashes, error toasts, stale data, empty states, truncation, wrapping, contrast, hierarchy, alignment, copy consistency, and focus behavior.
6. Test a normal desktop viewport and a narrow mobile viewport. Check drawers and overlays, not only static layout.
7. Capture each distinct important state with a descriptive filename. Tie every visual finding to its screenshot.

A dedicated visual subagent should receive a numbered walkthrough with exact fixtures and expected states. Its return must include what worked, bugs by severity, role/action confirmation, interaction failures, and screenshot paths.

## 7. Close the loop on every failure

For each failure:

1. Reproduce it with the smallest reliable case.
2. Classify it as product bug, test bug, fixture problem, environment problem, or expected limitation.
3. Trace the failure across layers. If edits are authorized, make the smallest coherent root-cause fix and add or strengthen a regression test; otherwise report the proposed fix and evidence without modifying product code.
4. Rerun the targeted check.
5. Rerun affected broader tests, typechecks, and builds.
6. Recheck the corresponding live API and UI path.
7. Review git status and diff; remove incidental artifacts such as generated files or lockfile churn that are unrelated to the fix.

Never commit, push, open or update a PR, upgrade global toolchains, or mutate shared services unless explicitly requested. Keep dependency-install and generated-file churn out of the reviewed diff.

Do not stop at "tests pass" if the user asked for an end-to-end or visual review. Do not silently weaken an assertion to make a test green.

## 8. Completion gate and report

The review is complete only when every requested journey is passed or explicitly marked `[blocked]` with the missing dependency or approval.

Return:

1. **Scope tested**: branch/commit, services, actors, states, and viewports.
2. **What worked**: concise confirmed behavior.
3. **Bugs found and fixed**: severity, root cause, affected layers, regression coverage.
4. **Remaining findings**: severity, reproduction steps, and evidence.
5. **Permission and state matrix**: what each actor can see and do.
6. **Verification evidence**: exact commands, test counts, builds/typechecks, API cases, and screenshot paths.
7. **Deploy blockers**: migrations, infra, third-party dependencies, data safety, or untested production-only paths.
8. **Honest limitations**: distinguish a fully exercised flow from code-inspected or locally simulated coverage.

Prefer concrete statements such as "member received 403 and no secret fields were returned" over "permissions look correct." Attach focused visual proof when browser work was performed.

Adapted from [full-stack-e2e-review](https://github.com/CuriosityOS/full-stack-e2e-review) (MIT).
