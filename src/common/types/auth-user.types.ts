/** Người dùng đã xác thực, được JwtStrategy gắn vào request và đọc qua `@CurrentUser()`. */
export type AuthUserPayload = {
  id: string;
  email: string;
};
