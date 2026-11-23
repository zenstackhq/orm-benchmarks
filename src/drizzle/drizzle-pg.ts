import { drizzle as drizzleNodePostgres } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';

// import { Customer, Order, Address } from "./schema/schema-postgres";
import * as schema from './schema/schema-postgres';
import * as relations from './schema/relations-postgres';
import { eq, desc, sql } from 'drizzle-orm';
import measure from '../lib/measure';
import {
    assertIsolation,
    OTHER_TENANT,
    policyUrl,
    TENANT,
    TENANT_SETTING,
} from '../lib/policies';
import postgres from 'postgres';
import { bunSql, Driver, sslFor } from '../lib/drivers';
import { QueryResult } from '../lib/types';

const fullSchema = { ...schema, ...relations };

type Db = PgDatabase<PgQueryResultHKT, typeof fullSchema>;
const clients = new Map<string, Db>();

async function connect(databaseUrl: string, driver: Driver) {
    const ssl = sslFor(databaseUrl) || undefined;
    switch (driver) {
        case 'pg':
            return drizzleNodePostgres({
                client: new Pool({ connectionString: databaseUrl, ssl }),
                schema: fullSchema,
            });
        case 'postgres-js':
            return drizzlePostgresJs({
                client: postgres(databaseUrl, { ssl }),
                schema: fullSchema,
            });
        case 'bun-sql': {
            // Loaded only on Bun: the module imports Bun's runtime.
            const { drizzle } = await import('drizzle-orm/bun-sql');
            return drizzle({ client: bunSql(databaseUrl), schema: fullSchema });
        }
    }
}

/** Runs `work` in a transaction whose first statement sets the tenant row-level security reads. */
function asTenant<T>(
    base: Db,
    tenant: number,
    work: (tx: Db) => Promise<T>,
): Promise<T> {
    return base.transaction(async (tx) => {
        await tx.execute(
            sql`select set_config(${TENANT_SETTING}, ${String(tenant)}, true)`,
        );
        return work(tx as unknown as Db);
    });
}

/**
 * Drizzle has no access-policy layer of its own; its documented approach is PostgreSQL row-level
 * security. The policy target connects as a role that cannot bypass it and runs every operation in
 * a transaction that sets the tenant first.
 */
