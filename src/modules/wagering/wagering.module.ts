import { Module } from '@nestjs/common';
import { SubmitWagerTransactionUseCase } from '@/modules/wagering/services/submit-wager-transaction.use-case';
import { ProcessPendingReferencesUseCase } from '@/modules/wagering/services/process-pending-references.use-case';
import { WageringController } from '@/modules/wagering/controllers/wagering.controller';
import { PersistenceModule } from '@/shared/infrastructure/persistence/persistence.module';
import { MessagingModule } from '@/infrastructure/messaging/messaging.module';
import { SqsConsumerService } from '@/infrastructure/sqs-consumer/sqs-consumer.service';
import { PendingReferencesWorker } from '@/infrastructure/workers/pending-references-worker.service';

@Module({
  imports: [PersistenceModule, MessagingModule],
  providers: [
    SubmitWagerTransactionUseCase,
    ProcessPendingReferencesUseCase,
    SqsConsumerService,
    PendingReferencesWorker,
  ],
  controllers: [WageringController],
  exports: [SubmitWagerTransactionUseCase, ProcessPendingReferencesUseCase],
})
export class WageringModule {}
