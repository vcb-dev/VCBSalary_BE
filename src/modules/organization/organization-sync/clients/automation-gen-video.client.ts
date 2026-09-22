import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../../../common/errors/app.exception';
import { ErrorCode } from '../../../../common/errors/error-codes';

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

/**
 * Gọi endpoint `GET /api/task-auto/teams/:id/payroll-sync` bên AutomationGenVideo_BE (xác thực
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
        `AutomationGenVideo trả lỗi khi lấy danh sách team (HTTP ${response.status})`,
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
        'AutomationGenVideo trả dữ liệu danh sách team không hợp lệ',
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
        'Không tìm thấy team bên AutomationGenVideo',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `AutomationGenVideo trả lỗi khi lấy dữ liệu team (HTTP ${response.status})`,
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
        'Không tìm thấy team bên AutomationGenVideo',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!response.ok) {
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        `AutomationGenVideo trả lỗi khi lấy KPI (HTTP ${response.status})`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    return (await response.json()) as AutomationGenVideoKpiResponse;
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
