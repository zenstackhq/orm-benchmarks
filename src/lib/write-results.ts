import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { runtime, runtimeVersion, sslFor, Target } from './drivers';
import { BenchmarkOptions, Database, MultipleBenchmarkRunResults } from './types';

/**
 * The directory for one benchmark run. benchmark.sh sets RESULTS_DIR so that every target, each in its
 * own process and on either runtime, writes to the same place.
 */
export function resultsDirectory(db: Database, options: BenchmarkOptions): string {
    const directory =
        process.env.RESULTS_DIR || path.join('.', `results/${db}-${options.size}-${options.iterations}-${Date.now()}`);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

/**
 * Two CSVs per target, each a header of operation labels and one row of milliseconds per iteration:
 * `<name>.csv` holds the median of each iteration's timed samples, and `<name>.first.csv` the
 * operation's first attempt in that iteration.
 */
export default function writeResults(name: string, results: MultipleBenchmarkRunResults, directory: string) {
    const headers = Array.from(new Set(results.flatMap((batch) => batch.map((item) => item.query))));
    const write = (file: string, pick: 'time' | 'first') => {
        const rows = results.map((batch) => {
            const row = Object.fromEntries(batch.map((item) => [item.query, item[pick]]));
            return headers.map((header) => row[header] ?? NaN);
        });
        fs.writeFileSync(path.join(directory, file), [headers.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n');
    };
    write(`${name}.csv`, 'time');
    write(`${name}.first.csv`, 'first');
    console.log(`Results for ${name} written to: ${path.join(directory, `${name}.csv`)}`);
}

function packageVersion(name: string): string | undefined {
    try {
        const file = path.join(process.cwd(), 'node_modules', name, 'package.json');
        return JSON.parse(fs.readFileSync(file, 'utf8')).version;
    } catch {
        return undefined;
    }
}

const PACKAGES = [
    '@zenstackhq/orm',
    'kysely',
    'kysely-postgres-js',
    'drizzle-orm',
    '@prisma/client',
    '@prisma/adapter-pg',
    'typeorm',
    'pg',
    'postgres',
];

/** Records what produced a CSV: runtime, driver, package versions and the database server. */
export async function writeEnvironment(directory: string, name: string, target: Target, options: BenchmarkOptions) {
    const client = new Client({ connectionString: options.databaseUrl, ssl: sslFor(options.databaseUrl) || undefined });
    await client.connect();
    const { rows } = await client.query<{ server_version: string }>('show server_version');
    await client.end();
    const environment = {
        target: name,
        orm: target.orm,
        driver: target.driver,
        policy: target.policy,
        runtime,
        runtimeVersion,
        platform: `${process.platform} ${process.arch}`,
        postgres: rows[0]?.server_version,
        iterations: options.iterations,
        size: options.size,
        label: process.env.LABEL ?? null,
        warmupPerOperation: Number(process.env.OP_WARMUP ?? 2),
        samplesPerOperation: Math.max(1, Number(process.env.OP_SAMPLES ?? 5)),
        packages: Object.fromEntries(PACKAGES.map((pkg) => [pkg, packageVersion(pkg)])),
        finishedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(environment, null, 2) + '\n');
}
