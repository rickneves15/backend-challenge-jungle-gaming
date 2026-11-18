import { Global, Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';

import { Wallet } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet.entity';
import { WagerTransaction } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import { WalletLedgerEntry } from '@/shared/infrastructure/persistence/mikro-orm/entities/wallet-ledger-entry.entity';
import { InboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/inbox-message.entity';
import { OutboxMessage } from '@/shared/infrastructure/persistence/mikro-orm/entities/outbox-message.entity';
import { MikroOrmUnitOfWork } from '@/shared/infrastructure/persistence/mikro-orm/mikro-orm-uow.service';
import { MikroOrmWalletRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wallet.repository';
import { MikroOrmWagerTransactionRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-wager-transaction.repository';
import { MikroOrmLedgerEntryRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-ledger-entry.repository';
import { MikroOrmInboxRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-inbox.repository';
import { MikroOrmOutboxRepository } from '@/shared/infrastructure/persistence/mikro-orm/repositories/mikro-orm-outbox.repository';
import { MikroOrmMetricsSnapshotRepository } from '@/shared/infrastructure/observability/mikro-orm-metrics-snapshot.repository';
import {
  INBOX_REPOSITORY,
  LEDGER_ENTRY_REPOSITORY,
  METRICS_SNAPSHOT_REPOSITORY,
  OUTBOX_REPOSITORY,
  UNIT_OF_WORK,
  WAGER_TRANSACTION_REPOSITORY,
  WALLET_REPOSITORY,
} from '@/shared/kernel/ports/tokens';

const portProviders = [
  { provide: UNIT_OF_WORK, useExisting: MikroOrmUnitOfWork },
  { provide: WALLET_REPOSITORY, useClass: MikroOrmWalletRepository },
  { provide: WAGER_TRANSACTION_REPOSITORY, useClass: MikroOrmWagerTransactionRepository },
  { provide: LEDGER_ENTRY_REPOSITORY, useClass: MikroOrmLedgerEntryRepository },
  { provide: INBOX_REPOSITORY, useClass: MikroOrmInboxRepository },
  { provide: OUTBOX_REPOSITORY, useClass: MikroOrmOutboxRepository },
  {
    provide: METRICS_SNAPSHOT_REPOSITORY,
    useClass: MikroOrmMetricsSnapshotRepository,
  },
];

@Global()
@Module({
  imports: [
    MikroOrmModule.forFeature({
      entities: [Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, OutboxMessage],
    }),
  ],
  providers: [MikroOrmUnitOfWork, ...portProviders],
  exports: [
    MikroOrmUnitOfWork,
    ...portProviders.map((provider) => provider.provide),
  ],
})
export class PersistenceModule {}
