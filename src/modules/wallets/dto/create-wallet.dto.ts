import { IsString, IsUUID, IsOptional, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import { MoneyDto } from '@/shared/dto/money.dto';

export class CreateWalletDto {
  @IsUUID()
  @IsOptional()
  id?: string;

  @IsString()
  playerId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

