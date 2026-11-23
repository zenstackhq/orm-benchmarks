![](./header.png)

<div align="center">
  <h1>ORM Benchmarks</h1>
</div>

This repo contains the app that was used to collect the data for [ORM benchmarks](https://benchmarks.prisma.io). 

You can learn more about the benchmark methodology and results in this blog post: [Performance Benchmarks: Comparing Query Latency across TypeScript ORMs & Databases](https://www.prisma.io/blog/performance-benchmarks-comparing-query-latency-across-typescript-orms-and-databases).

## What is measured

A **target** is an ORM, the PostgreSQL driver it runs on, and the JavaScript runtime. The driver changes the results as much as the ORM does: node-postgres sends each query as one round trip, while postgres.js and Bun's `SQL` client prepare statements, and an ORM that does not reuse them pays a second round trip on every parameterized query. So every ORM runs on each driver it supports, on Node and on Bun.

| ORM | Drivers | Runtimes |
| --- | --- | --- |
| ZenStack | `pg`, `postgres-js`, `bun-sql` (through `kysely-postgres-js`) | Node, Bun (`bun-sql` on Bun only) |
| Drizzle | `pg` (`drizzle-orm/node-postgres`), `postgres-js`, `bun-sql` | Node, Bun (`bun-sql` on Bun only) |
| Prisma 7 | `pg` (`@prisma/adapter-pg`, no Rust engine) | Node, Bun |
| TypeORM | `pg` | Node, Bun |

### Policy targets

Every ORM also has a `policy` target that enforces the same access rule: a `Customer` belongs to a tenant (`tenantId`), an `Address` or `Order` is visible only through a customer of the caller's tenant, and products are shared. Each ORM enforces it the way its own documentation recommends:

| ORM | How the rule is enforced |
| --- | --- |
| ZenStack | `@@allow` rules in `schema.zmodel`, applied by `PolicyPlugin` to the client returned by `$setAuth` |
| Drizzle | PostgreSQL row-level security; each operation runs in a transaction that first calls `set_config('app.tenant_id', …, true)` |
| Prisma | PostgreSQL row-level security through Prisma's documented client extension, which wraps each operation in a batch transaction with the same `set_config` |
| TypeORM | PostgreSQL row-level security; each operation runs in a transaction that sets the tenant first |

The row-level-security targets connect as `bench_app`, a role created by the harness that cannot bypass row-level security. The policies are applied after every restore (`src/lib/policies.ts`). Every seeded row belongs to tenant 1, so a policy target returns the same rows as its plain counterpart and the difference is the cost of enforcing the rule. Before timing, each policy target checks that tenant 1 sees the customers and tenant 2 sees none, and stops if not.

### How each operation is timed

Each target runs in its own process. Before every iteration the dataset is restored, then each of the 14 operations runs 2 times untimed and 5 times timed (`OP_WARMUP`, `OP_SAMPLES`), and the iteration records the median of the timed calls. The restore leaves the process idle for about 100 ms, and a single call timed right after it measured 3 to 5 times a warm call, hiding most of the difference between ORMs. `OP_WARMUP=0 OP_SAMPLES=1` reproduces one timed call per iteration.

`comparison.md` reports the median and p95 across iterations 2 onwards, and a first-call table: attempt zero of each operation in iteration 1. It includes only work done inside that call: first-run code paths, statement preparation where the driver prepares on first use, and connection setup only when the target had not opened a connection before timing. ZenStack (`$connect` runs `select 1`) and TypeORM (`initialize`) open one before timing, and the policy targets reuse the one opened by their tenant check. The plain Drizzle targets open theirs inside the first timed call, and Prisma's `$connect` through the driver adapter may not open one in advance. Each CSV has a matching `.first.csv`.

Upserts write a different value on every attempt, so an ORM that skips an unchanged update (TypeORM's `save`) does the same work as the others.

The timer starts before the query is built: each operation is passed to `measure` as a function, so an ORM whose queries are eager promises is timed the same way as one whose queries are lazy.

## Quick start with Docker

```bash
npm install
docker compose up -d                   # PostgreSQL 18 on 5432, toxiproxy on 15432
export DATABASE_URL=postgresql://postgres:bench@localhost:5432/bench
npx prisma db push
npm run prisma:gen:pg && npm run zen:gen

./benchmark.sh -i 30 -s 1000 -r both -l local

# The same through a proxy that adds 20 ms to every response:
./scripts/latency.sh 20
./benchmark.sh -i 10 -s 1000 -r both -l latency20 \
  -d postgresql://postgres:bench@localhost:15432/bench
```

Bun must be installed for `-r bun` or `-r both`. `pg_dump` and `pg_restore` on the host must match the server's major version; set `POSTGRES_VERSION` to change the server.

## Setup

### 1. Set up the repo

Clone the repo, navigate into it and install dependencies:

```
git clone git@github.com:prisma/orm-benchmarks.git
cd orm-benchmarks
npm install
```

### 2. Configure database connection

Set the `DATABASE_URL` environment variable to your database connection string in a `.env` file.

First, create a `.env` file:

```bash
touch .env
```

Then open the `.env` file and add the following line:

```bash
DATABASE_URL="your-database-url"
```

For example:

```bash
DATABASE_URL="postgresql://user:password@host:port/db"
```

<details><summary>Alternative: Set the <code>DATABASE_URL</code> in the terminal</summary>

Alternatively, you can set the `DATABASE_URL` in the terminal:

```bash
export DATABASE_URL="postgresql://user:password@host:port/db"
```

</details>

### 3. Run database migration

To create the database and the schema, run the `prisma db push` command by pointing it to the schema of your database.

#### PostgreSQL

If you use PostgreSQL, run:

```
npx prisma db push --schema ./prisma-pg/schema.prisma
```

> **Note**: We may add more databases in the future.

### 4. Run the benchmarks

> **Note for PostgreSQL**: Since the data preparation/seeding relies on `pg_dump` and `pg_restore`, the PostgreSQL versions of the machine that's executing the script must match the version of the target PostgreSQL server.

```
sh ./benchmark.sh -i 500 -s 1000 
```

This executes the benchmark scripts with 500 iterations and a sample size of 1000 records per table. See below for the different options you can provide to any benchmark runs.

The results of the benchmark run will be stored in a folder called `results/DB-SIZE-ITERATIONS-TIMESTAMP`, e.g. `results/postgresql-1000-500-1721027353940`. This folder will have one `.csv` file per ORM, e.g.:

```
results/postgresql-1000-500-1721027353940-local
├── comparison.md                 # median, p95 and first call for every target
├── zenstack-pg-node.csv          # one row of milliseconds per iteration
├── zenstack-pg-node.json         # runtime, driver, package and PostgreSQL versions
├── zenstack-bun-sql-bun.csv
├── drizzle-postgres-js-node.csv
└── ...
```

`src/lib/website-output.ts` still reads the older `prisma.csv`, `drizzle.csv` and `typeorm.csv` layout used for benchmarks.prisma.io.

## Usage

### Executing the benchmarks

You can execute the benchmarks by running the [`benchmark.sh`](./benchmark.sh):

```
sh ./benchmark.sh [options]
```

### Options

You can provide the following options to the script:

| Name             | Short | Default | Description                                        | Required |
| ---------------- | ----- | ------- | -------------------------------------------------- | -------- |
| `--iterations`   | `-i`  | 2       | Number of times to execute the benchmarks          | No       |
| `--size`         | `-s`  | 50      | Size of the data set (number of records per table) | No       |
| `--database-url` | `-d`  | n/a     | Database connection string                         | No       |
| `--runtime`      | `-r`  | both    | `node`, `bun` or `both`                            | No       |
| `--targets`      | `-t`  | all     | Comma-separated `orm:driver` or `orm:driver:policy`, e.g. `zenstack:pg,drizzle:bun-sql,prisma:pg:policy`. An ORM alone runs all its drivers and its policy target | No |
| `--label`        | `-l`  | n/a     | Appended to the results directory and recorded in `comparison.md` | No |

For example:

```
sh ./benchmark.sh -i 500 -s 1000 --database-url postgresql://user:password@host:port/db
```

## Notes on the drivers

- Drizzle passes `prepare: false` to postgres.js unless a query is built with `.prepare()`, so every parameterized query takes two round trips: one to describe the statement and one to run it. `kysely-postgres-js`, which ZenStack uses for both postgres.js and Bun's `SQL`, prepares and reuses statements, so after the first call it takes one. Over a network this difference is larger than any ORM's own overhead.
- Bun's `SQL` prepares a statement once per connection. Through `drizzle-orm/bun-sql` the pool spreads calls over all ten connections, so the first ten calls of each statement take two round trips and later calls take one. With fewer iterations than pool connections, the medians for that target are not warm. Use at least 20 iterations for any run with latency.
- The connection port in `DATABASE_URL` is passed to `psql`, `pg_dump` and `pg_restore`, so the dataset is restored through the same proxy or port the ORMs use.

## Debugging

You can turn on two debug setting via the `DEBUG` environment variable:

- `benchmarks:compare-results`: Compare the results at the end of each benchmark run. Note that this approach will consume more memory because the results of all executed queries are collected.

## Notes

- This repo contains an unfinished MySQL implementation.
- The final results that are published on [`benchmarks.prisma.io`](https://benchmarks.prisma.io) are based on the data in [`./results-website`](./results-website).
- The script in [`./src/lib/website-output.ts`](./src/lib/website-output.ts) is used to generate the JSON structures that are the basis for the result visualisation in [`benchmarks.prisma.io`](https://benchmarks.prisma.io).
- For Postgres, there are two ways how the seeding is implemented:
  - Option 1: Seed data with Prisma Client's `createMany` query (implemented in [./src/lib/prepare-pg-prisma.ts](./src/lib/prepare-pg-prisma.ts))
  - Option 2: Seed data with Prisma Client's `createMany` query only once, then store a DB dump in `./data/...` and restore the dump upon subsequent invocations (implemented in [./src/lib/prepare-pg-native.ts](./src/lib/prepare-pg-native.ts))