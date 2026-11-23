import { QueryResult } from './types';

// Each operation runs OP_WARMUP times untimed, then OP_SAMPLES times timed, and reports the median.
// The suite restores the dataset before every iteration, which leaves the process idle for about
// 100 ms. A single call timed right after that pause measured 3 to 5 times a warm call, and that
// constant hid most of the difference between ORMs. OP_WARMUP=0 OP_SAMPLES=1 times one call per
// iteration, as this suite used to.
const WARMUP = Number(process.env.OP_WARMUP ?? 2);
const SAMPLES = Math.max(1, Number(process.env.OP_SAMPLES ?? 5));

/**
 * Times one operation. `run` builds and starts the query inside the timed window, so an ORM whose
 * query objects are eager (a started promise) is timed the same way as one whose are lazy thenables.
 * `run` receives the attempt number, so an operation that cannot repeat on the same row (delete)
 * can target a different one each time.
 */
export default async function measure(
    label: string,
    run: (attempt: number) => PromiseLike<unknown>,
): Promise<QueryResult> {
    let attempt = 0;
    let first = NaN;
    const times: number[] = [];
    let result: unknown;
    for (; attempt < WARMUP + SAMPLES; attempt++) {
        const startTime = performance.now();
        result = await run(attempt);
        const elapsedTime = performance.now() - startTime;
        if (attempt === 0) first = elapsedTime;
        if (attempt >= WARMUP) times.push(elapsedTime);
    }
    times.sort((a, b) => a - b);
    const middle = Math.floor(times.length / 2);
    const elapsedTime =
        times.length % 2 === 1
            ? times[middle]
            : (times[middle - 1] + times[middle]) / 2;

    console.log(`${label}: ${elapsedTime.toFixed(2)}ms (first ${first.toFixed(2)}ms)`);

    return {
        query: label,
        time: elapsedTime,
        first,
        // only collect data if DEBUG mode is turned on
        data:
            process.env.DEBUG === 'benchmarks:compare-results' ? result : null,
    };
}
