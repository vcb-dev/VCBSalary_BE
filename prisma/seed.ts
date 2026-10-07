import {
  DepartmentStatus,
  EmploymentStatus,
  PrismaClient,
  ScopeType,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

interface PermissionDef {
  code: string;
  name: string;
}

interface SystemRoleDef {
  code: string;
  name: string;
  description: string;
}

interface DevUserSeed {
  email: string;
  fullName: string;
  roleCode: string;
  scopeType: ScopeType;
  scopeTeamId?: number;
}

interface DevEmployeeSeed {
  employeeCode: string;
  fullName: string;
  jobTitle: string;
  leaderEmployeeCode?: string;
  linkToUserEmail: string;
}

/** Catalog quyền phải khớp với mọi @RequirePermission trong src/. */
const PERMISSION_CATALOG: PermissionDef[] = [
  { code: 'user.manage', name: 'Quản lý tài khoản người dùng' },
  { code: 'role.view', name: 'Xem vai trò' },
  { code: 'role.manage', name: 'Quản lý vai trò' },
  { code: 'permission.view', name: 'Xem danh sách quyền' },
  { code: 'employee.view_self', name: 'Xem hồ sơ nhân sự của chính mình' },
  { code: 'employee.view_team', name: 'Xem hồ sơ nhân sự trong team' },
  { code: 'employee.view_all', name: 'Xem hồ sơ nhân sự toàn hệ thống' },
  { code: 'employee.manage', name: 'Quản lý hồ sơ nhân sự' },
  { code: 'payroll_period.manage', name: 'Quản lý kỳ lương (tạo/sửa/mở/khóa)' },
  { code: 'kpi.view_self', name: 'Xem KPI của chính mình' },
  { code: 'kpi.view_team', name: 'Xem KPI của team' },
  { code: 'kpi.view_all', name: 'Xem KPI toàn hệ thống' },
  { code: 'kpi.self_confirm', name: 'Tự xác nhận KPI' },
  { code: 'kpi.leader_approve', name: 'Duyệt KPI cấp Leader' },
  { code: 'kpi.override', name: 'Override actual KPI' },
  { code: 'kpi.configure', name: 'Cấu hình đầu mục KPI' },
  { code: 'kpi.delete_group', name: 'Xóa nhóm KPI' },
  { code: 'kpi.assign', name: 'Gán KPI cho nhân sự' },
  { code: 'okr.view_self', name: 'Xem OKR của chính mình' },
  { code: 'okr.view_team', name: 'Xem OKR của team' },
  { code: 'okr.view_all', name: 'Xem OKR toàn hệ thống' },
  { code: 'okr.create', name: 'Tạo OKR' },
  { code: 'okr.update_self', name: 'Cập nhật OKR của chính mình' },
  { code: 'okr.self_confirm', name: 'Tự xác nhận OKR' },
  { code: 'okr.leader_approve', name: 'Duyệt OKR cấp Leader' },
  { code: 'okr.propose', name: 'Đề xuất KPI/OKR mới' },
  { code: 'traffic.view_self', name: 'Xem traffic của chính mình' },
  { code: 'traffic.view_team', name: 'Xem traffic của team' },
  { code: 'traffic.view_all', name: 'Xem traffic toàn hệ thống' },
  { code: 'traffic.write_self', name: 'Nhập traffic của chính mình' },
  { code: 'traffic.write_team', name: 'Nhập traffic cho team' },
  { code: 'traffic.leader_approve', name: 'Duyệt traffic cấp Leader' },
  { code: 'revenue.view_self', name: 'Xem doanh thu của chính mình' },
  { code: 'revenue.view_team', name: 'Xem doanh thu của team' },
  { code: 'revenue.view_all', name: 'Xem doanh thu toàn hệ thống' },
  { code: 'revenue.write', name: 'Nhập doanh thu chính thức' },
  { code: 'salary.view_self', name: 'Xem lương của chính mình' },
  { code: 'salary.view_team', name: 'Xem lương của team' },
  { code: 'salary.view_all', name: 'Xem lương toàn hệ thống' },
  { code: 'salary.calculate', name: 'Tính lương' },
  { code: 'salary.final_approve', name: 'Duyệt lương cuối cùng' },
  { code: 'salary.create_revision', name: 'Tạo phiên bản tính lại' },
  { code: 'salary.bonus', name: 'Thêm thưởng thêm vào bảng lương' },
  { code: 'reward_rules.view', name: 'Xem cấu hình mốc thưởng' },
  { code: 'reward_rules.manage', name: 'Quản lý cấu hình mốc thưởng' },
  { code: 'base_salary.view', name: 'Xem lương cơ bản' },
  { code: 'base_salary.manage', name: 'Quản lý lương cơ bản' },
  { code: 'kpi_reward_rate.view', name: 'Xem mức tiền KPI theo nhân sự' },
  { code: 'kpi_reward_rate.manage', name: 'Quản lý mức tiền KPI theo nhân sự' },
  { code: 'audit.view_self', name: 'Xem nhật ký kiểm toán của chính mình' },
  { code: 'audit.view_team', name: 'Xem nhật ký kiểm toán của team' },
  { code: 'audit.view_all', name: 'Xem nhật ký kiểm toán toàn hệ thống' },
  { code: 'notification.view_self', name: 'Xem thông báo của chính mình' },
  { code: 'sync.view', name: 'Xem lịch sử đồng bộ dữ liệu' },
  { code: 'sync.trigger', name: 'Kích hoạt đồng bộ dữ liệu' },
  { code: 'report.export', name: 'Xuất báo cáo/dữ liệu' },
];

const ADMIN_PERMISSION_CODES = PERMISSION_CATALOG.map(
  (permission) => permission.code,
).filter((code) => code !== 'revenue.write');
const FULL_ACCESS_ROLE_CODES = ['ADMIN', 'MANAGER_APPROVER'];

const SYSTEM_ROLES: SystemRoleDef[] = [
  {
    code: 'ADMIN',
    name: 'Quản trị hệ thống',
    description: 'Toàn quyền hệ thống',
  },
  {
    code: 'HR',
    name: 'Nhân sự',
    description: 'Xem toàn bộ, quản lý hồ sơ nhân sự',
  },
  {
    code: 'ACCOUNTANT',
    name: 'Kế toán',
    description: 'Duy nhất có quyền nhập doanh thu chính thức',
  },
  {
    code: 'MANAGER_APPROVER',
    name: 'Quản lý duyệt',
    description: 'Toàn quyền hệ thống tương đương Quản trị viên',
  },
  {
    code: 'LEADER',
    name: 'Trưởng nhóm',
    description: 'Quản lý và duyệt dữ liệu team',
  },
  // Một vai trò chung cho mọi nhân viên; loại công việc (Editor, Content Creator…) là nhóm nghiệp vụ.
  {
    code: 'STAFF',
    name: 'Nhân viên',
    description: 'Tự nhập và xác nhận dữ liệu cá nhân',
  },
];

const BASE_EMPLOYEE_GROUPS = [
  {
    code: 'EDITOR',
    name: 'Editor',
    description:
      'Nhân sự dựng video của Marketing, đồng bộ từ AutomationGenVideo.',
    defaultRoleCode: 'STAFF',
    jobTitleKeywords: ['EDITOR', 'BIEN TAP', 'DUNG PHIM'],
  },
  {
    code: 'CONTENT_CREATOR',
    name: 'Content Creator',
    description: 'Vai trò bổ sung cho nhân sự Marketing sản xuất nội dung.',
    defaultRoleCode: 'STAFF',
    jobTitleKeywords: ['CONTENT CREATOR', 'CREATOR', 'SANG TAO NOI DUNG'],
  },
];

const HR_PERMISSIONS = [
  'employee.view_all',
  'employee.manage',
  'kpi.view_all',
  'okr.view_all',
  'traffic.view_all',
  'revenue.view_all',
  'salary.view_all',
  'audit.view_all',
  'notification.view_self',
  'report.export',
];
const ACCOUNTANT_PERMISSIONS = [
  'employee.view_all',
  'revenue.view_all',
  'revenue.write',
  'salary.view_all',
  'salary.calculate',
  'audit.view_all',
  'notification.view_self',
  'report.export',
];
const LEADER_PERMISSIONS = [
  'employee.view_self',
  'employee.view_team',
  'kpi.view_self',
  'kpi.view_team',
  'kpi.self_confirm',
  'kpi.leader_approve',
  'kpi.override',
  'kpi.configure',
  'kpi.assign',
  'okr.view_self',
  'okr.view_team',
  'okr.create',
  'okr.update_self',
  'okr.self_confirm',
  'okr.leader_approve',
  'traffic.view_self',
  'traffic.view_team',
  'traffic.write_self',
  'traffic.write_team',
  'traffic.leader_approve',
  'revenue.view_self',
  'revenue.view_team',
  'salary.view_self',
  'salary.view_team',
  'salary.bonus',
  'audit.view_self',
  'audit.view_team',
  'notification.view_self',
  'report.export',
];
const INDIVIDUAL_CONTRIBUTOR_PERMISSIONS = [
  'employee.view_self',
  'kpi.view_self',
  'kpi.self_confirm',
  'okr.view_self',
  'okr.update_self',
  'okr.self_confirm',
  'okr.propose',
  'traffic.view_self',
  'traffic.write_self',
  'revenue.view_self',
  'salary.view_self',
  'audit.view_self',
  'notification.view_self',
  'report.export',
];
const DEFAULT_ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: ADMIN_PERMISSION_CODES,
  HR: HR_PERMISSIONS,
  ACCOUNTANT: ACCOUNTANT_PERMISSIONS,
  MANAGER_APPROVER: ADMIN_PERMISSION_CODES,
  LEADER: LEADER_PERMISSIONS,
  STAFF: INDIVIDUAL_CONTRIBUTOR_PERMISSIONS,
};

