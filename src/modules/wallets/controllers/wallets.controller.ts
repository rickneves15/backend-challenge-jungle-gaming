import {
  Inject,
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';

import { OpenWalletUseCase } from '@/modules/wallets/services/open-wallet.use-case';
import { CreateWalletDto } from '@/modules/wallets/dto/create-wallet.dto';
import type { WalletRepository } from '@/shared/kernel/ports/wallet-repository.port';
import type { LedgerEntryRepository } from '@/shared/kernel/ports/ledger-entry-repository.port';
import {
  LEDGER_ENTRY_REPOSITORY,
  WALLET_REPOSITORY,
} from '@/shared/kernel/ports/tokens';
import { WalletAlreadyExistsError } from '@/shared/domain/errors/domain-error';

@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly openWalletUseCase: OpenWalletUseCase,
    @Inject(WALLET_REPOSITORY) private readonly walletRepo: WalletRepository,
    @Inject(LEDGER_ENTRY_REPOSITORY) private readonly ledgerRepo: LedgerEntryRepository,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateWalletDto) {
    try {
      const result = await this.openWalletUseCase.execute({
        id: dto.id,
        playerId: dto.playerId,
        currency: dto.initialBalance.currency,
        initialBalance: dto.initialBalance,
      });
      return {
        id: result.walletId,
        playerId: result.playerId,
        balance: result.balance,
        version: result.version,
      };
    } catch (err) {
      const e = err as any;
      if (e instanceof WalletAlreadyExistsError) {
        throw new ConflictException({ code: e.code, message: e.message });
      }
      throw err;
    }
  }

  @Get(':walletId')
  async getWallet(@Param('walletId') walletId: string) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: `wallet not found: ${walletId}` });
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.toSnapshot(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const wallet = await this.walletRepo.findById(walletId);
    if (!wallet) {
      throw new NotFoundException({ code: 'WALLET_NOT_FOUND', message: `wallet not found: ${walletId}` });
    }

    const take = Math.min(Math.max(parseInt(limit ?? '50', 10), 1), 200);
    const { entries, nextCursor } = await this.ledgerRepo.findByWallet(walletId, cursor, take);

    return {
      walletId,
      entries: entries.map((e) => ({
        id: e.id,
        transactionId: e.transactionId,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt,
      })),
      nextCursor,
    };
  }
}
