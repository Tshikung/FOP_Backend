import { one } from "../config/db.js";

export const getSettings = () => one("SELECT * FROM club_settings WHERE id = 1");
