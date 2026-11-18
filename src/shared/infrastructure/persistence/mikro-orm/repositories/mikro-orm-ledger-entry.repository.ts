import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';

import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity';
import type { LedgerEntryRepository } from '@/shared/kernel/ports/ledger-entry-repository.port';
import { DomainError } from '@/shared/domain/errors/domain-error';

interface LedgerCursor {
  t: string; // ISO-8601 createdAt of the last entry on the previous page
  id: string; // UUID tie-breaker: many entries can share a timestamp
}

/** Opaque, URL-safe cursor: callers must not depend on its internal shape. */
function encodeCursor(cursor: LedgerCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): LedgerCursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as LedgerCursor;
    if (
      typeof parsed.t !== 'string' ||
      typeof parsed.id !== 'string' ||
      Number.isNaN(Date.parse(parsed.t))
    ) {
      throw new Error('invalid cursor fields');
    }
    return parsed;
  } catch {
    throw new DomainError('INVALID_CURSOR', 'invalid ledger cursor', 400);
  }
}

@Injectable()
export class MikroOrmLedgerEntryRepository implements LedgerEntryRepository {
  constructor(private readonly em: EntityManager<PostgreSqlDriver>) {}

  async findByTransactionId(
    transactionId: string,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<WalletLedgerEntry | null> {
    return (em ?? this.em).findOne(WalletLedgerEntry, { transactionId });
  }

  /**
   * Keyset pagination over (createdAt DESC, id DESC). A timestamp-only cursor
   * would silently drop ledger entries created in the same millisecond.
   */
  async findByWallet(
    walletId: string,
    cursor?: string,
    limit = 50,
    em?: EntityManager<PostgreSqlDriver>,
  ): Promise<{ entries: WalletLedgerEntry[]; nextCursor?: string }> {
    const where: any = { walletId };
    if (cursor) {
      const decoded = decodeCursor(cursor);
      const at = new Date(decoded.t);
      where.$or = [
        { createdAt: { $lt: at } },
        { createdAt: at, id: { $lt: decoded.id } },
      ];
    }

    const rows = await (em ?? this.em).find(WalletLedgerEntry, where, {
      limit: limit + 1,
      orderBy: { createdAt: 'DESC', id: 'DESC' },
    });

    const entries = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const last = entries.at(-1);
    if (!hasMore || !last) return { entries };

    return {
      entries,
      nextCursor: encodeCursor({ t: last.createdAt.toISOString(), id: last.id }),
    };
  }

  async save(entry: WalletLedgerEntry, em?: EntityManager<PostgreSqlDriver>): Promise<void> {
    (em ?? this.em).persist(entry);
  }
}
