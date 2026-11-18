import {
  Controller,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';

import { ReconcileWalletUseCase } from '@/modules/reconciliation/services/reconcile-wallet.use-case';
import { DomainError } from '@/shared/domain/errors/domain-error';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Controller('wallets')
export class ReconciliationController {
  constructor(private readonly reconcileUseCase: ReconcileWalletUseCase) {}

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    try {
      return await this.reconcileUseCase.execute(walletId);
    } catch (err) {
      if (err instanceof DomainError && err.code === 'WALLET_NOT_FOUND') {
        throw new NotFoundException({ code: err.code, message: errorMessage(err) });
      }
      throw err;
    }
  }
}
