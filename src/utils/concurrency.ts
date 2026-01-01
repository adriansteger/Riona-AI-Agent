
/**
 * A simple concurrency limit utility (similar to p-limit).
 * @param concurrency The maximum number of concurrent promises.
 * @returns A generator function that accepts a promise-returning function.
 */
export function pLimit(concurrency: number) {
    const queue: (() => void)[] = [];
    let activeCount = 0;

    const next = () => {
        activeCount--;
        if (queue.length > 0) {
            const nextTask = queue.shift();
            nextTask!();
        }
    };

    const run = async <T>(fn: () => Promise<T>, resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => {
        activeCount++;
        const result = (async () => fn())();
        try {
            const value = await result;
            resolve(value);
        } catch (err) {
            reject(err);
        } finally {
            next();
        }
    };

    const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
        return new Promise<T>((resolve, reject) => {
            const task = () => run(fn, resolve, reject);
            if (activeCount < concurrency) {
                task();
            } else {
                queue.push(task);
            }
        });
    };

    return enqueue;
}
