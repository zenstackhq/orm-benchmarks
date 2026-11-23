import { DataSource, EntityManager } from 'typeorm';
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
import { Address } from './entities/Address';
import { Customer } from './entities/Customer';
import { Order } from './entities/Order';
import { Product } from './entities/Product';

const dataSources = new Map<boolean, DataSource>();

/** Runs `work` in a transaction whose first statement sets the tenant row-level security reads. */
function asTenant<T>(
    dataSource: DataSource,
    tenant: number,
    work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
    return dataSource.transaction(async (manager) => {
        await manager.query('select set_config($1, $2, true)', [
            TENANT_SETTING,
            String(tenant),
        ]);
        return work(manager);
    });
}

/**
 * TypeORM's PostgreSQL driver is node-postgres (`pg`). TypeORM has no access-policy feature, so the
 * policy target uses PostgreSQL row-level security: a role that cannot bypass it, and the tenant
 * set inside a transaction around every operation.
 */
export async function typeormPg(
    databaseUrl: string,
    driver: Driver = 'pg',
    policy = false,
): Promise<QueryResult[]> {
    let AppDataSource = dataSources.get(policy);
    if (!AppDataSource) {
        const url = policy ? policyUrl(databaseUrl) : databaseUrl;
        AppDataSource = new DataSource({
            type: 'postgres',
            url,
            logging: false,
            entities: [Customer, Order, Address, Product],
            ssl: sslFor(url) || undefined,
        });
        await AppDataSource.initialize();
        dataSources.set(policy, AppDataSource);
        if (policy) {
            const count = (tenant: number) =>
                asTenant(AppDataSource!, tenant, (manager) =>
                    manager.count(Customer),
                );
            assertIsolation(
                'typeorm-policy',
                await count(TENANT),
                await count(OTHER_TENANT),
            );
        }
    }

    // Every operation below uses `ds`. For the policy target it is the transaction's entity manager.
    const base = AppDataSource.manager;
    let ds: EntityManager = base;
    const scoped =
        <T>(op: (attempt: number) => Promise<T>) =>
        (attempt: number): Promise<T> =>
            policy
                ? asTenant(AppDataSource!, TENANT, async (manager) => {
                      ds = manager;
                      try {
                          return await op(attempt);
                      } finally {
                          ds = base;
                      }
                  })
                : op(attempt);

    console.log(
        `Run typeorm benchmarks (${driver}${policy ? ', policy' : ''}): `,
        databaseUrl,
    );

    const results: QueryResult[] = [];

    /**
     * findMany
     */
    results.push(
        await measure(
            'typeorm-findMany',
            scoped(() => ds.getRepository(Customer).find()),
        ),
    );

    results.push(
        await measure(
            'typeorm-findMany-filter-paginate-order',
            scoped(() =>
                ds.getRepository(Customer).find({
                    where: { isActive: true },
                    order: { createdAt: 'DESC' },
                    skip: 0,
                    take: 10,
                }),
            ),
        ),
    );

    results.push(
        await measure(
            'typeorm-findMany-1-level-nesting',
            scoped(() =>
                ds.getRepository(Customer).find({
                    relations: { orders: true },
                }),
            ),
        ),
    );

    /**
     * findFirst
     */

    results.push(
        await measure(
            'typeorm-findFirst',
            scoped(() =>
                ds.getRepository(Customer).find({
                    take: 1,
                }),
            ),
        ),
    );

    results.push(
        await measure(
            'typeorm-findFirst-1-level-nesting',
            scoped(() =>
                ds.getRepository(Customer).find({
                    take: 1,
                    relations: { orders: true },
                }),
            ),
        ),
    );

    /**
     * findUnique
     */
    results.push(
        await measure(
            'typeorm-findUnique',
            scoped(() =>
                ds.getRepository(Customer).findOne({ where: { id: 1 } }),
            ),
        ),
    );

    results.push(
        await measure(
            'typeorm-findUnique-1-level-nesting',
            scoped(() =>
                ds.getRepository(Customer).findOne({
                    where: { id: 1 },
                    relations: { orders: true },
                }),
            ),
        ),
    );

    /**
     * create
     */
    results.push(
        await measure(
            'typeorm-create',
            scoped(() =>
                ds.getRepository(Customer).save({
                    name: 'John Doe',
                    email: 'john.doe@example.com',
                    isActive: false,
                }),
            ),
        ),
    );

    const nestedCreate = () =>
        ds.transaction(async (transactionalEntityManager) => {
            // Insert customer
            const customer = await transactionalEntityManager.save(Customer, {
                name: 'John Doe',
                email: 'john.doe@example.com',
                isActive: false,
            });

            // Insert order with the associated customerId
            const order = await transactionalEntityManager.save(Order, {
                customer: customer,
                date: new Date(),
                totalAmount: 100.5,
            });

            // Insert products with the associated orderId
            await transactionalEntityManager
                .createQueryBuilder()
                .insert()
                .into('_OrderProducts')
                .values([
                    { A: order.id, B: 1 },
                    { A: order.id, B: 2 },
                ])
                .execute();
        });
    results.push(await measure('typeorm-nested-create', scoped(nestedCreate)));

    /**
     * update
     */
    results.push(
        await measure(
            'typeorm-update',
            scoped(() =>
                ds
                    .getRepository(Customer)
                    .update({ id: 1 }, { name: 'John Doe Updated' }),
            ),
        ),
    );

    results.push(
        await measure(
            'typeorm-nested-update',
            scoped(() =>
                ds.transaction(async (transactionalEntityManager) => {
                    // Update customer name
                    await transactionalEntityManager.update(
                        Customer,
                        { id: 1 },
                        { name: 'John Doe Updated' },
                    );

                    // Update address
                    await transactionalEntityManager.update(
                        Address,
                        { customer: { id: 1 } },
                        { street: '456 New St' },
                    );
                }),
            ),
        ),
    );

    /**
     * upsert
     */
    results.push(
        await measure(
            // Each attempt writes a new value: save() skips the UPDATE when nothing changed.
            'typeorm-upsert',
            scoped((attempt) =>
                ds.getRepository(Customer).save({
                    id: 1,
                    name: `John Doe Upserted ${attempt}`,
                    email: 'john.doe@example.com',
                    isActive: false,
                }),
            ),
        ),
    );

    // Nested upsert operation using transaction
    const nestedUpsert = (attempt: number) =>
        ds.transaction(async (transactionalEntityManager) => {
            // Upsert Customer
            const customer = await transactionalEntityManager.save(Customer, {
                id: 1, // Set the ID if you want to update an existing record
                name: `John Doe Upserted ${attempt}`,
                email: 'john.doe@example.com',
                isActive: false,
            });

            // Upsert Address
            await transactionalEntityManager.save(Address, {
                id: 1, // Set the ID if you want to update an existing record
                customer: customer,
                street: `456 New St ${attempt}`,
                city: 'Anytown',
                postalCode: '12345',
                country: 'Country',
            });
        });
    results.push(await measure('typeorm-nested-upsert', scoped(nestedUpsert)));

    /**
     * delete
     */
    results.push(
        await measure(
            'typeorm-delete',
            scoped((attempt) =>
                ds.getRepository(Customer).delete({ id: 1 + attempt }),
            ),
        ),
    );

    return results;
}

// export async function closeTypeORMPg() {
//   console.log(`closing connection with TypeORM`);
//   await AppDataSource.destroy();
// }
// main().catch((error) => console.log(error));
