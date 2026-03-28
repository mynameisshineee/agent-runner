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
- no secrets persisted in logs
- principle of least privilege for MCP tokens
