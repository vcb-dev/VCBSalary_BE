import type { AutomationGenVideoTeamMember } from './clients/automation-gen-video.client';

export type SourceEmployeeIdentity = Pick<
  AutomationGenVideoTeamMember,
  'user_id' | 'email' | 'full_name'
>;

export type LocalEmployeeIdentity = {
  id: number;
  fullName: string;
  email?: string | null;
  user?: { email: string } | null;
};

export type EmployeeIdentityMatch = {
  employeeId?: number;
  reason?: string;
  ambiguous?: boolean;
};

const normalizeEmail = (value: string) => value.trim().toLowerCase();

// Giữ dấu tiếng Việt và chỉ khớp chính xác sau chuẩn hóa. Không fuzzy-match để tránh nhận nhầm
// những nhân sự có tên gần giống nhau.
const normalizeName = (value: string) =>
  value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

/** Ưu tiên email, sau đó mới tới họ tên; mọi kết quả mơ hồ đều bị từ chối. */
export function matchEmployeesByEmailOrName(
  employees: LocalEmployeeIdentity[],
  members: SourceEmployeeIdentity[],
): Map<string, EmployeeIdentityMatch> {
  const byEmail = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  for (const employee of employees) {
    const email = normalizeEmail(employee.email ?? employee.user?.email ?? '');
    const name = normalizeName(employee.fullName);
    if (email) byEmail.set(email, [...(byEmail.get(email) ?? []), employee.id]);
    if (name) byName.set(name, [...(byName.get(name) ?? []), employee.id]);
  }

  const matches = new Map<string, EmployeeIdentityMatch>();
  for (const member of members) {
    const emailMatches = byEmail.get(normalizeEmail(member.email ?? '')) ?? [];
    const nameMatches = byName.get(normalizeName(member.full_name ?? '')) ?? [];
    if (emailMatches.length > 1) {
      matches.set(member.user_id, {
        ambiguous: true,
        reason:
          'Email khớp nhiều nhân sự trong team; bỏ qua để tránh mapping nhầm',
      });
    } else if (emailMatches.length === 1) {
      matches.set(member.user_id, { employeeId: emailMatches[0] });
    } else if (nameMatches.length > 1) {
      matches.set(member.user_id, {
        ambiguous: true,
        reason:
          'Tên khớp nhiều nhân sự trong team; bỏ qua để tránh mapping nhầm',
      });
    } else if (nameMatches.length === 1) {
      matches.set(member.user_id, { employeeId: nameMatches[0] });
    } else {
      matches.set(member.user_id, {
        reason: 'Không tìm thấy nhân sự trong team khớp email hoặc tên',
      });
    }
  }

  // Hai tài khoản nguồn không được ghi vào cùng một nhân sự địa phương.
  const usersByEmployee = new Map<number, string[]>();
  for (const [userId, match] of matches) {
    if (match.employeeId != null) {
      usersByEmployee.set(match.employeeId, [
        ...(usersByEmployee.get(match.employeeId) ?? []),
        userId,
      ]);
    }
  }
  for (const userIds of usersByEmployee.values()) {
    if (userIds.length > 1) {
      for (const userId of userIds) {
        matches.set(userId, {
          ambiguous: true,
          reason:
            'Nhiều tài khoản nguồn khớp cùng một nhân sự; bỏ qua để tránh ghi đè nhầm',
        });
      }
    }
  }
  return matches;
}
