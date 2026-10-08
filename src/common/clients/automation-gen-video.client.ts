import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

export interface AutomationGenVideoTeamMember {
  user_id: string;
  joined_at: string;
  is_content_creator: boolean;
  full_name: string;
  email: string;
  employee_id: string | null;
  employee_position: string | null;
  manager_id: string | null;
  is_active: boolean;
  deleted_at: string | null;
  employee_status: string | null;
}

export interface AutomationGenVideoTeamDetail {
  id: string;
  name: string;
  leader_id: string | null;
  is_active: boolean;
  updated_at: string;
  members: AutomationGenVideoTeamMember[];
}

export interface AutomationGenVideoTeamSummary {
  id: string;
  name?: string;
  is_active?: boolean;
}

export interface AutomationGenVideoKpiRecord {
  user_id: string;
  employee_id: string | null;
  group_code: string;
  metric_code: string;
  target: number | null;
  actual: number | null;
}

export interface AutomationGenVideoKpiWarning {
  code: string;
  user_id?: string;
  message: string;
}

export interface AutomationGenVideoKpiResponse {
  contract_version: string;
  month: string;
  team: { id: string; name: string };
  generated_at: string;
  records: AutomationGenVideoKpiRecord[];
  warnings: AutomationGenVideoKpiWarning[];
}

export type AutomationGenVideoPerformanceGoalRecord = {
  external_item_id: string;
  revision: number;
  employee_id: string | null;
  user_id: string;
  team_id: string;
  month: string;
  item_type: 'KPI' | 'OKR';
  kpi_group_id: string | null;
  kpi_group_code: string | null;
  kpi_group_name: string | null;
  title: string;
  description: string | null;
  metric_type: 'NUMBER' | 'PERCENT' | 'BOOLEAN';
  unit: string | null;
  direction: 'AT_LEAST' | 'AT_MOST';
  target: number;
  actual_system: number | null;
  actual_manual: number | null;
  actual_final: number | null;
  progress_pct: number | null;
  progress_pct_for_overall: number | null;
  pass_threshold_pct: number;
  passed: boolean;
  actual_source: 'MANUAL_IN_AGV' | 'SYSTEM_IN_AGV' | 'MISSING';
  updated_at: string;
};

export interface AutomationGenVideoPerformanceGoalResponse {
  contract_version: string;
  month: string;
  team: { id: string; name: string };
  generated_at: string;
  records: AutomationGenVideoPerformanceGoalRecord[];
  warnings: AutomationGenVideoKpiWarning[];
}

/** Một dòng traffic tay của một người trong đúng một ngày báo cáo, đã gộp mọi kênh của ngày đó. */
export interface AutomationGenVideoTrafficRow {
  /** `YYYY-MM-DD` theo giờ Việt Nam. */
  date: string;
  email: string | null;
  name: string | null;
  team: string | null;
  fb: number;
  ig: number;
  tiktok: number;
  yt: number;
  thread: number;
  zalo: number;
  total: number;
  details: { platform: string; channel: string | null; value: number }[];
}

export interface AutomationGenVideoTrafficResponse {
  range: { from: string; to: string };
  rows: AutomationGenVideoTrafficRow[];
}

export type AutomationGenVideoTrafficQuery = {
  /** `YYYY-MM-DD`, bao gồm cả hai đầu. */
  dateFrom: string;
  dateTo: string;
  team?: string;
  email?: string;
};

export type AutomationGenVideoTaskComplianceSource = 'AUTO_A4' | 'DAILY_PLAN';

/** Trạng thái hiện tại của task, nên có thể là task nộp bù sau khi đã chốt số thiếu. */
export interface AutomationGenVideoTaskComplianceTask {
  id: string;
  title: string | null;
  product_name: string | null;
  status: string;
  deadline: string | null;
  submitted_at: string | null;
  on_time: boolean;
}

export interface AutomationGenVideoTaskComplianceRecord {
  id: string;
  user_id: string;
  employee_id: string | null;
  user_name: string;
  team_id: string;
  work_date: string;
  content_line: { id: string; name: string };
  source: AutomationGenVideoTaskComplianceSource;
  expected_count: number;
  completed_count: number;
  missing_count: number;
  deadline: string;
  evaluated_at: string;
  /** Phần thiếu không ứng với task nào: kế hoạch tuyến là task chưa tạo, A4 là task đã huỷ/xoá. */
  untracked_missing: number;
  tasks: AutomationGenVideoTaskComplianceTask[];
}

