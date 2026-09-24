import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);
const ONE_HUNDRED = new Prisma.Decimal(100);
const ONE_THOUSAND = new Prisma.Decimal(1000);

export type BracketInput = {
  minRevenueAmount: Prisma.Decimal;
  maxRevenueAmount: Prisma.Decimal | null;
};

export function capAtTarget(actual: Prisma.Decimal, target: Prisma.Decimal) {
  if (actual.lt(0)) return ZERO;
  return actual.gt(target) ? target : actual;
}

export function calculateProgressPercent(
  actuals: Array<{
    actual: Prisma.Decimal;
    target: Prisma.Decimal;
    direction?: 'AT_LEAST' | 'AT_MOST';
  }>,
) {
  const totals = actuals.reduce(
    (result, item) => ({
      cappedActual: result.cappedActual.plus(
        item.direction === 'AT_MOST'
          ? equivalentActualForAtMost(item.actual, item.target)
          : capAtTarget(item.actual, item.target),
      ),
      target: result.target.plus(item.target),
    }),
    { cappedActual: ZERO, target: ZERO },
  );
  if (totals.target.lte(0)) return ZERO;
  return totals.cappedActual
    .div(totals.target)
    .mul(ONE_HUNDRED)
    .toDecimalPlaces(4);
}

function equivalentActualForAtMost(
  actual: Prisma.Decimal,
  target: Prisma.Decimal,
) {
  if (target.lte(0)) return ZERO;
  if (actual.lte(target)) return target;
  return target.mul(target).div(actual);
}

export function calculateOkrProgressPercent(
  actual: Prisma.Decimal,
  target: Prisma.Decimal,
) {
  return calculateProgressPercent([{ actual, target }]);
}

export function calculatePerformanceGoalProgressPercent(
  actual: Prisma.Decimal,
  target: Prisma.Decimal,
  direction: 'AT_LEAST' | 'AT_MOST',
) {
  if (target.lte(0)) return ZERO;
  if (direction === 'AT_MOST') {
    if (actual.lte(target)) return ONE_HUNDRED;
    return target.div(actual).mul(ONE_HUNDRED).toDecimalPlaces(4);
  }
  return calculateOkrProgressPercent(actual, target);
}

export function resolveRevenueBracket<T extends BracketInput>(
  revenue: Prisma.Decimal,
  brackets: T[],
) {
  return brackets.filter(
    (bracket) =>
      revenue.gte(bracket.minRevenueAmount) &&
      (bracket.maxRevenueAmount === null ||
        revenue.lt(bracket.maxRevenueAmount)),
  );
}

export function calculateCommission(
  revenue: Prisma.Decimal,
  ratePercent: Prisma.Decimal,
) {
  return roundMoney(revenue.mul(ratePercent).div(ONE_HUNDRED));
}

export function calculateRpm(
  acceptedViews: bigint,
  rpmRatePer1000Views: Prisma.Decimal,
) {
  return roundMoney(
    new Prisma.Decimal(acceptedViews.toString())
      .mul(rpmRatePer1000Views)
      .div(ONE_THOUSAND),
  );
}

export function calculateBinaryReward(
  progressPercent: Prisma.Decimal,
  thresholdPercent: Prisma.Decimal,
  rewardAmount: Prisma.Decimal,
) {
  return progressPercent.gte(thresholdPercent) ? rewardAmount : ZERO;
}

export function roundMoney(value: Prisma.Decimal) {
  return value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
}
