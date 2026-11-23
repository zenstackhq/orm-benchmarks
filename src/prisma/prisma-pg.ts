import { PrismaPg } from '@prisma/adapter-pg';
import { Driver, sslFor } from '../lib/drivers';
import measure from '../lib/measure';
import {
    assertIsolation,
    OTHER_TENANT,
    policyUrl,
    TENANT,
    TENANT_SETTING,
} from '../lib/policies';
import { QueryResult } from '../lib/types';
import { PrismaClient } from './client-pg/client';

const clients = new Map<boolean, PrismaClient>();

/**
 * Prisma's documented row-level-security pattern: a client extension that runs every operation in a
 * batch transaction whose first statement sets the tenant.
 */
function forTenant(client: PrismaClient, tenant: number): PrismaClient {
    return client.$extends({
        query: {
            $allModels: {
                async $allOperations({ args, query }) {
                    const [, result] = await client.$transaction([
                        client.$executeRaw`select set_config(${TENANT_SETTING}, ${String(tenant)}, true)`,
                        query(args),
                    ]);
                    return result;
                },
            },
        },
    }) as unknown as PrismaClient;
}

/**
 * Prisma 7 has no Rust engine. It connects through a driver adapter; `pg` is the one it ships for
 * PostgreSQL. Prisma has no access-policy feature, so the policy target uses PostgreSQL row-level
 * security on a role that cannot bypass it.
 */
export async function prismaPg(
    databaseUrl: string,
    driver: Driver = 'pg',
    policy = false,
): Promise<QueryResult[]> {
    console.log(
        `Run prisma benchmarks (${driver}${policy ? ', policy' : ''}): `,
        databaseUrl,
    );

    let prisma = clients.get(policy);
    if (!prisma) {
        const url = policy ? policyUrl(databaseUrl) : databaseUrl;
        const ssl = sslFor(url) || undefined;
        const client = new PrismaClient({
            adapter: new PrismaPg({ connectionString: url, ssl }),
        });
        prisma = policy ? forTenant(client, TENANT) : client;
        clients.set(policy, prisma);
        if (policy) {
            assertIsolation(
                'prisma-policy',
                await prisma.customer.count(),
                await forTenant(client, OTHER_TENANT).customer.count(),
            );
        }
    }

    await prisma.$connect();

    const results: QueryResult[] = [];

    /**
     * findMany
     */

    results.push(
        await measure('prisma-findMany', () => prisma.customer.findMany()),
    );

    results.push(
        await measure('prisma-findMany-filter-paginate-order', () =>
            prisma.customer.findMany({
                where: { isActive: true },
                orderBy: { createdAt: 'desc' },
                skip: 0,
                take: 10,
            }),
        ),
    );

    results.push(
        await measure('prisma-findMany-1-level-nesting', () =>
            prisma.customer.findMany({
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
        await measure('prisma-findFirst', () => prisma.customer.findFirst()),
    );

    results.push(
        await measure('prisma-findFirst-1-level-nesting', () =>
            prisma.customer.findFirst({
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
        await measure('prisma-findUnique', () =>
            prisma.customer.findUnique({
                where: { id: 1 },
            }),
        ),
    );

    results.push(
        await measure('prisma-findUnique-1-level-nesting', () =>
            prisma.customer.findUnique({
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
        await measure('prisma-create', () =>
            prisma.customer.create({
                data: {
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                },
            }),
        ),
    );

    results.push(
        await measure('prisma-nested-create', () =>
            prisma.customer.create({
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
        await measure('prisma-update', () =>
            prisma.customer.update({
                where: { id: 1 },
                data: {
                    name: 'John Doe Updated',
                },
            }),
        ),
    );

    results.push(
        await measure('prisma-nested-update', () =>
            prisma.customer.update({
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
        await measure('prisma-upsert', (attempt) =>
            prisma.customer.upsert({
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
        await measure('prisma-nested-upsert', (attempt) =>
            prisma.customer.upsert({
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
        await measure('prisma-delete', (attempt) =>
            prisma.customer.delete({
                where: { id: 1 + attempt },
            }),
        ),
    );

    return results;
}
