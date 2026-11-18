import { Module } from '@nestjs/common';
import { ReconcileWalletUseCase } from '@/modules/reconciliation/services/reconcile-wallet.use-case';
import { ReconciliationController } from '@/modules/reconciliation/controllers/reconciliation.controller';
import { PersistenceModule } from '@/shared/infrastructure/persistence/persistence.module';

@Module({
  imports: [PersistenceModule],
  providers: [ReconcileWalletUseCase],
  controllers: [ReconciliationController],
})
export class ReconciliationModule {}
