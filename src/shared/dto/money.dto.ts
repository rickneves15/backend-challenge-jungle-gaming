import { IsString, Matches } from 'class-validator';

/**
 * MoneyDto — transport shape for a monetary value.
 *
 * Mirrors the Money value-object constraints so invalid payloads are rejected
 * by the ValidationPipe before reaching the domain layer:
 * - amount: decimal string with at most 2 places, no sign or exponent;
 * - currency: ISO-4217 code (3 uppercase letters).
 */
export class MoneyDto {
  @IsString()
  @Matches(/^\d+(?:\.\d{1,2})?$/, {
    message: 'amount must be a decimal string with at most 2 decimal places',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, {
    message: 'currency must be an ISO-4217 code (3 uppercase letters)',
  })
  currency!: string;
}
