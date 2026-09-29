import type { User } from "./db/schema";

export type AppEnv = {
  Bindings: Env;
  Variables: { user: User };
};

export type Role = "owner" | "editor" | "viewer";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 502,
    message: string,
  ) {
    super(message);
  }
}

export const fail = (status: HttpError["status"], message: string): never => {
  throw new HttpError(status, message);
};
