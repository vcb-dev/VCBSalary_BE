# VCBSalary_BE

NestJS API cho VCB Salary. Hiện tại chỉ có module **auth** (cookie HttpOnly, SameSite=Lax).

## Chạy local

```bash
npm install
npx prisma generate
python3 -c "import sqlite3, pathlib; p=pathlib.Path('prisma/dev.db');
p.unlink(missing_ok=True); con=sqlite3.connect(p);
con.executescript(pathlib.Path('prisma/init.sql').read_text()); con.close()"
npm run start:dev
```

API: `http://localhost:3000/api`

## Tài khoản demo

| Vai trò | Email | Mật khẩu |
| --- | --- | --- |
| Admin | admin@vcbsalary.vn | Admin@123 |
| HR | hr@vcbsalary.vn | Admin@123 |

## Auth

Login không trả JWT trong JSON. Backend set cookie:

- `vcbsalary_at` — access token, HttpOnly, SameSite=Lax
- `vcbsalary_rt` — refresh token, HttpOnly, SameSite=Lax, path `/api/auth`
- `vcbsalary_csrf` — CSRF double-submit, không HttpOnly, SameSite=Lax

## API

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/health`
