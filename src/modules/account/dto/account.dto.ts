import { User } from "@prisma/client";
import { SessionListRow } from "../../auth/repository/session.repository";

// Response shapes for /api/v1/me. Raw Prisma rows never leave the server: these mappers decide
// exactly what the app sees (no googleSub, no token hashes).

export interface UserDto {
  id: string;
  email: string | null;
  name: string | null;
  photoUrl: string | null;
  createdAt: string;
}

export const toUserDto = (user: User): UserDto => ({
  id: user.id,
  email: user.email,
  name: user.name,
  photoUrl: user.photoUrl,
  createdAt: user.createdAt.toISOString(),
});

export interface SessionDto {
  id: string;
  deviceName: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: string;
  lastUsedAt: string;
  // True for the session making this request — the app can label it "This device".
  current: boolean;
}

export const toSessionDto = (row: SessionListRow, currentSessionId: string): SessionDto => ({
  id: row.id,
  deviceName: row.deviceName,
  platform: row.platform,
  appVersion: row.appVersion,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt.toISOString(),
  current: row.id === currentSessionId,
});
