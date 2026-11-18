import { Injectable, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

import {
  SQS_CLIENT,
  SQS_QUEUE_URL,
} from '@/infrastructure/messaging/sqs.tokens';

@Injectable()
export class HealthService {
  constructor(
    private readonly em: EntityManager<PostgreSqlDriver>,
    @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    @Inject(SQS_QUEUE_URL) private readonly queueUrl: string,
  ) {}

  async live(): Promise<{ status: string }> {
    return { status: 'ok' };
  }

  async ready(): Promise<{ status: string; postgres: string; sqs: string }> {
    let postgres = 'unknown';
    let sqs = 'unknown';

    try {
      await this.em.getConnection().execute('SELECT 1');
      postgres = 'ok';
    } catch {
      postgres = 'fail';
    }

    try {
      if (!this.queueUrl) {
        throw new Error('SQS_QUEUE_URL is not configured');
      }
      // queueUrl is a full URL (e.g. http://localhost:4566/000000000000/...),
      // not a queue name. GetQueueAttributes validates the URL directly.
      await this.sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: this.queueUrl,
          AttributeNames: ['QueueArn'],
        }),
      );
      sqs = 'ok';
    } catch {
      sqs = 'fail';
    }

    const status = postgres === 'ok' && sqs === 'ok' ? 'ok' : 'fail';
    return { status, postgres, sqs };
  }
}
