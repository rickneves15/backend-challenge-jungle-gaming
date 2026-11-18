import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

import { DatabaseModule } from '@/infrastructure/persistence/database.module';
import { KernelModule } from '@/shared/kernel/kernel.module';
import { PersistenceModule } from '@/shared/infrastructure/persistence/persistence.module';
import { MessagingModule } from '@/infrastructure/messaging/messaging.module';
import { WalletsModule } from '@/modules/wallets/wallets.module';
import { WageringModule } from '@/modules/wagering/wagering.module';
import { ReconciliationModule } from '@/modules/reconciliation/reconciliation.module';
import { HealthModule } from '@/infrastructure/health/health.module';
import { MetricsModule } from '@/shared/infrastructure/observability/metrics.module';
import {
  AllExceptionsFilter,
  DomainErrorFilter,
} from '@/shared/infrastructure/http/domain-error.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.development', '.env'],
      ignoreEnvFile: process.env.NODE_ENV === 'production',
    }),
    KernelModule,
    DatabaseModule,
    PersistenceModule,
    MessagingModule,
    WalletsModule,
    WageringModule,
    ReconciliationModule,
    HealthModule,
    MetricsModule,
  ],
  providers: [
    // Nest applies global filters from the end of the list, so the catch-all
    // must be registered first and the specific DomainErrorFilter last.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
