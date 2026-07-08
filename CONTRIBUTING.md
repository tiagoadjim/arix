# Contributing to Arix

Thanks for your interest in improving Arix!

## Development setup

Requirements: Node 20+ (tested on Node 24), [pnpm](https://pnpm.io), and a local Postgres (or Docker).

```bash
pnpm install
cp env.example .env         # fill in DATABASE_URL and AUTH_JWT_SECRET at minimum
pnpm dev:server             # terminal 1 — API + WhatsApp gateway
pnpm dev:dashboard          # terminal 2 — dashboard on http://localhost:3000
```

## Before opening a PR

```bash
pnpm -w typecheck           # TypeScript across both packages
pnpm test                   # server test suite (vitest)
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
