import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  BadRequestException,
  NotFoundException,
  Res,
} from '@nestjs/common';

import { SubmitWagerTransactionUseCase } from '@/modules/wagering/services/submit-wager-transaction.use-case';
import type { SubmitWagerTransactionOutput } from '@/modules/wagering/services/submit-wager-transaction.use-case';
import { SubmitWagerTransactionDto } from '@/modules/wagering/dto/submit-wager-transaction.dto';
import type { WagerTransactionRepository } from '@/shared/kernel/ports/wager-transaction-repository.port';
import { WAGER_TRANSACTION_REPOSITORY } from '@/shared/kernel/ports/tokens';
import { WagerTransaction } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import { WagerTransactionStatus } from '@/shared/domain/rules/wager-rules';
import { canonicalHash } from '@/shared/domain/value-objects/canonical-hash';

interface HttpResponse {
  status(code: number): HttpResponse;
}

/**
 * Deliberately no class-level prefix: the provider lookup lives under a
 * different top-level path than the submit/transaction-by-id routes.
 */
@Controller()
export class WageringController {
  constructor(
    private readonly submitUseCase: SubmitWagerTransactionUseCase,
    @Inject(WAGER_TRANSACTION_REPOSITORY) private readonly txRepo: WagerTransactionRepository,
  ) {}

  @Post('wagering/transactions')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body() dto: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      // BadRequestException keeps the framework's standard 400 validation shape.
      throw new BadRequestException({
        code: 'MISSING_IDEMPOTENCY_KEY',
        message: 'Idempotency-Key header is required',
      });
    }

    const result = await this.submitUseCase.execute({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      idempotencyKey,
      payloadHash: this.businessPayloadHash(dto),
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });

    this.applyStatus(res, result);
    return {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
      ...(result.failureCode ? { failureCode: result.failureCode, code: result.failureCode } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  @Get('wagering/transactions/:transactionId')
  async getTransaction(@Param('transactionId') transactionId: string) {
    const tx = await this.txRepo.findById(transactionId);
    if (!tx) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: `transaction not found: ${transactionId}`,
      });
    }
    return this.serializeTransaction(tx);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getTransactionByProviderExternal(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const tx = await this.txRepo.findByProviderAndExternal(providerId, externalTransactionId);
    if (!tx) {
      throw new NotFoundException({
        code: 'TRANSACTION_NOT_FOUND',
        message: `transaction not found for provider=${providerId} and externalTransactionId=${externalTransactionId}`,
      });
    }
    return this.serializeTransaction(tx);
  }

  /**
   * Business rejections and pending references are not successful submissions:
   * they get their own HTTP statuses so a provider never has to parse a message
   * to decide what to do next. Idempotent replays inherit the original outcome.
   */
  private applyStatus(res: HttpResponse, result: SubmitWagerTransactionOutput): void {
    if (result.status === WagerTransactionStatus.Rejected) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY);
    } else if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED);
    }
  }

  private serializeTransaction(tx: WagerTransaction) {
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      money: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      status: tx.status,
      failureCode: tx.failureCode,
      balanceSnapshot: tx.balanceSnapshot ?? null,
      processedAt: tx.processedAt,
      createdAt: tx.createdAt,
      version: tx.version,
    };
  }

  /**
   * Canonical business payload: transport metadata (idempotency key itself,
   * headers, timestamps) is excluded. Object keys are sorted at every nesting
   * level, so JSON key order never changes the hash while nested values such
   * as `money.amount` always participate in it.
   */
  private businessPayloadHash(dto: SubmitWagerTransactionDto): string {
    return canonicalHash({
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: dto.money,
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
    });
  }
}
