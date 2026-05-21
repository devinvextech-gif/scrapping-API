import { Router } from "express";
import healthRouter from "../health/route.js";
import scrappingRouter from "../scrapping/route.js";

const router = Router();

router.use(healthRouter);
router.use(scrappingRouter);

export default router;