export async function drizzlePg(
    databaseUrl: string,
    driver: Driver = 'postgres-js',
    policy = false,
): Promise<QueryResult[]> {
    const key = `${driver}:${policy}`;
    let base = clients.get(key);
    if (!base) {
        const url = policy ? policyUrl(databaseUrl) : databaseUrl;
        base = (await connect(url, driver)) as unknown as Db;
        clients.set(key, base);
        if (policy) {
            const count = async (tenant: number) =>
                asTenant(base!, tenant, async (tx) => {
                    const rows = await tx
                        .select({ count: sql<number>`count(*)::int` })
                        .from(schema.Customer);
                    return rows[0].count;
                });
            assertIsolation(
                'drizzle-policy',
                await count(TENANT),
                await count(OTHER_TENANT),
            );
        }
    }
    const client = base;

    // Every operation below uses `db`. For the policy target it is the transaction.
    let db: Db = client;
    const scoped =
        <T>(op: (attempt: number) => PromiseLike<T>) =>
        (attempt: number): PromiseLike<T> =>
            policy
                ? asTenant(client, TENANT, async (tx) => {
                      db = tx;
                      try {
                          return await op(attempt);
                      } finally {
                          db = client;
                      }
                  })
                : op(attempt);

    console.log(
        `Run drizzle benchmarks (${driver}${policy ? ', policy' : ''}): `,
        databaseUrl,
    );

    const results: QueryResult[] = [];

    /**
     * findMany
     */

    results.push(
        await measure(
            'drizzle-findMany',
            scoped(() => db.query.Customer.findMany()),
        ),
    );

    results.push(
        await measure(
            'drizzle-findMany-filter-paginate-order',
            scoped(() =>
                db.query.Customer.findMany({
                    where: eq(schema.Customer.isActive, true),
                    orderBy: [desc(schema.Customer.createdAt)],
                    offset: 0,
                    limit: 10,
                }),
            ),
        ),
    );

    results.push(
        await measure(
            'drizzle-findMany-1-level-nesting',
            scoped(() =>
                db.query.Customer.findMany({
                    with: {
                        orders: true,
                    },
                }),
            ),
        ),
    );

    /**
     * findFirst
     */

    results.push(
        await measure(
            'drizzle-findFirst',
            scoped(() => db.query.Customer.findFirst()),
        ),
    );

    results.push(
        await measure(
            'drizzle-findFirst-1-level-nesting',
            scoped(() =>
                db.query.Customer.findFirst({
                    with: {
                        orders: true,
                    },
                }),
            ),
        ),
    );

    /**
     * findUnique
     */

    results.push(
        await measure(
            'drizzle-findUnique',
            scoped(() =>
                db.query.Customer.findFirst({
                    where: eq(schema.Customer.id, 1),
                }),
            ),
        ),
    );

    results.push(
        await measure(
            'drizzle-findUnique-1-level-nesting',
            scoped(() =>
                db.query.Customer.findFirst({
                    where: eq(schema.Customer.id, 1),
                    with: {
                        orders: true,
                    },
                }),
            ),
        ),
    );

    /**
     * create
     */

    results.push(
        await measure(
            'drizzle-create',
            scoped(() =>
                db
                    .insert(schema.Customer)
                    .values({
                        name: 'John Doe',
                        email: 'john.doe@example.com',
                        isActive: false,
                    })
                    .returning(),
            ),
        ),
    );

    const nestedCreate = () =>
        db.transaction(async (trx) => {
            // Insert customer
            const customer = await trx
                .insert(schema.Customer)
                .values({
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                    isActive: false,
                })
                .returning();

            const customerId = customer[0].id;

            // Insert order with the associated customerId
            const insertedOrder = await trx
                .insert(schema.Order)
                .values({
                    customerId: customerId,
                    date: `${new Date().toISOString()}`,
                    totalAmount: '100.5',
                })
                .returning();

            const orderId = insertedOrder[0].id;

            // Insert products with the associated orderId
            await trx.insert(schema._OrderProducts).values([
                {
                    A: orderId,
                    B: 1,
                },
                {
                    A: orderId,
                    B: 2,
                },
            ]);
        });
    results.push(await measure('drizzle-nested-create', scoped(nestedCreate)));

    /**
     * update
     */

    results.push(
        await measure(
            'drizzle-update',
            scoped(() =>
                db
                    .update(schema.Customer)
                    .set({ name: 'John Doe Updated' })
                    .where(eq(schema.Customer.id, 1)),
            ),
        ),
    );

    results.push(
        await measure(
            'drizzle-nested-update',
            scoped(() =>
                db.transaction(async (trx) => {
                    // Update customer name
                    await trx
                        .update(schema.Customer)
                        .set({ name: 'John Doe Updated' })
                        .where(eq(schema.Customer.id, 1));

                    // Update address
                    await trx
                        .update(schema.Address)
                        .set({
                            street: '456 New St',
                        })
                        .where(eq(schema.Address.customerId, 1));
                }),
            ),
        ),
    );

    /**
     * upsert
     */
    results.push(
        await measure(
            // Each attempt writes a new value, so no ORM can skip the update as unchanged.
            'drizzle-upsert',
            scoped((attempt) =>
                db
                    .insert(schema.Customer)
                    .values({
                        id: 1,
                        name: 'John Doe',
                        email: 'john.doe@example.com',
                        isActive: false,
                    })
                    .onConflictDoUpdate({
                        target: schema.Customer.id,
                        set: { name: `John Doe Upserted ${attempt}` },
                    }),
            ),
        ),
    );

    const nestedUpsert = (attempt: number) =>
        db.transaction(async (trx) => {
            // Update customer name
            const customer = await trx
                .insert(schema.Customer)
                .values({
                    id: 1,
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                    isActive: false,
                })
                .onConflictDoUpdate({
                    target: schema.Customer.id,
                    set: { name: `John Doe Upserted ${attempt}` },
                })
                .returning();
            const customerId = customer[0].id;

            // Update address
            await trx
                .insert(schema.Address)
                .values({
                    street: '456 New St',
                    city: 'Anytown',
                    postalCode: '12345',
                    country: 'Country',
                    customerId: customerId,
                })
                .onConflictDoUpdate({
                    target: schema.Address.customerId,
                    set: { street: `456 New St ${attempt}` },
                });
        });
    results.push(await measure('drizzle-nested-upsert', scoped(nestedUpsert)));

    /**
     * delete
     */

    results.push(
        await measure(
            'drizzle-delete',
            scoped((attempt) =>
                db
                    .delete(schema.Customer)
                    .where(eq(schema.Customer.id, 1 + attempt)),
            ),
        ),
    );

    return results;
}
