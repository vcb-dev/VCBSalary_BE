import type { TrafficPlatform } from '@prisma/client';
import type { AutomationGenVideoTrafficRow } from '../../../common/clients/automation-gen-video.client';

/**
 * Cột traffic bên AutomationGenVideo → nền tảng của hệ thống lương.
 *
 * `thread` và `zalo` cố tình không có mặt: `TrafficPlatform` chỉ có 4 giá trị, và hai nền tảng đó
 * chưa nằm trong chính sách thưởng. Số của chúng được đếm riêng vào `unmappedPlatforms` để lượt
 * đồng bộ cảnh báo thay vì âm thầm bỏ đi.
 */
const PLATFORM_BY_SOURCE_KEY = {
  fb: 'FACEBOOK',
  ig: 'INSTAGRAM',
  tiktok: 'TIKTOK',
  yt: 'YOUTUBE',
} as const satisfies Record<string, TrafficPlatform>;

const UNMAPPED_SOURCE_KEYS = ['thread', 'zalo'] as const;

type SourceKey = keyof typeof PLATFORM_BY_SOURCE_KEY;

export type TrafficPlatformValue = {
  platform: TrafficPlatform;
  views: bigint;
  /** Tên kênh người báo cáo khai cho nền tảng đó, dùng để đối chiếu khi có tranh chấp số liệu. */
  channel: string | null;
};

export type NormalizedTrafficRow = {
  /** Đã lowercase + trim; `null` khi bản ghi cũ đồng bộ từ Lark thiếu email. */
  email: string | null;
  name: string | null;
  team: string | null;
  /** Ngày báo cáo (`YYYY-MM-DD`) mà con số này được lấy từ đó. */
  reportDate: string;
  platforms: TrafficPlatformValue[];
  total: bigint;
  /** Nền tảng có số nhưng hệ thống lương chưa hỗ trợ (thread/zalo). */
  unmappedPlatforms: { platform: string; views: bigint }[];
};

export const normalizeEmail = (value: string | null | undefined) =>
  value?.trim().toLowerCase() || null;

export const normalizeName = (value: string | null | undefined) =>
  value?.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase() || null;

/** Khoá gộp một người: ưu tiên email, chỉ rơi về tên khi bản ghi nguồn thiếu email. */
export function trafficRowKey(row: {
  email: string | null;
  name: string | null;
}): string | null {
  const email = normalizeEmail(row.email);
  if (email) return `email:${email}`;
  const name = normalizeName(row.name);
  return name ? `name:${name}` : null;
}

function toBigInt(value: number | null | undefined): bigint {
  if (!Number.isFinite(value ?? NaN)) return 0n;
  const rounded = Math.trunc(value as number);
  return rounded > 0 ? BigInt(rounded) : 0n;
}

function channelFor(
  row: AutomationGenVideoTrafficRow,
  sourceKey: SourceKey,
): string | null {
  const detail = (row.details ?? []).find(
    (item) => item.platform === sourceKey && item.channel,
  );
  return detail?.channel ?? null;
}

/**
 * Chọn đúng MỘT dòng cho mỗi người: dòng có ngày báo cáo lớn nhất trong kỳ.
 *
 * Không cộng dồn các ngày, vì traffic là số LUỸ KẾ tới thời điểm báo cáo chứ không phải lượng
 * phát sinh trong ngày — bên AutomationGenVideo, `sumTrafficOnLatestDate()` cũng chốt theo đúng
 * quy tắc này cho dashboard. Cộng nhiều ngày lại sẽ thổi phồng traffic lên nhiều lần.
 *
 * Hai dòng cùng người cùng ngày (nhiều kênh) đã được nguồn gộp sẵn; nếu vẫn gặp thì cộng lại vì
 * cộng trong phạm vi một ngày là đúng.
 */
export function selectLatestRowPerPerson(
  rows: readonly AutomationGenVideoTrafficRow[],
): NormalizedTrafficRow[] {
  const latestByKey = new Map<string, NormalizedTrafficRow>();

  for (const row of rows) {
    const key = trafficRowKey(row);
    if (!key || !row.date) continue;

    const current = latestByKey.get(key);
    if (current && current.reportDate > row.date) continue;

    const platforms: TrafficPlatformValue[] = [];
    for (const [sourceKey, platform] of Object.entries(
      PLATFORM_BY_SOURCE_KEY,
    ) as [SourceKey, TrafficPlatform][]) {
      platforms.push({
        platform,
        views: toBigInt(row[sourceKey]),
        channel: channelFor(row, sourceKey),
      });
    }
    const unmappedPlatforms = UNMAPPED_SOURCE_KEYS.map((sourceKey) => ({
      platform: sourceKey,
      views: toBigInt(row[sourceKey]),
    })).filter((item) => item.views > 0n);

    const normalized: NormalizedTrafficRow = {
      email: normalizeEmail(row.email),
      name: row.name?.trim() || null,
      team: row.team?.trim() || null,
      reportDate: row.date,
      platforms,
      total: toBigInt(row.total),
      unmappedPlatforms,
    };

    // Cùng người cùng ngày → cộng gộp (đúng trong phạm vi một ngày).
    if (current && current.reportDate === row.date) {
      latestByKey.set(key, mergeSameDay(current, normalized));
      continue;
    }
    latestByKey.set(key, normalized);
  }

  return Array.from(latestByKey.values());
}

function mergeSameDay(
  left: NormalizedTrafficRow,
  right: NormalizedTrafficRow,
): NormalizedTrafficRow {
  const byPlatform = new Map(
    left.platforms.map((item) => [item.platform, { ...item }]),
  );
  for (const item of right.platforms) {
    const existing = byPlatform.get(item.platform);
    if (!existing) {
      byPlatform.set(item.platform, { ...item });
      continue;
    }
    existing.views += item.views;
    existing.channel ??= item.channel;
  }
  const unmapped = new Map(
    left.unmappedPlatforms.map((item) => [item.platform, { ...item }]),
  );
  for (const item of right.unmappedPlatforms) {
    const existing = unmapped.get(item.platform);
    if (existing) existing.views += item.views;
    else unmapped.set(item.platform, { ...item });
  }

  return {
    ...left,
    team: left.team ?? right.team,
    name: left.name ?? right.name,
    platforms: Array.from(byPlatform.values()),
    total: left.total + right.total,
    unmappedPlatforms: Array.from(unmapped.values()),
  };
}
