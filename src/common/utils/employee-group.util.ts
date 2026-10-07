import { HttpStatus } from '@nestjs/common';
import { EmployeeGroupStatus } from '@prisma/client';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { PrismaService } from '../../prisma/prisma.service';

/** Bỏ dấu + viết hoa để so khớp chức danh với từ khóa của nhóm nghiệp vụ. */
export function normalizeJobTitle(value: string) {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
}

/**
 * Nhóm nghiệp vụ gắn phòng ban chỉ được gán cho dữ liệu thuộc đúng phòng ban đó; nhóm có
 * `departmentId = null` dùng chung toàn hệ thống. Nhóm đã ngừng dùng (INACTIVE) không gán mới được
 * nhưng vẫn giữ nguyên ở những nơi đã gán trước đó — `alreadyAssignedIds` là các id đó.
 */
export async function assertEmployeeGroupsAssignable(
  prisma: PrismaService,
  groupIds: number[],
  departmentIds: number[],
  alreadyAssignedIds: number[] = [],
) {
  if (groupIds.length === 0) return [];

  const groups = await prisma.employeeGroup.findMany({
    where: { id: { in: groupIds } },
    select: { id: true, name: true, status: true, departmentId: true },
  });

  const missing = groupIds.filter(
    (id) => !groups.some((group) => group.id === id),
  );
  if (missing.length > 0) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      'Nhóm nghiệp vụ không tồn tại',
      HttpStatus.BAD_REQUEST,
      { unknownIds: missing },
    );
  }

  const newlyAssigned = groups.filter(
    (group) => !alreadyAssignedIds.includes(group.id),
  );

  const inactive = newlyAssigned.filter(
    (group) => group.status === EmployeeGroupStatus.INACTIVE,
  );
  if (inactive.length > 0) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Nhóm nghiệp vụ đã ngừng dùng nên không gán mới được: ${inactive
        .map((group) => group.name)
        .join(', ')}`,
      HttpStatus.BAD_REQUEST,
      { inactiveIds: inactive.map((group) => group.id) },
    );
  }

  const mismatched = newlyAssigned.filter(
    (group) =>
      group.departmentId !== null &&
      !departmentIds.includes(group.departmentId),
  );
  if (mismatched.length > 0) {
    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      `Nhóm nghiệp vụ thuộc phòng ban khác nên không gán được: ${mismatched
        .map((group) => group.name)
        .join(', ')}`,
      HttpStatus.BAD_REQUEST,
      { mismatchedIds: mismatched.map((group) => group.id) },
    );
  }

  return groups;
}