export interface AutomationGenVideoTaskComplianceCounts {
  expected: number;
  completed: number;
  missing: number;
}

/** Một dòng người × ngày của màn "Nhiệm vụ còn thiếu" bên VCBI. */
export interface AutomationGenVideoTaskComplianceDay {
  key: string;
  work_date: string;
  user_id: string;
  employee_id: string | null;
  user_name: string;
  /** Chỉ cộng các tuyến thiếu. */
  expected_count: number;
  completed_count: number;
  missing_count: number;
  /** Cộng mọi tuyến đã chốt của ngày, kể cả tuyến đủ. */
  day_total: AutomationGenVideoTaskComplianceCounts;
  lines: AutomationGenVideoTaskComplianceRecord[];
}

export interface AutomationGenVideoTaskComplianceResponse {
  contract_version: string;
  generated_at: string;
  timezone: string;
  range: { from: string; to: string };
  team: { id: string; name: string };
  filters: { user_id: string | null; group_by: 'person_day' };
  coverage: {
    snapshot_count: number;
    evaluated_from: string | null;
    evaluated_through: string | null;
  };
  summary: {
    expected: number;
    completed_on_time: number;
    missing: number;
    affected_days: number;
    affected_records: number;
  };
  /** Tổng chỉ trên các tuyến bị thiếu, không phải tỷ lệ hoàn thành của cả kỳ. */
  shortfall_summary: AutomationGenVideoTaskComplianceCounts & {
    person_days: number;
    lines: number;
  };
  records: AutomationGenVideoTaskComplianceRecord[];
  days: AutomationGenVideoTaskComplianceDay[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  warnings: AutomationGenVideoKpiWarning[];
}

export type AutomationGenVideoTaskComplianceQuery = {
  dateFrom: string;
  dateTo: string;
  externalUserId: string;
  page: number;
  limit: number;
};

/**
 * Gọi các endpoint payroll-sync bên AutomationGenVideo_BE (xác thực
 * bằng API key, xem `docs cấu hình` — cần tạo key qua `POST /api/api-keys` bên đó trước).
 */
@Injectable()
export class AutomationGenVideoClient {
  constructor(private readonly config: ConfigService) {}

