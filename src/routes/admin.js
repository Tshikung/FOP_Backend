import { Router } from "express";
import { adminOverviewRouter } from "../modules/overview.js";
import { adminQuestionsRouter } from "../modules/questions.js";
import { adminMembersRouter } from "../modules/members.js";
import { adminMentorsRouter } from "../modules/mentors.js";
import { adminContentRouter } from "../modules/adminContent.js";
import { adminEventsRouter } from "../modules/events.js";
import { adminAnnouncementsRouter } from "../modules/announcements.js";
import { adminFlagsRouter } from "../modules/moderation.js";
import { adminSettingsRouter, adminPermissionsRouter } from "../modules/settings.js";

// Everything here is behind authenticate + requireStaff. Individual routes add requirePermission().
const admin = Router();
admin.use("/overview", adminOverviewRouter);
admin.use("/questions", adminQuestionsRouter);
admin.use("/members", adminMembersRouter);
admin.use("/mentors", adminMentorsRouter);
admin.use("/content", adminContentRouter);
admin.use("/events", adminEventsRouter);
admin.use("/announcements", adminAnnouncementsRouter);
admin.use("/flags", adminFlagsRouter);
admin.use("/settings", adminSettingsRouter);
admin.use("/permissions", adminPermissionsRouter);

export default admin;
