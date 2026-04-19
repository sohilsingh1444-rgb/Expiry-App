import { Router, type IRouter } from "express";
import healthRouter from "./health";
import expiryScansRouter from "./expiryScans";

const router: IRouter = Router();

router.use(healthRouter);
router.use(expiryScansRouter);

export default router;
