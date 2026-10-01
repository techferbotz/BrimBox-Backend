import "express";

// Augment Express' Request type so handlers can read:
//  - userId:   set by the auth middleware after validating an access token (from P1)
//  - deviceId: set by optionalDevice from the X-Device-Id header
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      deviceId?: string;
    }
  }
}