const DEV_PASSWORD = 'Admin@123';
const DEV_TEAM_CODE = 'CONTENT-TIKTOK';
const DEV_EMPLOYEES: DevEmployeeSeed[] = [
  {
    employeeCode: 'NV-LEAD-01',
    fullName: 'Đỗ Văn Trưởng Nhóm',
    jobTitle: 'Team Leader',
    linkToUserEmail: 'leader@vcbsalary.vn',
  },
  {
    employeeCode: 'NV-ED-01',
    fullName: 'Vũ Thị Biên Tập',
    jobTitle: 'Video Editor',
    leaderEmployeeCode: 'NV-LEAD-01',
    linkToUserEmail: 'editor@vcbsalary.vn',
  },
  {
    employeeCode: 'NV-CC-01',
    fullName: 'Hoàng Văn Sáng Tạo',
    jobTitle: 'Content Creator',
    leaderEmployeeCode: 'NV-LEAD-01',
    linkToUserEmail: 'creator@vcbsalary.vn',
  },
];

async function seedPermissions() {
  for (const permission of PERMISSION_CATALOG) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name },
      create: permission,
    });
  }
  const permissions = await prisma.permission.findMany({
    where: { code: { in: ADMIN_PERMISSION_CODES } },
    select: { id: true },
  });
  for (const roleCode of FULL_ACCESS_ROLE_CODES) {
    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    if (!role) continue;
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
    await prisma.rolePermission.deleteMany({
      where: { roleId: role.id, permission: { code: 'revenue.write' } },
    });
  }
}

