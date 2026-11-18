import { Module } from '@nestjs/common';

import { HealthService } from '@/infrastructure/health/health.service';
import { HealthController } from '@/infrastructure/health/health.controller';
import { MessagingModule } from '@/infrastructure/messaging/messaging.module';
import { PersistenceModule } from '@/shared/infrastructure/persistence/persistence.module';

@Module({
  imports: [PersistenceModule, MessagingModule],
  providers: [HealthService],
  controllers: [HealthController],
  exports: [HealthService],
})
export class HealthModule {}
