import fs from 'fs';
import path from 'path';

type Stats = { first: number; median: number; p95: number; samples: number };
type TargetSummary = { name: string; environment: Record<string, any>; stats: Record<string, Stats> };

const BASELINE = process.env.BASELINE || 'zenstack-pg-node';

function quantile(sorted: number[], q: number): number {
    if (sorted.length === 0) return NaN;
    const position = (sorted.length - 1) * q;
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function formatQuery(query: string) {
    return query.split('-').slice(1).join('-');
}

function readCsv(file: string): { queries: string[]; rows: number[][] } {
    const [header, ...lines] = fs.readFileSync(file, 'utf8').trim().split('\n');
    return { queries: header.split(',').map(formatQuery), rows: lines.map((line) => line.split(',').map(Number)) };
}

function readTarget(directory: string, file: string): TargetSummary {
    const name = file.replace(/\.csv$/, '');
    const { queries, rows } = readCsv(path.join(directory, file));
    const firstFile = path.join(directory, `${name}.first.csv`);
    // The very first attempt of each operation in iteration 1. Older runs have no .first.csv.
    const firstRow = fs.existsSync(firstFile) ? readCsv(firstFile).rows[0] : rows[0];
    const environmentFile = path.join(directory, `${name}.json`);
    const environment = fs.existsSync(environmentFile) ? JSON.parse(fs.readFileSync(environmentFile, 'utf8')) : {};
    const stats: Record<string, Stats> = {};
    queries.forEach((query, column) => {
        // Iteration 1 is the first call on each connection. The medians come from the rest.
        const warm = rows.slice(rows.length > 1 ? 1 : 0).map((row) => row[column]).sort((a, b) => a - b);
        stats[query] = { first: firstRow?.[column] ?? NaN, median: quantile(warm, 0.5), p95: quantile(warm, 0.95), samples: warm.length };
    });
    return { name, environment, stats };
}

function diffPercentage(value: number, baseline: number) {
    const percent = ((value - baseline) / baseline) * 100;
    return percent > 0 ? `(+${percent.toFixed(2)}%)` : `(${percent.toFixed(2)}%)`;
}

function table(targets: TargetSummary[], queries: string[], pick: (stats: Stats) => number, baseline?: TargetSummary) {
    let content = `|Target|${queries.join('|')}|\n|---|${queries.map(() => '---').join('|')}|\n`;
    for (const target of targets) {
        const cells = queries.map((query) => {
            const value = pick(target.stats[query]);
            const base = baseline && baseline !== target ? pick(baseline.stats[query]) : undefined;
            return value.toFixed(2) + (base !== undefined ? ' ' + diffPercentage(value, base) : '');
        });
        content += `|${target.name}|${cells.join('|')}|\n`;
    }
    return content;
}

/** Writes comparison.md for every CSV in a results directory. */
export function writeComparisonSummary(directory: string) {
    const files = fs.readdirSync(directory).filter((file) => file.endsWith('.csv') && !file.endsWith('.first.csv')).sort();
    if (files.length === 0) return;
    const runtimeOrder = (name: string) => (name.endsWith('-node') ? 0 : 1);
    const targets = files.map((file) => readTarget(directory, file)).sort((a, b) => runtimeOrder(a.name) - runtimeOrder(b.name) || a.name.localeCompare(b.name));
    const baseline = targets.find((target) => target.name === BASELINE) ?? targets.find((target) => target.name.startsWith('zenstack'));
    const queries = Object.keys(targets[0].stats);
    const sample = targets[0].environment;
    const runtimes = Array.from(new Set(targets.map((target) => `${target.environment.runtime} ${target.environment.runtimeVersion}`)));

    let content = `# Performance Comparison

Iteration count: ${sample.iterations ?? '?'}  
Dataset size: ${sample.size ?? '?'}  
Runtimes: ${runtimes.join(', ')}  
PostgreSQL: ${sample.postgres ?? '?'}  
Per operation and iteration: ${sample.warmupPerOperation ?? '?'} untimed, then ${sample.samplesPerOperation ?? '?'} timed${sample.label ? `  \nLabel: ${sample.label}` : ''}

A target is ORM, driver and runtime. Times are milliseconds per operation. Each iteration contributes the median of its timed samples. Percentages compare with ${baseline?.name ?? 'nothing'}.

## Median, iterations 2 to ${sample.iterations ?? 'n'}

${table(targets, queries, (stats) => stats.median, baseline)}
## p95, iterations 2 to ${sample.iterations ?? 'n'}

${table(targets, queries, (stats) => stats.p95, baseline)}
## First call (iteration 1)

Attempt zero of each operation in the first iteration, before any warm-up. It includes only work done inside that call: preparing the statement, for drivers that prepare on first use, and opening a connection only when the target had not opened one before timing. Connection setup and the policy targets' isolation check happen before timing and are not in these numbers.

${table(targets, queries, (stats) => stats.first)}`;

    fs.writeFileSync(path.join(directory, 'comparison.md'), content);
    console.log(`Comparison written to ${path.join(directory, 'comparison.md')}`);
}

// `node dist/summary.js <results directory>` or `bun src/summary.ts <results directory>`.
if (require.main === module) {
    const directory = process.argv[2];
    if (!directory) {
        console.error('Usage: summary <results directory>');
        process.exit(1);
    }
    writeComparisonSummary(directory);
}