async function seedBase() {
  await seedPermissions();
  for (const roleDef of SYSTEM_ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleDef.code },
      update: { name: roleDef.name, description: roleDef.description },
      create: { ...roleDef, isSystemRole: true },
    });
    const hasFullAccess = FULL_ACCESS_ROLE_CODES.includes(roleDef.code);
    const permissionCodes = hasFullAccess
      ? ADMIN_PERMISSION_CODES
      : (DEFAULT_ROLE_PERMISSIONS[roleDef.code] ?? []);
    if (
      !hasFullAccess &&
      (await prisma.rolePermission.count({ where: { roleId: role.id } })) > 0
    )
      continue;
    const permissions = await prisma.permission.findMany({
      where: { code: { in: permissionCodes } },
    });
    await prisma.rolePermission.createMany({
      data: permissions.map((permission) => ({
        roleId: role.id,
        permissionId: permission.id,
      })),
      skipDuplicates: true,
    });
    if (hasFullAccess)
      await prisma.rolePermission.deleteMany({
        where: { roleId: role.id, permission: { code: 'revenue.write' } },
      });
  }
  const marketing = await prisma.department.upsert({
    where: { code: 'MARKETING' },
    update: {},
    create: { code: 'MARKETING', name: 'Marketing' },
  });
  for (const groupDef of BASE_EMPLOYEE_GROUPS) {
    const defaultRole = await prisma.role.findUnique({
      where: { code: groupDef.defaultRoleCode },
    });
    await prisma.employeeGroup.upsert({
      where: { code: groupDef.code },
      update: { name: groupDef.name },
      create: {
        code: groupDef.code,
        name: groupDef.name,
        description: groupDef.description,
        departmentId: marketing.id,
        defaultRoleId: defaultRole?.id ?? null,
        jobTitleKeywords: groupDef.jobTitleKeywords,
      },
    });
  }
}

