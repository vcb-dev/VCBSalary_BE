/** Claims trong access JWT — đủ để auth mà không query DB mỗi request */
export type JwtPayload = {
  sub: string;
  email: string;
};
