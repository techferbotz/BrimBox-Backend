import "express";

// Augment Express' Request type so handlers can read:
//  - userId:    set by requireAuth (or, for GET /config only, optionalAuth) from an access token
//  - sessionId: set by requireAuth — the signed-in device making the request
//  - deviceId:  set by optionalDevice from the X-Device-Id header
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
      deviceId?: string;
    }
  }
}
