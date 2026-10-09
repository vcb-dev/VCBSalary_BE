/**
 * Ghi bảng nối nhiều-nhiều tường minh (EmployeeGroupMember, KpiGroupTeam, KpiGroupEmployeeGroup).
 * Quan hệ tường minh không có `connect`/`set` theo id bản ghi đích như quan hệ ngầm, nên hai hàm
 * dưới dựng lại đúng hai thao tác đó trên dòng nối.
 */

/** Tương đương `connect` của quan hệ ngầm khi tạo bản ghi mới. */
export function createJoinRows<K extends string>(foreignKey: K, ids: number[]) {
  return {
    createMany: {
      data: ids.map((id) => ({ [foreignKey]: id }) as Record<K, number>),
    },
  };
}

/**
 * Tương đương `set` của quan hệ ngầm: sau khi ghi, dòng nối khớp đúng tập `ids`. Không phụ thuộc
 * thứ tự Prisma chạy hai thao tác — chỉ xóa id không còn trong tập mới và bỏ qua id đã có.
 */
export function replaceJoinRows<K extends string>(
  foreignKey: K,
  ids: number[],
) {
  return {
    deleteMany: { [foreignKey]: { notIn: ids } } as Record<
      K,
      { notIn: number[] }
    >,
    createMany: {
      data: ids.map((id) => ({ [foreignKey]: id }) as Record<K, number>),
      skipDuplicates: true,
    },
  };
}
