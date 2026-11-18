import { ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';

import { SQS_CLIENT, SQS_QUEUE_URL } from './sqs.tokens';

/** One client configuration for the consumer, outbox publisher and health check. */
export const sqsClientProvider = {
  provide: SQS_CLIENT,
  useFactory: (config: ConfigService) =>
    new SQSClient({
      region: config.get<string>('AWS_REGION', 'us-east-1'),
      endpoint: config.get<string>('SQS_ENDPOINT'),
      credentials: {
        accessKeyId: config.get<string>('AWS_ACCESS_KEY_ID', 'test'),
        secretAccessKey: config.get<string>('AWS_SECRET_ACCESS_KEY', 'test'),
      },
    }),
  inject: [ConfigService],
};

export const sqsQueueUrlProvider = {
  provide: SQS_QUEUE_URL,
  useFactory: (config: ConfigService) => config.get<string>('SQS_QUEUE_URL', ''),
  inject: [ConfigService],
};
