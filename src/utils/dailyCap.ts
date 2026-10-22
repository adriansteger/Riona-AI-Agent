const hashString = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
};

// mulberry32: tiny seeded PRNG returning a float in [0, 1)
const seededRandom = (seed: number): number => {
    let t = (seed + 0x6D2B79F5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * Effective daily like cap: `base` varied by +/- `jitterPercent`.
 * Deterministic per (accountId, local date) so it stays stable across loop
 * iterations and restarts, but differs between accounts and days.
 */
export const getDailyLikeCap = (accountId: string, base: number, jitterPercent = 20): number => {
    const j = Math.min(Math.max(jitterPercent, 0), 90) / 100;
    if (j === 0) return base;
    const now = new Date();
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const rand = seededRandom(hashString(`${accountId}:${day}`));
    return Math.max(1, Math.round(base * (1 - j + 2 * j * rand)));
};
