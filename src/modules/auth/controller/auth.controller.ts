import { Request, Response } from "express";
import { sendSuccess } from "../../../common/response/apiResponse";
import { optionalString, requireObjectBody, requireString } from "../../../common/validation";
import {
  APP_PLATFORM_HEADER,
  APP_VERSION_HEADER,
  parseContextHeaders,
} from "../../remoteConfig/remoteConfig.context";
import { DeviceInfo } from "../dto/auth.dto";
import { authService } from "../service/auth.service";

// Thin controllers: read input, check its shape, call the service, respond.

// Device hints for the "signed-in devices" list: the install id (optionalDevice) and the protocol 11
// headers every request carries, plus a display name from the body.
const deviceInfo = (req: Request, deviceName: string | null): DeviceInfo => {
  const ctx = parseContextHeaders(
    { platform: req.header(APP_PLATFORM_HEADER), version: req.header(APP_VERSION_HEADER) },
    { deviceId: req.deviceId ?? null, userId: null }
  );
  return {
    deviceId: ctx.deviceId,
    deviceName,
    platform: ctx.platform === "unknown" ? null : ctx.platform,
    appVersion: ctx.appVersion,
  };
};

// POST /api/v1/auth/google — { idToken, deviceName? } → tokens + user
export const signInWithGoogle = async (req: Request, res: Response): Promise<void> => {
  const body = requireObjectBody(req.body);
  // A Google idToken is a JWT, comfortably over the default length limit.
  const idToken = requireString(body.idToken, "idToken", 4096);
  const deviceName = optionalString(body.deviceName, "deviceName", 100) ?? null;
  sendSuccess(res, await authService.signInWithGoogle(idToken, deviceInfo(req, deviceName)));
};

// POST /api/v1/auth/refresh — { refreshToken } → a new, rotated pair
export const refresh = async (req: Request, res: Response): Promise<void> => {
  const body = requireObjectBody(req.body);
  const refreshToken = requireString(body.refreshToken, "refreshToken", 128);
  sendSuccess(res, await authService.refresh(refreshToken));
};

// POST /api/v1/auth/logout — { refreshToken } → {} (always, whether or not the token was live)
export const logout = async (req: Request, res: Response): Promise<void> => {
  const body = requireObjectBody(req.body);
  const refreshToken = requireString(body.refreshToken, "refreshToken", 128);
  await authService.logout(refreshToken);
  sendSuccess(res);
};
