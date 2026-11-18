import { describe, it, expect } from 'bun:test';
import Decimal from 'decimal.js-light';
import { Money } from '@/shared/domain/value-objects/money';
import { InvalidMoneyError } from '@/shared/domain/errors/domain-error';

describe('Money', () => {
  describe('from()', () => {
    it('should create a valid Money from a decimal string', () => {
      const money = Money.from({ amount: '25.00', currency: 'BRL' });
      expect(money.amount).toBe('25.00');
      expect(money.currency).toBe('BRL');
    });

    it('should normalize integer amount to scale 2', () => {
      const money = Money.from({ amount: '25', currency: 'BRL' });
      expect(money.amount).toBe('25.00');
    });

    it('should normalize one decimal place to scale 2', () => {
      const money = Money.from({ amount: '25.5', currency: 'BRL' });
      expect(money.amount).toBe('25.50');
    });

    it('should reject empty string', () => {
      expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it('should reject more than 2 decimal places', () => {
      expect(() => Money.from({ amount: '25.001', currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it('should reject scientific notation', () => {
      expect(() => Money.from({ amount: '1e2', currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it('should reject negative values', () => {
      expect(() => Money.from({ amount: '-25.00', currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });

    it('should reject invalid currency', () => {
      expect(() => Money.from({ amount: '25.00', currency: 'brl' })).toThrow(
        InvalidMoneyError,
      );
    });

    it('should reject non-string amount', () => {
      // @ts-expect-error testing invalid input
      expect(() => Money.from({ amount: 25, currency: 'BRL' })).toThrow(
        InvalidMoneyError,
      );
    });
  });

  describe('zero()', () => {
    it('should create zero money', () => {
      const money = Money.zero('BRL');
      expect(money.amount).toBe('0.00');
      expect(money.isZero()).toBe(true);
    });
  });

  describe('add()', () => {
    it('should add two amounts', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '10.50', currency: 'BRL' });
      expect(a.add(b).amount).toBe('35.50');
    });

    it('should throw on different currencies', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '10.00', currency: 'USD' });
      expect(() => a.add(b)).toThrow(InvalidMoneyError);
    });

    it('should be immutable', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '10.00', currency: 'BRL' });
      a.add(b);
      expect(a.amount).toBe('25.00');
    });
  });

  describe('subtract()', () => {
    it('should subtract two amounts', () => {
      const a = Money.from({ amount: '100.00', currency: 'BRL' });
      const b = Money.from({ amount: '25.00', currency: 'BRL' });
      expect(a.subtract(b).amount).toBe('75.00');
    });

    it('should throw on different currencies', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '10.00', currency: 'USD' });
      expect(() => a.subtract(b)).toThrow(InvalidMoneyError);
    });
  });

  describe('compare()', () => {
    it('should compare isLessThan', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '100.00', currency: 'BRL' });
      expect(a.isLessThan(b)).toBe(true);
      expect(b.isLessThan(a)).toBe(false);
    });

    it('should compare equals', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '25.00', currency: 'BRL' });
      expect(a.equals(b)).toBe(true);
    });

    it('should throw isLessThan on different currencies', () => {
      const a = Money.from({ amount: '25.00', currency: 'BRL' });
      const b = Money.from({ amount: '100.00', currency: 'USD' });
      expect(() => a.isLessThan(b)).toThrow(InvalidMoneyError);
    });
  });

  describe('isPositive/isNegative/isZero', () => {
    it('should detect zero', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
    });

    it('should detect positive', () => {
      expect(Money.from({ amount: '1.00', currency: 'BRL' }).isPositive()).toBe(
        true,
      );
    });

    it('should detect negative after negate', () => {
      const money = Money.from({ amount: '25.00', currency: 'BRL' }).negate();
      expect(money.isNegative()).toBe(true);
      expect(money.amount).toBe('-25.00');
    });
  });

  describe('scale and rounding', () => {
    it('should always serialize with exactly two decimal places', () => {
      expect(Money.from({ amount: '0', currency: 'BRL' }).amount).toBe('0.00');
      expect(Money.from({ amount: '0.1', currency: 'BRL' }).amount).toBe('0.10');
      expect(Money.from({ amount: '1', currency: 'BRL' }).amount).toBe('1.00');
      expect(Money.from({ amount: '12.3', currency: 'BRL' }).amount).toBe('12.30');
    });

    it('should keep scale 2 after chained operations', () => {
      const total = Money.from({ amount: '100.00', currency: 'BRL' })
        .subtract(Money.from({ amount: '33.33', currency: 'BRL' }))
        .add(Money.from({ amount: '0.07', currency: 'BRL' }));
      expect(total.amount).toBe('66.74');
    });

    it('should configure decimal arithmetic with ROUND_HALF_UP', () => {
      // Importing Money configures the shared Decimal instance. The public
      // API rejects inputs with more than 2 decimals, so the configuration
      // itself is asserted here.
      expect(Decimal.rounding).toBe(Decimal.ROUND_HALF_UP);
      expect(Decimal.precision).toBe(28);
      expect(new Decimal('1.005').toFixed(2)).toBe('1.01');
      expect(new Decimal('1.004').toFixed(2)).toBe('1.00');
    });
  });
});
