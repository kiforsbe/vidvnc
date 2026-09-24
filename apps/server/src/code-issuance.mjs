import { CODE_ALPHABETS } from './connection-keys.mjs';

export function createCodeIssuer({ access, sessionStore, admission = null }) {
  const options = (requested, ephemeral) => {
    const settings = access.snapshot();
    const alphabet = requested ?? settings.defaultCodeAlphabet;
    if (!Object.hasOwn(CODE_ALPHABETS, alphabet)) throw new Error('Invalid code alphabet');
    return {
      settings,
      alphabet,
      limits: {
        globalLimit: ephemeral
          ? settings.shortCodeMaxFailures
          : settings.sessionPasswordMaxFailures,
        sourceLimit: Math.min(
          ephemeral ? settings.shortCodePerSourceMaxFailures : 5,
          ephemeral ? settings.shortCodeMaxFailures : settings.sessionPasswordMaxFailures,
        ),
      },
    };
  };
  return {
    oneTime(requested) {
      const { settings, alphabet, limits } = options(requested, true);
      if (settings.connectionMode === 'approved-only')
        throw new Error('Ordinary connection keys are not enabled');
      return sessionStore.keys.createOneTimeConnection({
        ttlMs: settings.shortCodeTtlSeconds * 1000,
        alphabet,
        limits,
      });
    },
    setup(requested) {
      const { settings, alphabet, limits } = options(requested, true);
      return sessionStore.keys.createSetup({
        ttlMs: settings.shortCodeTtlSeconds * 1000,
        alphabet,
        limits,
      });
    },
    rotateSession(requested) {
      const { alphabet, limits } = options(requested, false);
      const key = sessionStore.rotateConnectionKey(alphabet, limits);
      return { key, alphabet, expiresAt: null, ...sessionStore.keys.activeSession() };
    },
    status() {
      const attempts = admission?.stats();
      const describe = (record, counter) => {
        if (!record) return null;
        const failures = counter?.generation === record.generation ? counter.failures : 0;
        return {
          purpose: record.purpose,
          alphabet: record.alphabet,
          expiresAt: record.expiresAt,
          failures,
          globalLimit: record.globalLimit,
          locked: failures >= record.globalLimit,
        };
      };
      return {
        ephemeral: describe(sessionStore.keys.activeEphemeral(), attempts?.ephemeral),
        session: describe(sessionStore.keys.activeSession(), attempts?.session),
      };
    },
  };
}
