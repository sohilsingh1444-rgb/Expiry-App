import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

app.use("/api", router);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const causeErr = err instanceof Error && err.cause instanceof Error ? err.cause : undefined;
  const causeCode = causeErr ? (causeErr as NodeJS.ErrnoException).code : undefined;
  logger.error({ err }, "Unhandled route error");
  // Return a generic message — never echo raw error text (may contain large DB values)
  res.status(500).json({ error: "An unexpected server error occurred. Please try again.", code: causeCode });
});

export default app;
