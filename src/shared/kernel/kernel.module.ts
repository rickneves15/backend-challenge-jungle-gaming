import { Global, Module } from '@nestjs/common';

import { SystemClock, UuidIdGenerator, PinoLogger } from './providers/kernel-providers';
import { WorkerRuntime } from './worker-runtime';
import { CLOCK, ID_GENERATOR, LOGGER } from './ports/tokens';

/** Provides the technology-neutral kernel ports once for the whole process. */
@Global()
@Module({
  providers: [
    SystemClock,
    UuidIdGenerator,
    PinoLogger,
    WorkerRuntime,
    { provide: CLOCK, useExisting: SystemClock },
    { provide: ID_GENERATOR, useExisting: UuidIdGenerator },
    { provide: LOGGER, useExisting: PinoLogger },
  ],
  exports: [
    SystemClock,
    UuidIdGenerator,
    PinoLogger,
    WorkerRuntime,
    CLOCK,
    ID_GENERATOR,
    LOGGER,
  ],
})
export class KernelModule {}
