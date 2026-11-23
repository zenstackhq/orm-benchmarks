import { Client } from 'pg';
import { sslFor } from './drivers';

/**
 * Shared setup for the `policy` targets. Every target enforces the same rule: a Customer belongs to
 * one tenant, and an Address or Order is visible only through a Customer of the caller's tenant.
 * Products are shared. Every seeded row belongs to TENANT, so the policy targets return the same rows
 * as the plain ones and the difference is the cost of enforcing the rule.
 *
 * Each ORM enforces it the way its own documentation recommends:
 * - ZenStack: access rules in the schema, applied by PolicyPlugin, on the regular connection.
 * - Drizzle, Prisma, TypeORM: PostgreSQL row-level security on a role that cannot bypass it, with
 *   the tenant set by `set_config(..., true)` inside a transaction around every operation. That is
 *   the only way to carry a per-request tenant over a shared connection pool.
 */
export const TENANT = 1;
export const OTHER_TENANT = 2;
export const TENANT_SETTING = 'app.tenant_id';
export const POLICY_ROLE = 'bench_app';

/** The benchmark database URL with the row-level-security role's credentials. */
export function policyUrl(databaseUrl: string): string {
    const url = new URL(databaseUrl);
    url.username = POLICY_ROLE;
    url.password = POLICY_ROLE;
    return url.toString();
}

const tenantCheck = `"tenantId" = nullif(current_setting('${TENANT_SETTING}', true), '')::int`;
const throughCustomer = `EXISTS (SELECT 1 FROM "Customer" c WHERE c.id = "customerId" AND c."tenantId" = nullif(current_setting('${TENANT_SETTING}', true), '')::int)`;

/**
 * Creates the role and the row-level-security policies. The restore drops the schema before every
 * iteration, so this runs after every restore. Superusers bypass row-level security, so the plain
 * targets, which connect as the database owner, are unaffected.
 */
export async function applyRowLevelSecurity(databaseUrl: string) {
    const client = new Client({ connectionString: databaseUrl, ssl: sslFor(databaseUrl) || undefined });
    await client.connect();
    try {
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${POLICY_ROLE}') THEN
                    CREATE ROLE ${POLICY_ROLE} LOGIN PASSWORD '${POLICY_ROLE}' NOBYPASSRLS;
                END IF;
            END $$;
            GRANT USAGE ON SCHEMA public TO ${POLICY_ROLE};
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${POLICY_ROLE};
            GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${POLICY_ROLE};

            ALTER TABLE "Customer" ENABLE ROW LEVEL SECURITY;
            DROP POLICY IF EXISTS tenant_isolation ON "Customer";
            CREATE POLICY tenant_isolation ON "Customer" FOR ALL TO ${POLICY_ROLE}
                USING (${tenantCheck}) WITH CHECK (${tenantCheck});

            ALTER TABLE "Address" ENABLE ROW LEVEL SECURITY;
            DROP POLICY IF EXISTS tenant_isolation ON "Address";
            CREATE POLICY tenant_isolation ON "Address" FOR ALL TO ${POLICY_ROLE}
                USING (${throughCustomer}) WITH CHECK (${throughCustomer});

            ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
            DROP POLICY IF EXISTS tenant_isolation ON "Order";
            CREATE POLICY tenant_isolation ON "Order" FOR ALL TO ${POLICY_ROLE}
                USING (${throughCustomer}) WITH CHECK (${throughCustomer});
        `);
    } finally {
        await client.end();
    }
}

/**
 * Fails the run unless the caller's tenant sees rows and another tenant sees none, so a policy
 * target can never report the timing of a check that is not in place.
 */
export function assertIsolation(target: string, own: number, other: number) {
    if (own === 0 || other !== 0) {
        throw new Error(`${target}: policy is not enforced (tenant ${TENANT} sees ${own} customers, tenant ${OTHER_TENANT} sees ${other}).`);
    }
    console.log(`${target}: policy enforced (tenant ${TENANT} sees ${own} customers, tenant ${OTHER_TENANT} sees ${other}).`);
}
