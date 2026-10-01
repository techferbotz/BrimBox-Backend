import { Request, Response } from "express";
import { renderDeleteAccount, renderPrivacyPolicy, renderTermsOfService } from "../legal.view";

// Public, server-rendered legal pages (HOA protocol 12). Pure and synchronous — rendered from
// constants, no database — so they stay up when everything else is down. Served as HTML so the
// URLs work on the store listings and in the app's in-app browser.
export const legalController = {
  // GET /privacy — the privacy policy URL for the store listings.
  privacyPolicy(_req: Request, res: Response): void {
    res.type("html").send(renderPrivacyPolicy());
  },

  // GET /terms — terms of service, linked from sign-in and the billing screens.
  termsOfService(_req: Request, res: Response): void {
    res.type("html").send(renderTermsOfService());
  },

  // GET /delete-account — the "Delete account URL" on the Play listing: must work without the
  // app installed and without signing in.
  deleteAccount(_req: Request, res: Response): void {
    res.type("html").send(renderDeleteAccount());
  },
};
