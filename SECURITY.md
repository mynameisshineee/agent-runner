# Security Policy

## Reporting

Please report vulnerabilities privately to the BIKLabs security contact before public disclosure.

## Scope

Security-sensitive areas:

- webhook signature verification
- token handling and secret storage
- command spawning and runtime isolation
- multi-tenant boundaries
- logs and PII redaction

## Baselines

- signed webhook requests (HMAC)
- admin endpoints behind auth
- terminal identity derived from a unique per-agent runner credential, never trusted from request JSON
- one active job per agent, with session ownership and monotonically increasing lease fencing
- stale or restarted workers cannot mutate a re-leased job
- webhook, admin, runner, and MCP credentials use separate domains in production
- no secrets persisted in logs
- principle of least privilege for MCP tokens

`AGENT_SESSION_AUTH_MODE=shared-secret` is a legacy opt-in. It preserves the older trust model where `agentId` is declared by the caller and must not be used for production fleet control.