async function seedDev() {
  const passwordHash = await bcrypt.hash(DEV_PASSWORD, 10);
  const marketing = await prisma.department.upsert({
    where: { code: 'MARKETING' },
    update: { name: 'Marketing', status: DepartmentStatus.ACTIVE },
    create: {
      code: 'MARKETING',
      name: 'Marketing',
      status: DepartmentStatus.ACTIVE,
    },
  });
  const team = await prisma.team.upsert({
    where: { code: DEV_TEAM_CODE },
    update: { departmentId: marketing.id },
    create: {
      code: DEV_TEAM_CODE,
      name: 'Content TikTok',
      departmentId: marketing.id,
    },
  });
  const devUsers: DevUserSeed[] = [
    {
      email: 'admin@vcbsalary.vn',
      fullName: 'Nguyễn Minh Anh',
      roleCode: 'ADMIN',
      scopeType: ScopeType.ALL,
    },
    {
      email: 'hr@vcbsalary.vn',
      fullName: 'Trần Thị Hương',
      roleCode: 'HR',
      scopeType: ScopeType.ALL,
    },
    {
      email: 'accountant@vcbsalary.vn',
      fullName: 'Lê Thị Kế Toán',
      roleCode: 'ACCOUNTANT',
      scopeType: ScopeType.ALL,
    },
    {
      email: 'manager@vcbsalary.vn',
      fullName: 'Phạm Văn Quản Lý',
      roleCode: 'MANAGER_APPROVER',
      scopeType: ScopeType.ALL,
    },
    {
      email: 'leader@vcbsalary.vn',
      fullName: 'Đỗ Văn Trưởng Nhóm',
      roleCode: 'LEADER',
      scopeType: ScopeType.TEAM,
      scopeTeamId: team.id,
    },
    {
      email: 'editor@vcbsalary.vn',
      fullName: 'Vũ Thị Biên Tập',
      roleCode: 'STAFF',
      scopeType: ScopeType.SELF,
    },
    {
      email: 'creator@vcbsalary.vn',
      fullName: 'Hoàng Văn Sáng Tạo',
      roleCode: 'STAFF',
      scopeType: ScopeType.SELF,
    },
  ];
  for (const devUser of devUsers) {
    const role = await prisma.role.findUnique({
      where: { code: devUser.roleCode },
    });
    if (!role)
      throw new Error(
        `Role ${devUser.roleCode} chưa tồn tại — hãy chạy seed:base trước seed:dev`,
      );
    const user = await prisma.user.upsert({
      where: { email: devUser.email },
      update: { fullName: devUser.fullName },
      create: {
        email: devUser.email,
        fullName: devUser.fullName,
        passwordHash,
      },
    });
    const desiredScopeTeamId = devUser.scopeTeamId ?? null;
    const assignments = await prisma.userRole.findMany({
      where: { userId: user.id, roleId: role.id },
    });
    const staleIds = assignments
      .filter(
        (assignment) =>
          assignment.scopeType !== devUser.scopeType ||
          assignment.scopeTeamId !== desiredScopeTeamId,
      )
      .map((assignment) => assignment.id);
    if (staleIds.length)
      await prisma.userRole.deleteMany({ where: { id: { in: staleIds } } });
    if (
      !assignments.some(
        (assignment) =>
          assignment.scopeType === devUser.scopeType &&
          assignment.scopeTeamId === desiredScopeTeamId,
      )
    ) {
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
          scopeType: devUser.scopeType,
          scopeTeamId: devUser.scopeTeamId,
        },
      });
    }
  }
  const employeeIdByCode = new Map<string, number>();
  for (const employeeDef of DEV_EMPLOYEES) {
    const employee = await prisma.employee.upsert({
      where: { employeeCode: employeeDef.employeeCode },
      update: {
        fullName: employeeDef.fullName,
        jobTitle: employeeDef.jobTitle,
        leaderEmployeeId: employeeDef.leaderEmployeeCode
          ? employeeIdByCode.get(employeeDef.leaderEmployeeCode)
          : undefined,
      },
      create: {
        employeeCode: employeeDef.employeeCode,
        fullName: employeeDef.fullName,
        jobTitle: employeeDef.jobTitle,
        teamId: team.id,
        employmentStatus: EmploymentStatus.ACTIVE,
        leaderEmployeeId: employeeDef.leaderEmployeeCode
          ? employeeIdByCode.get(employeeDef.leaderEmployeeCode)
          : undefined,
      },
    });
    employeeIdByCode.set(employeeDef.employeeCode, employee.id);
    await prisma.user.update({
      where: { email: employeeDef.linkToUserEmail },
      data: { employeeId: employee.id },
    });
  }
}

const target = process.argv[2] ?? 'permissions';
const tasks: Record<string, () => Promise<void>> = {
  permissions: seedPermissions,
  base: seedBase,
  dev: seedDev,
};

async function main() {
  const task = tasks[target];
  if (!task)
    throw new Error(
      `Seed không hợp lệ: ${target}. Dùng permissions, base hoặc dev.`,
    );
  await task();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
