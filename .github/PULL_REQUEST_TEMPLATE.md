## Summary

<!-- What does this change do, and why? One or two sentences. -->

## Changes

<!-- Bullet the notable changes. -->
-

## Testing

<!-- How did you verify this? Commands run, scenarios checked. -->
- [ ] `cd backend && pytest` passes
- [ ] `cd frontend && npm run build` passes (if frontend touched)
- [ ] Manually verified the affected flow

## Risk & rollout

<!-- Anything that touches auth, tenancy, policies, migrations, or the proxy. -->
- [ ] No new unauthenticated endpoints (or documented why)
- [ ] All new SQL is parameterized and scoped by `org_id`
- [ ] No secrets, keys, or `.db` files in the diff

## Related

<!-- Link issues, brain decisions, or prior PRs. -->
