import { ClientContract, ZenStackClient } from '@zenstackhq/orm';
import { PostgresDialect } from '@zenstackhq/orm/dialects/postgres';
import { PolicyPlugin } from '@zenstackhq/plugin-policy';
import type { Dialect } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { Pool } from 'pg';
import postgres from 'postgres';
import { bunSql, Driver, sslFor } from '../lib/drivers';
import measure from '../lib/measure';
import { assertIsolation, OTHER_TENANT, TENANT } from '../lib/policies';
import { QueryResult } from '../lib/types';
import { schema } from './schema/schema';

type Db = ClientContract<typeof schema>;
const clients = new Map<string, Db>();

function dialectFor(databaseUrl: string, driver: Driver): Dialect {
    const ssl = sslFor(databaseUrl) || undefined;
    switch (driver) {
        case 'pg':
            return new PostgresDialect({
                pool: new Pool({ connectionString: databaseUrl, ssl }),
            });
        case 'postgres-js':
            return new PostgresJSDialect({
                postgres: postgres(databaseUrl, { ssl }),
            });
        case 'bun-sql':
            // kysely-postgres-js accepts a Bun SQL instance in place of a postgres.js one.
            return new PostgresJSDialect({ postgres: bunSql(databaseUrl) });
    }
}

/**
 * The policy target uses ZenStack's own access control: the rules in schema.zmodel, applied by
 * PolicyPlugin to every query for the caller set with $setAuth. It needs no transaction and no
 * database role of its own.
 */
export async function zenstackPg(
    databaseUrl: string,
    driver: Driver = 'pg',
    policy = false,
): Promise<QueryResult[]> {
    console.log(
        `Run zenstack benchmarks (${driver}${policy ? ', policy' : ''}): `,
        databaseUrl,
    );

    const key = `${driver}:${policy}`;
    let db = clients.get(key);
    if (!db) {
        const client = new ZenStackClient(schema, {
            dialect: dialectFor(databaseUrl, driver),
            plugins: policy ? [new PolicyPlugin()] : [],
            // log: ['query'],
        }) as unknown as Db;
        const asTenant = (tenant: number) =>
            client.$setAuth({ id: tenant, tenantId: tenant }) as unknown as Db;
        db = policy ? asTenant(TENANT) : client;
        clients.set(key, db);
        if (policy) {
            assertIsolation(
                'zenstack-policy',
                await db.customer.count(),
                await asTenant(OTHER_TENANT).customer.count(),
            );
        }
    }

    // PolicyPlugin rejects $connect as a non-CRUD query. The policy client is already connected by
    // the isolation check above.
    if (!policy) await db.$connect();

    const results: QueryResult[] = [];

    /**
     * findMany
     */

    results.push(
        await measure('zenstack-findMany', () => db.customer.findMany()),
    );

    results.push(
        await measure('zenstack-findMany-filter-paginate-order', () =>
            db.customer.findMany({
                where: { isActive: true },
                orderBy: { createdAt: 'desc' },
                skip: 0,
                take: 10,
            }),
        ),
    );

    results.push(
        await measure('zenstack-findMany-1-level-nesting', () =>
            db.customer.findMany({
                include: {
                    orders: true,
                },
            }),
        ),
    );

    /**
     * findFirst
     */

    results.push(
        await measure('zenstack-findFirst', () => db.customer.findFirst()),
    );

    results.push(
        await measure('zenstack-findFirst-1-level-nesting', () =>
            db.customer.findFirst({
                include: {
                    orders: true,
                },
            }),
        ),
    );

    /**
     * findUnique
     */

    results.push(
        await measure('zenstack-findUnique', () =>
            db.customer.findUnique({
                where: { id: 1 },
            }),
        ),
    );

    results.push(
        await measure('zenstack-findUnique-1-level-nesting', () =>
            db.customer.findUnique({
                where: { id: 1 },
                include: {
                    orders: true,
                },
            }),
        ),
    );

    /**
     * create
     */

    results.push(
        await measure('zenstack-create', () =>
            db.customer.create({
                data: {
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                },
            }),
        ),
    );

    results.push(
        await measure('zenstack-nested-create', () =>
            db.customer.create({
                data: {
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                    isActive: false,
                    orders: {
                        create: {
                            date: new Date(),
                            totalAmount: 100.5,
                            products: {
                                connect: [{ id: 1 }, { id: 2 }], // Assuming products with IDs 1 and 2 already exist
                            },
                        },
                    },
                },
            }),
        ),
    );

    /**
     * update
     */

    results.push(
        await measure('zenstack-update', () =>
            db.customer.update({
                where: { id: 1 },
                data: {
                    name: 'John Doe Updated',
                },
            }),
        ),
    );

    results.push(
        await measure('zenstack-nested-update', () =>
            db.customer.update({
                where: { id: 1 },
                data: {
                    name: 'John Doe Updated',
                    address: {
                        update: {
                            street: '456 New St',
                        },
                    },
                },
            }),
        ),
    );

    /**
     * upsert
     */

    results.push(
        // Each attempt writes a new value, so no ORM can skip the update as unchanged.
        await measure('zenstack-upsert', (attempt) =>
            db.customer.upsert({
                where: { id: 1 },
                update: {
                    name: `John Doe Upserted ${attempt}`,
                },
                create: {
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                },
            }),
        ),
    );

    results.push(
        await measure('zenstack-nested-upsert', (attempt) =>
            db.customer.upsert({
                where: { id: 1 },
                update: {
                    name: `John Doe Upserted ${attempt}`,
                    address: {
                        update: {
                            street: `456 New St ${attempt}`,
                        },
                    },
                },
                create: {
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                    address: {
                        create: {
                            street: '456 New St',
                            city: 'Anytown',
                            postalCode: '12345',
                            country: 'Country',
                        },
                    },
                },
            }),
        ),
    );

    /**
     * delete
     */

    results.push(
        await measure('zenstack-delete', (attempt) =>
            db.customer.delete({
                where: { id: 1 + attempt },
            }),
        ),
    );

    return results;
}
