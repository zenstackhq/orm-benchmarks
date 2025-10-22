import {
    BenchmarkOptions,
    Database,
    MultipleBenchmarkRunResults,
} from './lib/types';
import fs from 'fs';
import path from 'path';

export function writeComparisonSummary(
    ormResults: Record<string, MultipleBenchmarkRunResults>,
    db: Database,
    benchmarkOptions: BenchmarkOptions,
    resultsDirectoryTimestamp: string
) {
    const zenstackResult = ormResults['zenstack'];
    if (!zenstackResult) {
        console.warn('No zenstack results found for comparison summary.');
        return;
    }

    const queries = zenstackResult[0].map((r) => formatQuery(r.query));

    const medians = Object.entries(ormResults).map(([orm, result]) => {
        return {
            orm,
            median: aggregateMedian(result),
        };
    });

    const zenstackMedian = medians.find((m) => m.orm === 'zenstack');
    if (!zenstackMedian) {
        console.warn('No zenstack results found for comparison summary.');
        return;
    }

    let content = `# Performance Comparison

Iteration count: ${benchmarkOptions.iterations}  
Dataset size: ${benchmarkOptions.size}

|ORM|${queries.join('|')}|
|---|${queries.map(() => '---').join('|')}|
`;

    content += `|zenstack|${queries
        .map((q) => zenstackMedian.median[q].toFixed(2))
        .join('|')}|\n`;

    for (const { orm, median } of medians) {
        if (orm === 'zenstack') continue;
        content += `|${orm}|${queries
            .map(
                (q) =>
                    median[q].toFixed(2) +
                    ' ' +
                    diffPercentage(median[q], zenstackMedian.median[q])
            )
            .join('|')}|\n`;
    }

    fs.writeFileSync(
        path.join(
            '.',
            `results/${db}-${benchmarkOptions.size}-${benchmarkOptions.iterations}-${resultsDirectoryTimestamp}/comparison.md`
        ),
        content
    );
}

function aggregateMedian(
    ormResult: MultipleBenchmarkRunResults
): Record<string, number> {
    const series: Record<string, number[]> = {};

    for (const run of ormResult) {
        for (const result of run) {
            const q = formatQuery(result.query);
            if (!series[q]) {
                series[q] = [];
            }
            series[q].push(result.time);
        }
    }

    // map series to median
    const medians = Object.entries(series).map(([query, times]) => {
        times.sort((a, b) => a - b);
        const mid = Math.floor(times.length / 2);
        const median =
            times.length % 2 !== 0
                ? times[mid]
                : (times[mid - 1] + times[mid]) / 2;
        return [query, median];
    });

    return Object.fromEntries(medians);
}

function formatQuery(query: string) {
    return query.split('-').slice(1).join('-');
}
function diffPercentage(value: number, baseline: number) {
    const diff = value - baseline;
    const percent = (diff / baseline) * 100;
    return diff > 0 ? `(+${percent.toFixed(2)}%)` : `(${percent.toFixed(2)}%)`;
}
