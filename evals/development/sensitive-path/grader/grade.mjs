const { SESSION_TTL_MS } = await import(`${process.cwd()}/src/auth/session.mjs`);
process.exit(SESSION_TTL_MS === 30 * 60 * 1000 ? 0 : 1);
