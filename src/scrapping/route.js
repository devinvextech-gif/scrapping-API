import { Router } from "express";
import { extract } from "./controller.js";

const router = Router();

router.post("/extract", extract);

export default router;
