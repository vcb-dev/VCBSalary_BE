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
