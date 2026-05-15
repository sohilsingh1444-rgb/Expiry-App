import { Router, type IRouter } from "express";
import healthRouter from "./health";
import expiryScansRouter from "./expiryScans";
import adminRouter from "./admin";
import emailRouter from "./email";
import barcodeMasterRouter from "./barcodeMaster";
import masterDataRouter from "./masterData";

const router: IRouter = Router();

router.use(healthRouter);
router.use(expiryScansRouter);
router.use(adminRouter);
router.use(emailRouter);
router.use(barcodeMasterRouter);
router.use(masterDataRouter);

export default router;
