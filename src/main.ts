import { NestFactory } from '@nestjs/core';
import { RequestMethod, ValidationPipe } from '@nestjs/common';

import { AppModule } from '@/app.module';
import { NoOpAuthGuard } from '@/shared/infrastructure/auth/no-op.auth.guard';
import { PinoLogger } from '@/shared/kernel/providers/kernel-providers';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    logger: false,
  });
  app.useLogger(app.get(PinoLogger));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Health checks are intentionally outside /api and unauthenticated.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });

  // Explicit authentication extension point. Replace with a JWT/OIDC guard
  // when authentication is prioritized; health endpoints are excluded.
  app.useGlobalGuards(new NoOpAuthGuard());

  // Lets Nest call onModuleDestroy on the SQS/outbox workers so an in-flight
  // message is finished (or its visibility timeout is restored) on SIGTERM.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  app.get(PinoLogger).info('Wagering processor listening', { port });
}

bootstrap().catch((err) => {
  console.error(JSON.stringify({ level: 'error', msg: 'Failed to start application', error: String(err) }));
  process.exit(1);
});
