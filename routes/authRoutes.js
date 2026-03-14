import express from "express";
import {login, callback} from "../controllers/authControllers.js"

const router = express.Router();

router.get("/zerodha/login", login);
router.get("/zerodha/callback", callback);

export default router;
