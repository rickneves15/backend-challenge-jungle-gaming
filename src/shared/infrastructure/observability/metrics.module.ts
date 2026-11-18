import { Controller, Get, Global, Module, Post, Query } from '@nestjs/common';

import { MetricsService } from './metrics.service';
import { MetricsSnapshotService } from './metrics-snapshot.service';
import { MetricsSnapshotWorker } from './metrics-snapshot.worker';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly snapshots: MetricsSnapshotService,
  ) {}

  @Get()
  snapshot(): Record<string, unknown> {
    return this.metrics.snapshot();
  }

  @Get('snapshots')
  async latest(@Query('limit') limit?: string): Promise<unknown> {
    return this.snapshots.latest(limit ? Number(limit) : 20);
  }

  @Post('snapshots/flush')
  async flush(): Promise<unknown> {
    return this.snapshots.flush();
  }
}

@Global()
@Module({
  providers: [MetricsService, MetricsSnapshotService, MetricsSnapshotWorker],
  exports: [MetricsService, MetricsSnapshotService],
  controllers: [MetricsController],
})
export class MetricsModule {}
