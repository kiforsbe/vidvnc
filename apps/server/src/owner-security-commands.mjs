import { CLIENT_PERMISSIONS } from './approved-clients.mjs';

export function createOwnerSecurityCommands({ store, approvedClients, runtime }) {
  async function stopUnsafeSharing(error) {
    let shutdownError;
    try {
      for (const row of store.list()) store.disconnect(row.sessionId);
      store.stop();
    } catch (failure) {
      shutdownError = failure;
    }
    try {
      await runtime.shutdown();
    } catch (failure) {
      shutdownError ??= failure;
    }
    if (shutdownError) throw new AggregateError([error, shutdownError], 'Sharing shutdown failed');
    throw error;
  }
  return {
    approved(command) {
      if (!approvedClients) return Promise.reject(new Error('Approved clients are unavailable'));
      const { action, id, permission } = command;
      if (action !== 'remove' && action !== 'permission')
        return Promise.reject(new Error('Invalid approved-client action'));
      if (action === 'permission' && !CLIENT_PERMISSIONS.includes(permission))
        return Promise.reject(new Error('Invalid client permission'));
      let affected;
      let revocation;
      try {
        affected = store.list().filter((row) => row.approvedClientId === id);
        approvedClients.invalidate(id, action === 'remove' ? 'remove' : 'downgrade');
        // Start the native denial while the runtime can still find the affected owners.
        // Disconnect their bearers in the same turn, before any asynchronous wait.
        try {
          revocation = runtime.revokeApprovedClient(id);
        } catch (error) {
          revocation = Promise.reject(error);
        }
        for (const row of affected) store.disconnect(row.sessionId);
      } catch (error) {
        return Promise.reject(error);
      }
      return (async () => {
        let revoked;
        try {
          [revoked] = await Promise.all([
            revocation,
            ...affected.map((row) => runtime.stopSession(row.sessionId)),
          ]);
        } catch (error) {
          return stopUnsafeSharing(error);
        }
        if (!revoked || (!revoked.nativeAck && !revoked.peerTerminated))
          return stopUnsafeSharing(
            new Error('Native control denial was not acknowledged or peer teardown confirmed.'),
          );
        try {
          if (action === 'remove') {
            await approvedClients.remove(id);
          } else await approvedClients.setPermission(id, permission);
        } catch (error) {
          return stopUnsafeSharing(error);
        }
        if (!revoked.nativeAck)
          throw new Error(
            'Native control denial was not acknowledged; the affected peer was terminated.',
          );
        return { affected: affected.length };
      })();
    },
    async disconnectOrdinary() {
      const affected = store.list().filter((row) => row.approvedClientId === null);
      for (const row of affected) store.disconnect(row.sessionId);
      try {
        await Promise.all(affected.map((row) => runtime.stopSession(row.sessionId)));
      } catch (error) {
        return stopUnsafeSharing(error);
      }
      return { disconnected: affected.length };
    },
  };
}
