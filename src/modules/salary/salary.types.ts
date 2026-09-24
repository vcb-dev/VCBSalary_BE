import type {
  PerformanceGoalType,
  Prisma,
  SalaryRecordStatus,
} from '@prisma/client';

export type SalaryWarning = {
  code: string;
  message: string;
  context?: Record<string, string | number | boolean | null>;
};

export type CalculatedKpiItem = {
  teamId: number;
  teamName: string;
  salaryWeightPercent: Prisma.Decimal;
  kpiGroupId: number;
  kpiGroupName: string;
  progressPercent: Prisma.Decimal;
  thresholdPercent: Prisma.Decimal;
  rewardAmount: Prisma.Decimal;
  earnedAmount: Prisma.Decimal;
  isAchieved: boolean;
};

export type CalculatedOkrItem = {
  employeeOkrId: number;
  goalType: PerformanceGoalType;
  title: string;
  progressPercent: Prisma.Decimal;
  thresholdPercent: Prisma.Decimal;
  rewardAmount: Prisma.Decimal;
  earnedAmount: Prisma.Decimal;
  isAchieved: boolean;
};

export type SalaryCalculation = {
  employeeId: number;
  payrollPeriodId: number;
  employeeCode: string;
  employeeName: string;
  jobTitle: string;
  teamId: number | null;
  teamName: string | null;
  rewardRuleSetId: number;
  rewardRuleSetVersion: number;
  revenueRewardBracketId: number | null;
  revenueRewardBracketLabel: string | null;
  baseSalaryAmount: Prisma.Decimal;
  kpiRewardAmount: Prisma.Decimal;
  okrRewardAmount: Prisma.Decimal;
  revenueAmount: Prisma.Decimal;
  commissionRatePercent: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
  totalViews: bigint;
  rpmRatePer1000Views: Prisma.Decimal;
  rpmRewardAmount: Prisma.Decimal;
  additionalComponentAmount: Prisma.Decimal;
  totalSalaryAmount: Prisma.Decimal;
  status: SalaryRecordStatus;
  warnings: SalaryWarning[];
  kpiItems: CalculatedKpiItem[];
  okrItems: CalculatedOkrItem[];
};