  async fetchTeams(): Promise<AutomationGenVideoTeamSummary[]> {
    const { baseUrl, apiKey } = this.getConnectionConfig();
    const response = await fetch(`${baseUrl}/api/task-auto/teams`, {
      headers: { 'x-api-key': apiKey },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `VCBI trả lỗi khi lấy danh sách team (HTTP ${response.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const payload: unknown = await response.json();
    const teams = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : isRecord(payload) && Array.isArray(payload.teams)
          ? payload.teams
          : null;

    if (!teams) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'VCBI trả dữ liệu danh sách team không hợp lệ',
        HttpStatus.BAD_GATEWAY,
      );
    }

    return teams.filter(isTeamSummary);
  }

  async fetchTeamForPayrollSync(
    externalTeamId: string,
  ): Promise<AutomationGenVideoTeamDetail> {
    const { baseUrl, apiKey } = this.getConnectionConfig();

    const response = await fetch(
      `${baseUrl}/api/task-auto/teams/${externalTeamId}/payroll-sync`,
      { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(30_000) },
    );

    if (response.status === 404) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy team bên VCBI',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `VCBI trả lỗi khi lấy dữ liệu team (HTTP ${response.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    return (await response.json()) as AutomationGenVideoTeamDetail;
  }

  async fetchKpisForPayrollSync(
    externalTeamId: string,
    month: string,
  ): Promise<AutomationGenVideoKpiResponse> {
    const { baseUrl, apiKey } = this.getConnectionConfig();
    const response = await fetch(
      `${baseUrl}/api/task-auto/teams/${externalTeamId}/kpi-payroll-sync?month=${encodeURIComponent(month)}`,
      {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (response.status === 404) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy team bên VCBI',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `VCBI trả lỗi khi lấy KPI (HTTP ${response.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    return (await response.json()) as AutomationGenVideoKpiResponse;
  }

  async fetchPerformanceGoalsForPayrollSync(
    externalTeamId: string,
    month: string,
  ): Promise<AutomationGenVideoPerformanceGoalResponse> {
    const { baseUrl, apiKey } = this.getConnectionConfig();
    const response = await fetch(
      `${baseUrl}/api/task-auto/teams/${externalTeamId}/performance-goals/payroll-sync?month=${encodeURIComponent(month)}`,
      {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (response.status === 404) {
      throw new AppException(
        ErrorCode.NOT_FOUND,
        'Không tìm thấy team bên VCBI',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `VCBI trả lỗi khi lấy KPI/OKR linh hoạt (HTTP ${response.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    return (await response.json()) as AutomationGenVideoPerformanceGoalResponse;
  }

  /**
   * Traffic nhân sự tự báo cáo, tách theo nền tảng và theo từng ngày.
   *
   * Timeout rộng hơn các call khác (60s thay vì 30s): endpoint này quét `traffic_reports` của
   * TOÀN hệ thống trong cả kỳ, và Railway đo được cold start tới ~17s.
   */
  async fetchTrafficReports(
    query: AutomationGenVideoTrafficQuery,
  ): Promise<AutomationGenVideoTrafficResponse> {
    const { baseUrl, apiKey } = this.getConnectionConfig();
    const params = new URLSearchParams({
      date_from: query.dateFrom,
      date_to: query.dateTo,
    });
    if (query.team) params.set('team', query.team);
    if (query.email) params.set('email', query.email);

    const response = await fetch(
      `${baseUrl}/api/task-auto/traffic-reports?${params.toString()}`,
      { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(60_000) },
    );

    // 404 ở đây KHÔNG phải "không có dữ liệu" mà là route chưa được deploy bên AGV — phân biệt
    // rõ để người bấm đồng bộ không tưởng nhầm là kỳ này không ai báo cáo traffic.
    if (response.status === 404) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'VCBI chưa mở endpoint /api/task-auto/traffic-reports',
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `VCBI trả lỗi khi lấy traffic (HTTP ${response.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.rows)) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'VCBI trả dữ liệu traffic không hợp lệ',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return payload as unknown as AutomationGenVideoTrafficResponse;
  }

  /**
   * Đọc snapshot tuân thủ nhiệm vụ đã chốt bên VCBI cho đúng một nhân sự/team.
   * Salary chỉ hiển thị dữ liệu này để đánh giá; không sao chép vào cơ sở dữ liệu lương.
   *
   * Luôn gọi `group_by=person_day` (contract 1.1): phân trang theo ngày và mỗi ngày kèm mọi tuyến
   * cùng task, đúng như màn "Nhiệm vụ còn thiếu" bên VCBI nên số liệu hai bên trùng nhau.
   */
  async fetchTaskComplianceForPayrollSync(
    externalTeamId: string,
    query: AutomationGenVideoTaskComplianceQuery,
  ): Promise<AutomationGenVideoTaskComplianceResponse> {
    const { baseUrl, apiKey } = this.getConnectionConfig();
    const params = new URLSearchParams({
      from: query.dateFrom,
      to: query.dateTo,
      user_id: query.externalUserId,
      group_by: 'person_day',
      page: String(query.page),
      limit: String(query.limit),
    });
    const response = await fetch(
      `${baseUrl}/api/task-auto/teams/${encodeURIComponent(externalTeamId)}/task-compliance/payroll-sync?${params.toString()}`,
      { headers: { 'x-api-key': apiKey }, signal: AbortSignal.timeout(30_000) },
    );

    if (response.status === 404) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'VCBI chưa mở endpoint lịch sử tuân thủ nhiệm vụ hoặc không tìm thấy team',
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `VCBI trả lỗi khi lấy lịch sử tuân thủ nhiệm vụ (HTTP ${response.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const payload: unknown = await response.json();
    // Bản 1.0 bỏ qua group_by nên không có days[]; báo rõ để không tưởng nhầm là dữ liệu hỏng.
    if (isRecord(payload) && payload.contract_version === '1.0') {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'VCBI đang chạy bản cũ của API tuân thủ nhiệm vụ (1.0), cần cập nhật lên 1.1',
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!isTaskComplianceResponse(payload)) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'VCBI trả dữ liệu tuân thủ nhiệm vụ không hợp lệ',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return payload;
  }

  private getConnectionConfig() {
    const baseUrl = this.config
      .get<string>('AUTOMATION_GEN_VIDEO_BASE_URL', '')
      .replace(/\/+$/, '')
      .replace(/\/api$/, '');
    const apiKey = this.config.get<string>('AUTOMATION_GEN_VIDEO_API_KEY', '');
    if (!baseUrl || !apiKey) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'Chưa cấu hình AUTOMATION_GEN_VIDEO_BASE_URL / AUTOMATION_GEN_VIDEO_API_KEY',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
    return { baseUrl, apiKey };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isTeamSummary(value: unknown): value is AutomationGenVideoTeamSummary {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0;
}

function isTaskComplianceResponse(
  value: unknown,
): value is AutomationGenVideoTaskComplianceResponse {
  if (!isRecord(value)) return false;
  const summary = value.summary;
  const shortfall = value.shortfall_summary;
  const coverage = value.coverage;
  const pagination = value.pagination;
  const range = value.range;
  const team = value.team;
  const filters = value.filters;
  return (
    typeof value.contract_version === 'string' &&
    typeof value.generated_at === 'string' &&
    typeof value.timezone === 'string' &&
    isRecord(range) &&
    typeof range.from === 'string' &&
    typeof range.to === 'string' &&
    isRecord(team) &&
    typeof team.id === 'string' &&
    typeof team.name === 'string' &&
    isRecord(filters) &&
    (filters.user_id === null || typeof filters.user_id === 'string') &&
    isRecord(summary) &&
    typeof summary.expected === 'number' &&
    typeof summary.completed_on_time === 'number' &&
    typeof summary.missing === 'number' &&
    typeof summary.affected_days === 'number' &&
    typeof summary.affected_records === 'number' &&
    isComplianceCounts(shortfall) &&
    typeof shortfall.person_days === 'number' &&
    typeof shortfall.lines === 'number' &&
    isRecord(coverage) &&
    typeof coverage.snapshot_count === 'number' &&
    (coverage.evaluated_from === null ||
      typeof coverage.evaluated_from === 'string') &&
    (coverage.evaluated_through === null ||
      typeof coverage.evaluated_through === 'string') &&
    Array.isArray(value.records) &&
    value.records.every(isTaskComplianceRecord) &&
    Array.isArray(value.days) &&
    value.days.every(isTaskComplianceDay) &&
    isRecord(pagination) &&
    typeof pagination.page === 'number' &&
    typeof pagination.limit === 'number' &&
    typeof pagination.total === 'number' &&
    typeof pagination.total_pages === 'number' &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isTaskComplianceWarning)
  );
}

function isTaskComplianceWarning(
  value: unknown,
): value is AutomationGenVideoKpiWarning {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.user_id === undefined || typeof value.user_id === 'string')
  );
}

function isTaskComplianceRecord(
  value: unknown,
): value is AutomationGenVideoTaskComplianceRecord {
  if (!isRecord(value) || !isRecord(value.content_line)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.user_id === 'string' &&
    typeof value.user_name === 'string' &&
    typeof value.team_id === 'string' &&
    typeof value.work_date === 'string' &&
    typeof value.content_line.id === 'string' &&
    typeof value.content_line.name === 'string' &&
    (value.source === 'AUTO_A4' || value.source === 'DAILY_PLAN') &&
    typeof value.expected_count === 'number' &&
    typeof value.completed_count === 'number' &&
    typeof value.missing_count === 'number' &&
    typeof value.deadline === 'string' &&
    typeof value.evaluated_at === 'string' &&
    typeof value.untracked_missing === 'number' &&
    Array.isArray(value.tasks) &&
    value.tasks.every(isTaskComplianceTask)
  );
}

function isTaskComplianceTask(
  value: unknown,
): value is AutomationGenVideoTaskComplianceTask {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.title === null || typeof value.title === 'string') &&
    (value.product_name === null || typeof value.product_name === 'string') &&
    typeof value.status === 'string' &&
    (value.deadline === null || typeof value.deadline === 'string') &&
    (value.submitted_at === null || typeof value.submitted_at === 'string') &&
    typeof value.on_time === 'boolean'
  );
}

function isComplianceCounts(
  value: unknown,
): value is Record<string, unknown> & AutomationGenVideoTaskComplianceCounts {
  return (
    isRecord(value) &&
    typeof value.expected === 'number' &&
    typeof value.completed === 'number' &&
    typeof value.missing === 'number'
  );
}

function isTaskComplianceDay(
  value: unknown,
): value is AutomationGenVideoTaskComplianceDay {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.work_date === 'string' &&
    typeof value.user_id === 'string' &&
    typeof value.user_name === 'string' &&
    typeof value.expected_count === 'number' &&
    typeof value.completed_count === 'number' &&
    typeof value.missing_count === 'number' &&
    isComplianceCounts(value.day_total) &&
    Array.isArray(value.lines) &&
    value.lines.every(isTaskComplianceRecord)
  );
}
