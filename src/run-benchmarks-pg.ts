import { drizzlePg } from './drizzle/drizzle-pg';
import { compareResults } from './lib/compare-results';
import { preparePg } from './lib/prepare-pg-native'; // seed via `pg_restore`
// import { preparePg } from "./lib/prepare-pg-prisma"; // seed via `createMany`
import { BenchmarkOptions, MultipleBenchmarkRunResults } from './lib/types';
import writeResults from './lib/write-results';
import { prismaPg } from './prisma/prisma-pg';
import { writeComparisonSummary } from './summary';
import { typeormPg } from './typeorm/typeorm-pg';
import { zenstackPg } from './zenstack/zenstack-pg';

export default async function runBenchmarksPg(
    benchmarkOptions: BenchmarkOptions
) {
    const { databaseUrl, iterations, size, fakerSeed } = benchmarkOptions;

    const resultsDirectoryTimestamp = Date.now().toString();

    const zenstackResults: MultipleBenchmarkRunResults = [];
    for (let i = 0; i < iterations; i++) {
        await preparePg({ databaseUrl, size, fakerSeed });
        const results = await zenstackPg(databaseUrl);
        zenstackResults.push(results);
    }
    writeResults(
        'zenstack',
        'postgresql',
        zenstackResults,
        benchmarkOptions,
        resultsDirectoryTimestamp
    );

    const prismaResults: MultipleBenchmarkRunResults = [];
    for (let i = 0; i < iterations; i++) {
        await preparePg({ databaseUrl, size, fakerSeed });
        const results = await prismaPg(databaseUrl);
        prismaResults.push(results);
    }
    writeResults(
        'prisma',
        'postgresql',
        prismaResults,
        benchmarkOptions,
        resultsDirectoryTimestamp
    );

    const drizzleResults: MultipleBenchmarkRunResults = [];
    for (let i = 0; i < iterations; i++) {
        await preparePg({ databaseUrl, size, fakerSeed });
        const results = await drizzlePg(databaseUrl);
        drizzleResults.push(results);
    }
    writeResults(
        'drizzle',
        'postgresql',
        drizzleResults,
        benchmarkOptions,
        resultsDirectoryTimestamp
    );

    const typeormResults: MultipleBenchmarkRunResults = [];
    for (let i = 0; i < iterations; i++) {
        await preparePg({ databaseUrl, size, fakerSeed });
        const results = await typeormPg(databaseUrl);
        typeormResults.push(results);
    }
    writeResults(
        'typeorm',
        'postgresql',
        typeormResults,
        benchmarkOptions,
        resultsDirectoryTimestamp
    );

    writeComparisonSummary(
        {
            zenstack: zenstackResults,
            prisma: prismaResults,
            drizzle: drizzleResults,
            typeorm: typeormResults,
        },
        'postgresql',
        benchmarkOptions,
        resultsDirectoryTimestamp
    );

    // Optionally compare results
    if (process.env.DEBUG === 'benchmarks:compare-results') {
        compareResults({
            prismaResults,
            drizzleResults,
            typeormResults,
            zenstackResults,
        });
    }
}
