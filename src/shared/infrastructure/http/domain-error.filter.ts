import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { DomainError } from '@/shared/domain/errors/domain-error';

/** Minimal structural type: keeps the filter decoupled from Express typings. */
interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): HttpResponse;
}

/**
 * Single place where domain failures become HTTP responses. Keeping this in a
 * filter (instead of per-controller try/catch) guarantees the same status for
 * a given error code across every endpoint.
 *
 * Mapping:
 * - 400  invalid payload / invalid domain state
 * - 404  resource not found
 * - 409  idempotency conflict or duplicate wallet (request conflict)
 * - 422  business rejection (terminal and auditable)
 * - 502  transient infrastructure failure
 */
@Catch(DomainError)
export class DomainErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainErrorFilter.name);

  catch(error: DomainError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const status = Number.isInteger(error.statusCode)
      ? error.statusCode
      : HttpStatus.BAD_REQUEST;

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error('Infrastructure failure', {
        code: error.code,
        message: error.message,
      });
    }

    response.status(status).json({
      code: error.code,
      message: error.message,
      statusCode: status,
    });
  }
}

/** Escape hatch for non-domain failures that should still be reported as JSON. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const body = error.getResponse();
      response.status(status).json(body);
      return;
    }

    this.logger.error('Unhandled error', { error: String(error) });
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      code: 'INTERNAL_ERROR',
      message: 'internal error',
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    });
  }
}
