/**
 * Standalone HTTP client used by the multi-process concurrency test.
 * Each invocation is a separate OS process with its own network stack.
 *
 * Usage: bun test/concurrency/http-worker.ts <baseUrl> <walletId> <playerId> <workerIndex> <count>
 */
const [baseUrl, walletId, playerId, workerIndex, countArg] = process.argv.slice(2);
const count = Number(countArg ?? '10');

const results = await Promise.all(
  Array.from({ length: count }, (_, i) =>
    fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': `provider-1:mp-${workerIndex}-${i}`,
      },
      body: JSON.stringify({
        providerId: 'provider-1',
        externalTransactionId: `mp-${workerIndex}-${i}`,
        walletId,
        playerId,
        roundId: `round-${workerIndex}-${i}`,
        gameId: 'game-001',
        kind: 'BET',
        money: { amount: '1.00', currency: 'BRL' },
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })),
  ),
);

console.log(JSON.stringify({ workerIndex, results }));

export {};
