import dotenv from 'dotenv';
import { availableTargets, runtime, runtimeVersion, selectTargets, targetSpec } from './lib/drivers';
import { extractDatabase } from './lib/utils';
import runBenchmarksPg from './run-benchmarks-pg';

dotenv.config();

const iterations = Number(process.env.ITERATIONS) || 5;
const size = Number(process.env.SIZE) || 1000;
const fakerSeed = Number(process.env.SEED) || 42;

async function main() {
    // `--list` prints the ORM and driver pairs this runtime can run, one per line, for benchmark.sh.
    if (process.argv.includes('--list')) {
        console.log(availableTargets().map(targetSpec).join('\n'));
        return;
    }

    if (!process.env.DATABASE_URL) {
        console.error(`No database URL provided`);
        process.exitCode = 1;
        return;
    }
    const databaseUrl = process.env.DATABASE_URL;
    const database = extractDatabase(databaseUrl);

    if (database !== 'postgresql') {
        console.log(`${database} is not yet available.`);
        return;
    }

    const targets = selectTargets(process.env.TARGETS);
    console.log(`Running benchmarks on ${databaseUrl} with ${runtime} ${runtimeVersion}.`);
    await runBenchmarksPg({ databaseUrl, iterations, size, fakerSeed }, targets);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    // Pools keep the event loop alive. Every target's results are written before this point.
    .finally(() => process.exit());
