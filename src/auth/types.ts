import { Role } from '@prisma/client';

export type AuthUserPayload = {
  id: string;
  email: string;
  fullName: string;
  role: Role;
};

/** Claims trong access JWT — đủ để auth mà không query DB mỗi request */
export type JwtPayload = {
  sub: string;
  email: string;
  fullName: string;
  role: Role;
};
