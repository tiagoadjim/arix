# Security Policy

## Supported Versions

Arix is distributed as source code that you self-host. Security fixes are only applied to the `main` branch; there are no separate LTS releases. Always deploy from the latest commit on `main`.

## Reporting a Vulnerability

Please do not open a public GitHub issue for security vulnerabilities. Instead, use GitHub's private vulnerability reporting for this repository: open the "Security" tab of this repository, click "Report a vulnerability", and describe the issue, its impact, and steps to reproduce it.

You can expect an initial response within 5 business days. We will keep you updated as the issue is investigated and fixed, and we'll credit you in the release notes if you'd like, unless you prefer to stay anonymous.

## Scope

Arix self-hosts on your own infrastructure. Reports we consider in scope include authentication or authorization bypass in the dashboard or API, injection vulnerabilities such as SQL, command, or template injection, secrets or credentials leaking in logs, responses, or the browser (for example API keys, WooCommerce tokens, or MCP headers), server-side request forgery against the MCP client or the WooCommerce integration, and remote code execution.

Configuration issues that only affect a deployment which has deliberately opted into an insecure setting, such as ALLOW_INSECURE_HTTP=true or ALLOW_PRIVATE_NETWORKS=true, are lower priority but still welcome as reports.

## Disclosure

We follow coordinated disclosure: please give us reasonable time to release a fix before any public disclosure.
