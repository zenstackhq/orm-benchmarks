import { ORM } from './types';

/**
 * The PostgreSQL drivers an ORM can run on.
 *
 * - `pg`: node-postgres. Sends each query as an unnamed statement, one round trip.
 * - `postgres-js`: postgres.js. Prepares named statements by default, so the first use of a
 *   statement on a connection costs an extra round trip.
 * - `bun-sql`: Bun's built-in `SQL` client. Bun only. Also prepares statements by default.
 */
export type Driver = 'pg' | 'postgres-js' | 'bun-sql';

export type Runtime = 'node' | 'bun';

const bun = (globalThis as { Bun?: { version: string; SQL: new (options: object) => unknown } }).Bun;

export const runtime: Runtime = bun ? 'bun' : 'node';
export const runtimeVersion = bun ? bun.version : process.versions.node;

/** Which drivers each ORM supports. Prisma and TypeORM have no postgres.js or Bun.SQL driver. */
export const ORM_DRIVERS: Record<ORM, Driver[]> = {
    zenstack: ['pg', 'postgres-js', 'bun-sql'],
    drizzle: ['pg', 'postgres-js', 'bun-sql'],
    prisma: ['pg'],
    typeorm: ['pg'],
};

/**
 * The drivers each ORM's `policy` target runs on. Every ORM enforces the same tenant rule, each in
 * its own documented way; see src/lib/policies.ts. node-postgres is the one driver all four share.
 */
export const POLICY_DRIVERS: Record<ORM, Driver[]> = {
    zenstack: ['pg'],
    drizzle: ['pg'],
    prisma: ['pg'],
    typeorm: ['pg'],
};

export type Target = { orm: ORM; driver: Driver; policy: boolean };

export function targetName({ orm, driver, policy }: Target): string {
    return `${orm}${policy ? '-policy' : ''}-${driver}-${runtime}`;
}

/** `orm:driver`, or `orm:driver:policy`, as TARGETS and `--list` write it. */
export function targetSpec({ orm, driver, policy }: Target): string {
    return `${orm}:${driver}${policy ? ':policy' : ''}`;
}

/** Every ORM, driver and mode that can run on the current runtime. */
export function availableTargets(): Target[] {
    const runnable = (driver: Driver) => driver !== 'bun-sql' || runtime === 'bun';
    return (Object.keys(ORM_DRIVERS) as ORM[]).flatMap((orm) => [
        ...ORM_DRIVERS[orm].filter(runnable).map((driver) => ({ orm, driver, policy: false })),
        ...POLICY_DRIVERS[orm].filter(runnable).map((driver) => ({ orm, driver, policy: true })),
    ]);
}

/**
 * Parses `TARGETS`, a comma-separated list such as `zenstack:pg,drizzle:bun-sql,prisma:pg:policy`.
 * An entry with no driver, such as `prisma`, means every driver and mode that ORM supports here.
 */
export function selectTargets(spec: string | undefined): Target[] {
    const available = availableTargets();
    if (!spec) return available;
    return spec.split(',').flatMap((entry) => {
        const [orm, driver, mode, ...rest] = entry.trim().split(':');
        if (rest.length > 0 || (mode !== undefined && mode !== 'policy')) {
            throw new Error(`Target ${entry}: the third part can only be "policy".`);
        }
        if (mode !== undefined && !driver) {
            throw new Error(`Target ${entry}: name the driver for a policy target, such as ${orm}:pg:policy.`);
        }
        const matches = available.filter(
            (target) =>
                target.orm === orm &&
                (!driver || target.driver === driver) &&
                (!driver || target.policy === (mode === 'policy')),
        );
        if (matches.length === 0) {
            throw new Error(`Target ${entry} is not available on ${runtime}. Available: ${available.map(targetSpec).join(', ')}`);
        }
        return matches;
    });
}

export function sslFor(databaseUrl: string): false | { rejectUnauthorized: false } {
    return /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false };
}

/** Bun's `SQL` client. Only callable on Bun; the import is resolved at run time so Node never loads it. */
export function bunSql(databaseUrl: string): any {
    if (!bun) throw new Error('The bun-sql driver needs the Bun runtime.');
    const ssl = sslFor(databaseUrl);
    return new bun.SQL({ url: databaseUrl, ...(ssl ? { tls: ssl } : {}) });
}
