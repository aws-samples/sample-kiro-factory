/**
 * Imported first by tests that drive the real `ConnectionStore` against the
 * in-process mock: the URL guard must accept plain http to loopback before
 * `net.ts` reads the flag at module load. Nothing else is relaxed.
 */
process.env.KIROFACTORY_INSECURE_FLOCK = '1';
process.env.MOCK_FLOCK_NO_LISTEN = '1';
export {};
