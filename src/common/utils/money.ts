import { Prisma } from '@prisma/client';

export type Money = Prisma.Decimal;

const ZERO_DP = {
  decimals: 0,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
} as const;

export function toMoney(value: Prisma.Decimal.Value): Money {
  return new Prisma.Decimal(value).toDecimalPlaces(
    ZERO_DP.decimals,
    ZERO_DP.rounding,
  );
}

export function addMoney(a: Money, b: Money): Money {
  return a.plus(b);
}

export function subMoney(a: Money, b: Money): Money {
  return a.minus(b);
}

export function mulMoney(a: Money, factor: Prisma.Decimal.Value): Money {
  return a.times(factor).toDecimalPlaces(ZERO_DP.decimals, ZERO_DP.rounding);
}

export function divMoney(a: Money, divisor: Prisma.Decimal.Value): Money {
  return a
    .dividedBy(divisor)
    .toDecimalPlaces(ZERO_DP.decimals, ZERO_DP.rounding);
}

export function sumMoney(values: Money[]): Money {
  return values.reduce((acc, value) => acc.plus(value), new Prisma.Decimal(0));
}

export function moneyToNumber(value: Money): number {
  return value.toNumber();
}
