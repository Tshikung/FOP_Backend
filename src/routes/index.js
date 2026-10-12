import { Router } from "express";
import { authenticate, requireStaff } from "../middleware/auth.js";
import { authRouter } from "../modules/auth.js";
import { meRouter } from "../modules/me.js";
import { learnRouter } from "../modules/learn.js";
import { dashboardRouter } from "../modules/dashboard.js";
import { libraryRouter } from "../modules/library.js";
import { commentsRouter } from "../modules/comments.js";
import { questionsRouter } from "../modules/questions.js";
import { eventsRouter } from "../modules/events.js";
import { notificationsRouter } from "../modules/notifications.js";
import { searchRouter } from "../modules/search.js";
import { filesRouter } from "../modules/files.js";
import { publicSettingsRouter } from "../modules/settings.js";
import { publicRouter, directoryRouter } from "../modules/public.js";
import admin from "./admin.js";

const api = Router();

api.use("/auth", authRouter); // public routes
api.use(publicRouter);

api.use(authenticate); // everything below needs a signed-in, active user
api.use(
  meRouter, learnRouter, dashboardRouter, libraryRouter, commentsRouter, questionsRouter,
  eventsRouter, notificationsRouter, searchRouter, filesRouter, publicSettingsRouter, directoryRouter,
);
api.use("/admin", requireStaff, admin); // mentor portal

export default api;
