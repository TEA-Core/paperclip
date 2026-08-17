---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If using connection pooling (transaction mode), disable prepared statements via the environment — no source edits needed:

```sh
DATABASE_PREPARED_STATEMENTS=false
```

Related optional client tuning (driver defaults apply when unset): `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`.

## Least-Privilege Database Roles (Production)

Paperclip separates runtime queries from DDL migrations using two database roles:

- **`paperclip_serving`** — the least-privilege role used by `DATABASE_URL` for all runtime operations. It has `SELECT`, `INSERT`, `UPDATE`, `DELETE` on tables and `USAGE` on schemas, but cannot create or alter schema objects.
- **Migration role** — a superuser (or equivalently privileged) role used by `DATABASE_MIGRATION_URL` for running migrations. Set `DATABASE_MIGRATION_URL` to this role's connection string.

When `DATABASE_MIGRATION_URL` is unset, migrations fall back to `DATABASE_URL`.

### Configuration

```sh
# Runtime connection — least-privilege paperclip_serving role
DATABASE_URL=postgres://paperclip_serving:...@db.example.com:5432/paperclip

# Migration connection — superuser for DDL
DATABASE_MIGRATION_URL=postgres://paperclip_admin:...@db.example.com:5432/paperclip
```

The migration role must be able to `CREATE`/`ALTER`/`DROP` schema objects and to `GRANT` privileges to `paperclip_serving`. The `paperclip_serving` role must be able to read and write all tables and sequences in the `public` schema.

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.
