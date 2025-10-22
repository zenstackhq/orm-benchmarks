import { ZenStackClient } from '@zenstackhq/runtime';
import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import measure from '../lib/measure';
import { QueryResult } from '../lib/types';
import { schema } from './schema/schema';

export async function zenstackPg(databaseUrl: string): Promise<QueryResult[]> {
    console.log(`Run zenstack benchmarks: `, databaseUrl);

    const db = new ZenStackClient(schema, {
        dialect: new PostgresDialect({
            pool: new Pool({
                connectionString: databaseUrl,
            }),
        }),
    });

    await db.$connect();

    const results: QueryResult[] = [];

    /**
     * findMany
     */

    results.push(await measure('zenstack-findMany', db.customer.findMany()));

    results.push(
        await measure(
            'zenstack-findMany-filter-paginate-order',
            db.customer.findMany({
                where: { isActive: true },
                orderBy: { createdAt: 'desc' },
                skip: 0,
                take: 10,
            })
        )
    );

    results.push(
        await measure(
            'zenstack-findMany-1-level-nesting',
            db.customer.findMany({
                include: {
                    orders: true,
                },
            })
        )
    );

    /**
     * findFirst
     */

    results.push(await measure('zenstack-findFirst', db.customer.findFirst()));

    results.push(
        await measure(
            'zenstack-findFirst-1-level-nesting',
            db.customer.findFirst({
                include: {
                    orders: true,
                },
            })
        )
    );

    /**
     * findUnique
     */

    results.push(
        await measure(
            'zenstack-findUnique',
            db.customer.findUnique({
                where: { id: 1 },
            })
        )
    );

    results.push(
        await measure(
            'zenstack-findUnique-1-level-nesting',
            db.customer.findUnique({
                where: { id: 1 },
                include: {
                    orders: true,
                },
            })
        )
    );

    /**
     * create
     */

    results.push(
        await measure(
            'zenstack-create',
            db.customer.create({
                data: {
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                },
            })
        )
    );

    results.push(
        await measure(
            'zenstack-nested-create',
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
            })
        )
    );

    /**
     * update
     */

    results.push(
        await measure(
            'zenstack-update',
            db.customer.update({
                where: { id: 1 },
                data: {
                    name: 'John Doe Updated',
                },
            })
        )
    );

    results.push(
        await measure(
            'zenstack-nested-update',
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
            })
        )
    );

    /**
     * upsert
     */

    results.push(
        await measure(
            'zenstack-upsert',
            db.customer.upsert({
                where: { id: 1 },
                update: {
                    name: 'John Doe Upserted',
                },
                create: {
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                },
            })
        )
    );

    results.push(
        await measure(
            'zenstack-nested-upsert',
            db.customer.upsert({
                where: { id: 1 },
                update: {
                    name: 'John Doe Upserted',
                    address: {
                        update: {
                            street: '456 New St',
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
            })
        )
    );

    /**
     * delete
     */

    results.push(
        await measure(
            'zenstack-delete',
            db.customer.delete({
                where: { id: 1 },
            })
        )
    );

    await db.$disconnect();

    return results;
}
