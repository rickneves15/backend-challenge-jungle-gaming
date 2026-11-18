import {
  IsString,
  IsUUID,
  IsOptional,
  IsEnum,
  IsObject,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

import { WagerTransactionKind } from '@/shared/infrastructure/persistence/mikro-orm/entities/wager-transaction.entity';
import { MoneyDto } from '@/shared/dto/money.dto';

/**
 * Transport-only subset of a wager request.
 *
 * `idempotencyKey` comes from the Idempotency-Key header and `payloadHash` is
 * always computed server-side from these business fields. Both are therefore
 * deliberately absent here: with ValidationPipe's `forbidNonWhitelisted`, a
 * client that tries to supply either gets a 400 instead of silently overriding
 * the idempotency decision.
 */
export class SubmitWagerTransactionDto {
  @IsString()
  providerId!: string;

  @IsString()
  externalTransactionId!: string;

  @IsString()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  roundId!: string;

  @IsString()
  gameId!: string;

  @IsEnum(WagerTransactionKind)
  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @IsOptional()
  @IsString()
  referenceExternalTransactionId?: string;
}
