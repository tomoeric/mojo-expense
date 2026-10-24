import { Router, type IRouter, type Request, type Response } from "express";

/**
 * Dutch Miller — the second app on this deployment.
 *
 * A shell for now, deliberately. The split it sits behind is the part that
 * had to exist first: assignment by email, a server that refuses the other
 * product's routes rather than merely hiding them, and a switcher for the
 * one person who holds both. Configuration and the actual pages follow.
 *
 * Everything under here is mounted behind `requireApp("dutch-miller")`, so
 * a route added to this file is access-controlled by being here. Nothing
 * Dutch Miller needs should be hung off the Emburse routers instead.
 */
export const dutchMillerRouter: IRouter = Router();

dutchMillerRouter.get("/status", (_req: Request, res: Response) => {
  res.json({
    app: "dutch-miller",
    ready: false,
    note: "Dutch Miller is set up but not configured yet.",
  });
});
