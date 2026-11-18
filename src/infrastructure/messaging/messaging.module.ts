import { Module } from '@nestjs/common';

import { OutboxWorker } from '@/infrastructure/sqs-consumer/outbox-worker.service';
import { sqsClientProvider, sqsQueueUrlProvider } from './sqs-client.provider';
import { SQS_CLIENT, SQS_QUEUE_URL } from './sqs.tokens';
import { PersistenceModule } from '@/shared/infrastructure/persistence/persistence.module';

/** Owns the shared SQS client and the background outbox publisher. */
@Module({
  imports: [PersistenceModule],
  providers: [sqsClientProvider, sqsQueueUrlProvider, OutboxWorker],
  exports: [OutboxWorker, SQS_CLIENT, SQS_QUEUE_URL],
})
export class MessagingModule {}
