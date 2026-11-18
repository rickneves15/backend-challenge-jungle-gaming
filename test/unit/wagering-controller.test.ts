import { describe, it, expect } from 'bun:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { WageringController } from '@/modules/wagering/controllers/wagering.controller.ts';
import { WagerTransactionStatus } from '@/shared/domain/rules/wager-rules.ts';

import { TX_ID } from './fixtures.ts';

describe('WageringController', () => {
  it('returns 400 when Idempotency-Key is missing', async () => {
    const controller = new WageringController(
      { execute: async () => undefined } as any,
      { findById: async () => null, findByProviderAndExternal: async () => null } as any,
    );

    await expect(
      controller.submit({} as any, undefined, { status: () => undefined } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns 404 shapes for both transaction lookup routes', async () => {
    const controller = new WageringController(
      { execute: async () => undefined } as any,
      { findById: async () => null, findByProviderAndExternal: async () => null } as any,
    );

    await expect(controller.getTransaction(TX_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TRANSACTION_NOT_FOUND' }),
    });
    await expect(
      controller.getTransactionByProviderExternal('provider-1', 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps REJECTED and PENDING_REFERENCE results to 422 and 202', async () => {
    let status = 200;
    const res = {
      status: (code: number) => {
        status = code;
        return res;
      },
    };
    const controller = new WageringController(
      {
        execute: async () => ({
          transactionId: TX_ID,
          status: WagerTransactionStatus.Rejected,
          balance: null,
          idempotentReplay: false,
          failureCode: 'INSUFFICIENT_BALANCE',
          reason: 'not enough funds',
        }),
      } as any,
      { findById: async () => null, findByProviderAndExternal: async () => null } as any,
    );

    await controller.submit({} as any, 'key-1', res);
    expect(status).toBe(422);

    (controller as any).submitUseCase.execute = async () => ({
      transactionId: TX_ID,
      status: WagerTransactionStatus.PendingReference,
      balance: null,
      idempotentReplay: false,
    });
    await controller.submit({} as any, 'key-2', res);
    expect(status).toBe(202);
  });
});
