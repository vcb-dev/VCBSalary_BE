import { Prisma } from '@prisma/client';
import {
  calculateBinaryReward,
  calculateCommission,
  calculateProgressPercent,
  calculateRpm,
  resolveRevenueBracket,
} from '../salary-calculator';

const decimal = (value: string | number) => new Prisma.Decimal(value);

describe('salary calculator policies', () => {
  it('caps every KPI item before aggregating so over-performance cannot compensate', () => {
    const progress = calculateProgressPercent([
      { target: decimal(10), actual: decimal(15) },
      { target: decimal(10), actual: decimal(5) },
    ]);

    expect(progress.toString()).toBe('75');
  });

  it('evaluates binary rewards independently', () => {
    expect(
      calculateBinaryReward(
        decimal(80),
        decimal(80),
        decimal(2_000_000),
      ).toFixed(0),
    ).toBe('2000000');
    expect(
      calculateBinaryReward(
        decimal(79.9999),
        decimal(80),
        decimal(2_000_000),
      ).toFixed(0),
    ).toBe('0');
  });

  it('matches revenue brackets using inclusive min and exclusive max boundaries', () => {
    const brackets = [
      { id: 1, minRevenueAmount: decimal(0), maxRevenueAmount: decimal(100) },
      { id: 2, minRevenueAmount: decimal(100), maxRevenueAmount: null },
    ];

    expect(resolveRevenueBracket(decimal(99), brackets)[0].id).toBe(1);
    expect(resolveRevenueBracket(decimal(100), brackets)[0].id).toBe(2);
  });

  it('rounds commission and RPM to whole VND', () => {
    expect(
      calculateCommission(decimal(500_000_000), decimal('0.6')).toFixed(0),
    ).toBe('3000000');
    expect(calculateRpm(56_250_000n, decimal(120)).toFixed(0)).toBe('6750000');
  });
});
