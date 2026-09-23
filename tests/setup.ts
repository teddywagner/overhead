// Global test preload. Keeps tests deterministic and quiet.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
