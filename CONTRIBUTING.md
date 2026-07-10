# Contributing to Arix

Thanks for your interest in improving Arix!

## Development setup

Requirements: Node 24.x LTS, [pnpm](https://pnpm.io), and a local Postgres (or Docker).

```bash
pnpm install
cp env.example .env         # fill in DATABASE_URL/AUTH_JWT_SECRET/SETUP_TOKEN; use a separate settings key in production
pnpm dev:server             # terminal 1 — API + WhatsApp gateway
pnpm dev:dashboard          # terminal 2 — dashboard on http://localhost:3000
```

## Before opening a PR

```bash
pnpm typecheck              # TypeScript across both packages
pnpm test                   # server + dashboard suites (Vitest)
pnpm --filter @arix/dashboard test:e2e  # critical browser flows (Playwright)
pnpm lint                   # ESLint; warnings are failures
pnpm build                  # production builds for both packages
pnpm audit:prod             # production dependency audit
```

- Keep PRs focused: one change per PR.
- New logic in `server/src` should come with tests in `server/test`.
- Use [conventional commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `chore:`, `docs:`...).
- If you change configuration keys, migrations, or API endpoints, update the README accordingly.

## Reporting bugs

Open an issue with reproduction steps, expected vs actual behavior, and relevant logs
(`docker compose logs server`). Never paste API keys or customer data into issues.

## Security

If you find a security vulnerability, please do not open a public issue — report it
privately to the maintainer instead.
