import { Router, type IRouter } from "express";
import healthRouter from "./health";
import expiryScansRouter from "./expiryScans";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(expiryScansRouter);
router.use(adminRouter);

export default router;
