// Order standalone cleanup with the original Windows helper's end_turn request.
// Every helper operation still goes through the installed transport.

const END_TURN_GRACE_MS = 1500;
const turnKey = ({sessionId, turnId}) => JSON.stringify([sessionId, turnId]);

export let WindowsHelperTransport;

export function attachTurnCleanup(OriginalTransport, closeTurn) {
  const pending = new Map();

  WindowsHelperTransport = class extends OriginalTransport {
    async request(method, params, options) {
      const {session_id: sessionId, turn_id: turnId} = options?.codexTurnMetadata ?? {};
      if (method !== 'end_turn' || typeof sessionId !== 'string' || !sessionId.trim() ||
          typeof turnId !== 'string' || !turnId.trim()) {
        return super.request(method, params, options);
      }

      const ids = {sessionId, turnId};
      const key = turnKey(ids);
      let batch = pending.get(key);
      if (!batch) {
        const completion = Promise.withResolvers();
        let cleanup;
        const finish = () => {
          clearTimeout(timer);
          cleanup ??= Promise.resolve().then(() => closeTurn(ids)).then(completion.resolve, completion.reject);
          return completion.promise;
        };
        // A stuck helper must not keep its own shutdown waiting indefinitely.
        const timer = setTimeout(() => { void finish().catch(() => {}); }, END_TURN_GRACE_MS);
        timer.unref();
        batch = {count: 0, finish, result: completion.promise};
        pending.set(key, batch);
      }
      batch.count++;
      try {
        return await super.request(method, params, options);
      } finally {
        if (--batch.count === 0) {
          // The original pipe host clears this ID when its request returns. Close
          // while it can still match the turn, after the helper handled end_turn.
          try { await batch.finish(); }
          finally { pending.delete(key); }
        } else {
          await batch.result;
        }
      }
    }
  };

  return ids => pending.get(turnKey(ids))?.result ?? closeTurn(ids);
}
