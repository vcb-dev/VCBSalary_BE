# VCB Salary API

NestJS + Prisma/PostgreSQL API cho hệ thống quản lý nhân sự, kỳ lương, KPI/OKR, traffic, doanh thu, cấu hình thưởng, tính/duyệt lương, phân quyền, thông báo và audit log.

## Chạy local

Yêu cầu Node.js, npm và một PostgreSQL database. Cấu hình tối thiểu trong `.env`:

```dotenv
DATABASE_URL=postgresql://user:password@localhost:5432/vcb_salary
DIRECT_URL=postgresql://user:password@localhost:5432/vcb_salary
JWT_SECRET=replace-with-a-long-random-secret
FE_ORIGIN=http://localhost:5173
```

Nếu không khai báo `DIRECT_URL`, Prisma sẽ dùng `DATABASE_URL` cho migration.
Biến môi trường truyền trực tiếp từ CI/shell luôn được ưu tiên hơn file `.env` cục bộ.

Với database hoàn toàn mới:

```bash
npm install
npm run db:setup
npm run start:dev
```

`db:setup` dựng schema hiện tại, ghi nhận lịch sử migration tăng dần sẵn có, rồi chạy seed. Repository này được chuyển từ một baseline có trước migration đầu tiên nên không chạy trực tiếp `prisma migrate deploy` trên database rỗng.

Với database đã tồn tại và đã có bảng `_prisma_migrations`:

```bash
npm install
npx prisma generate
npx prisma migrate deploy
npm run start:dev
```

Không chạy `db:bootstrap` trên database đang vận hành. Lệnh đó chỉ dành cho database rỗng; các môi trường hiện hữu dùng `prisma migrate deploy`.

API mặc định: `http://localhost:3000/api`.

## Kiểm tra chất lượng

```bash
npm run build
npm test -- --runInBand
npx prisma validate
```

E2E cần kết nối được database test riêng:

```bash
npm run test:e2e
```

## Bảo mật và biến môi trường

- `COOKIE_SECURE`: nếu không khai báo, tự bật khi `NODE_ENV=production`.
- `SWAGGER_ENABLED`: mặc định bật ngoài production và tắt trong production.
- `LOGIN_MAX_ATTEMPTS`: số lần đăng nhập sai trước khi tạm khóa, mặc định `5`.
- `LOGIN_WINDOW_SECONDS`: cửa sổ giới hạn đăng nhập, mặc định `900` giây.
- `TRUST_PROXY=true`: bật khi ứng dụng chạy sau đúng một reverse proxy tin cậy để lấy IP thật.
- `FE_ORIGIN`: danh sách origin được phép, phân tách bằng dấu phẩy.
- `PAYROLL_AUTO_OPEN_ENABLED`: bật/tắt cơ chế tự tạo và mở kỳ lương tháng hiện tại; mặc định bật
  ngoài môi trường test.
- `PAYROLL_PERIOD_CHECK_INTERVAL_MS`: chu kỳ kiểm tra kỳ tháng hiện tại, mặc định `900000`
  (15 phút), tối thiểu 60 giây.

Khi tự mở kỳ, hệ thống dùng tài khoản `ACTIVE` lâu đời nhất có quyền
`payroll_period.manage` ở phạm vi `ALL` làm actor audit. Nếu chưa có Reward Rule Set đang active
hoặc dữ liệu team/tỷ trọng KPI của nhân sự chưa hợp lệ, kỳ tháng vẫn được tạo ở trạng thái Nháp
và sẽ được thử mở lại ở chu kỳ sau.

Rate limit đăng nhập hiện lưu trong bộ nhớ tiến trình. Khi chạy nhiều instance, đặt rate limit dùng chung ở API gateway/Redis để giới hạn có hiệu lực toàn cụm.

Swagger chỉ có tại `/api/docs` khi `SWAGGER_ENABLED=true` (hoặc ở môi trường không phải production nếu biến này chưa được đặt).

## Đồng bộ KPI/OKR từ AutomationGenVideo

Cấu hình kết nối một chiều:

```dotenv
AUTOMATION_GEN_VIDEO_BASE_URL=http://localhost:3000
AUTOMATION_GEN_VIDEO_API_KEY=agv_...
```

Một lượt `POST /api/kpi-sync-runs` lấy đồng thời KPI cố định, KPI linh hoạt theo nhóm và OKR của
đúng team + tháng. KPI linh hoạt được upsert thành `KpiItem` bằng `external_item_id`, gắn vào
`KpiGroup` theo `kpi_group_code` và có target/actual riêng của nhân sự. Vì vậy KPI thuộc nhóm
`CONTENT` đi qua đúng luồng KPI Content bình thường: xác nhận, duyệt, tính tiến độ nhóm và mức
thưởng nhóm. OKR vẫn được lưu riêng; target/actual và revision do AutomationGenVideo quản lý,
còn `rewardAmount` được giữ tại VCB Salary và mặc định bằng `0`. Mục không còn xuất hiện trong
snapshot nguồn sẽ được vô hiệu, không bị xóa khỏi lịch sử. Cả KPI và OKR dùng ngưỡng của ruleset
kỳ lương và cơ chế thưởng nhị phân.

## Auth

Login không trả JWT trong JSON. Backend dùng cookie:

- `vcbsalary_at`: access token, HttpOnly, SameSite=Lax.
- `vcbsalary_rt`: refresh token xoay vòng, HttpOnly, SameSite=Lax, giới hạn path `/api/auth`.
- `vcbsalary_csrf`: token double-submit CSRF để frontend gửi qua `X-CSRF-Token`.
