-- =====================================================================
--  Friends of Python club - MySQL 8.0+ schema
--  Database : friends_of_python_club
--  Serves   : the member portal AND the mentor (admin) portal
--
--  Conventions
--   * InnoDB, utf8mb4. Primary keys are BIGINT UNSIGNED AUTO_INCREMENT.
--   * All DATETIME values are stored in UTC. Convert to the viewer's
--     time zone (Kampala is UTC+3) in the API or the frontend.
--   * Roles: member | mentor | head_admin  (one `users` table for everyone).
--   * Videos, books and blogs share one `content_items` table, so likes,
--     comments, saves and the mentor Content page work on real foreign keys.
--   * Uploaded files live on disk or cloud storage. The DB stores only
--     the path, type and size in `files`.
--   * Rules a CHECK cannot enforce (for example, assigned_to must be a
--     mentor) must be enforced in the API.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS friends_of_python_club
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE friends_of_python_club;

-- ---------------------------------------------------------------------
-- 1. USERS, MENTORS, AUTH
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email             VARCHAR(190) NOT NULL,
  password_hash     VARCHAR(255) NULL COMMENT 'bcrypt/argon2. NULL for Google-only accounts and pending invites',
  google_id         VARCHAR(64)  NULL,
  display_name      VARCHAR(100) NOT NULL,
  username          VARCHAR(30)  NULL,
  avatar_url        VARCHAR(500) NULL,
  bio               TEXT NULL,
  experience_level  ENUM('new','basics','experienced') NOT NULL DEFAULT 'new',
  role              ENUM('member','mentor','head_admin') NOT NULL DEFAULT 'member',
  status            ENUM('active','invited','suspended','deactivated') NOT NULL DEFAULT 'active',
  email_verified_at DATETIME NULL,
  last_login_at     DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_google (google_id),
  KEY idx_users_role_status (role, status),
  CONSTRAINT chk_users_username CHECK (username IS NULL OR username REGEXP '^[A-Za-z0-9_]{3,30}$')
) ENGINE=InnoDB;

-- Extra details for people who can answer questions (role mentor or head_admin)
CREATE TABLE mentor_profiles (
  user_id   BIGINT UNSIGNED NOT NULL,
  specialty VARCHAR(100) NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_mentor_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One table for mentor invites, password resets and email verification.
-- Store only a SHA-256 hash of the token, never the token itself.
CREATE TABLE auth_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  purpose    ENUM('invite','password_reset','email_verify','refresh') NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_auth_tokens_hash (token_hash),
  KEY idx_auth_tokens_user (user_id, purpose),
  CONSTRAINT fk_auth_tokens_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Profile page: followers / following. The API must reject follower_id = following_id.
CREATE TABLE follows (
  follower_id  BIGINT UNSIGNED NOT NULL,
  following_id BIGINT UNSIGNED NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, following_id),
  KEY idx_follows_following (following_id),
  CONSTRAINT fk_follows_follower  FOREIGN KEY (follower_id)  REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_follows_following FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Profile page: "Skills I'm learning"
CREATE TABLE user_skills (
  user_id BIGINT UNSIGNED NOT NULL,
  skill   VARCHAR(60) NOT NULL,
  PRIMARY KEY (user_id, skill),
  CONSTRAINT fk_user_skills_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 2. FILES, TOPICS, TAGS
-- ---------------------------------------------------------------------
CREATE TABLE files (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  uploaded_by   BIGINT UNSIGNED NULL,
  original_name VARCHAR(255) NOT NULL,
  stored_path   VARCHAR(500) NOT NULL COMMENT 'path or object key, never the file bytes',
  mime_type     VARCHAR(100) NOT NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_files_uploader (uploaded_by),
  CONSTRAINT fk_files_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Used by questions, videos and blog categories
CREATE TABLE topics (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(80) NOT NULL,
  slug       VARCHAR(80) NOT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_topics_slug (slug)
) ENGINE=InnoDB;

CREATE TABLE tags (
  id   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tags_name (name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 3. CONTENT: videos, books, blogs (supertype + subtype tables)
-- ---------------------------------------------------------------------
CREATE TABLE content_items (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type         ENUM('video','book','blog') NOT NULL,
  title        VARCHAR(200) NOT NULL,
  description  TEXT NULL,
  author_id    BIGINT UNSIGNED NOT NULL COMMENT 'uploader, instructor or blog writer',
  topic_id     INT UNSIGNED NULL,
  level        ENUM('beginner','intermediate','project','all_levels') NOT NULL DEFAULT 'all_levels',
  status       ENUM('draft','pending','published') NOT NULL DEFAULT 'draft',
  is_featured  TINYINT(1) NOT NULL DEFAULT 0,
  reviewed_by  BIGINT UNSIGNED NULL,
  reviewed_at  DATETIME NULL,
  published_at DATETIME NULL,
  deleted_at   DATETIME NULL COMMENT 'soft delete (Head admin only). NULL means not deleted',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_content_list (type, status, published_at),
  KEY idx_content_author (author_id),
  KEY idx_content_topic (topic_id),
  FULLTEXT KEY ft_content_search (title, description),
  CONSTRAINT fk_content_author   FOREIGN KEY (author_id)   REFERENCES users(id),
  CONSTRAINT fk_content_topic    FOREIGN KEY (topic_id)    REFERENCES topics(id) ON DELETE SET NULL,
  CONSTRAINT fk_content_reviewer FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE videos (
  content_id        BIGINT UNSIGNED NOT NULL,
  file_id           BIGINT UNSIGNED NULL,
  thumbnail_file_id BIGINT UNSIGNED NULL,
  duration_seconds  INT UNSIGNED NULL,
  PRIMARY KEY (content_id),
  CONSTRAINT fk_videos_content   FOREIGN KEY (content_id)        REFERENCES content_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_videos_file      FOREIGN KEY (file_id)           REFERENCES files(id) ON DELETE SET NULL,
  CONSTRAINT fk_videos_thumbnail FOREIGN KEY (thumbnail_file_id) REFERENCES files(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE books (
  content_id    BIGINT UNSIGNED NOT NULL,
  author_name   VARCHAR(150) NOT NULL COMMENT 'book authors are often not club users',
  page_count    SMALLINT UNSIGNED NULL,
  file_id       BIGINT UNSIGNED NULL COMMENT 'PDF or EPUB',
  cover_file_id BIGINT UNSIGNED NULL,
  PRIMARY KEY (content_id),
  CONSTRAINT fk_books_content FOREIGN KEY (content_id)    REFERENCES content_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_books_file    FOREIGN KEY (file_id)       REFERENCES files(id) ON DELETE SET NULL,
  CONSTRAINT fk_books_cover   FOREIGN KEY (cover_file_id) REFERENCES files(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE blog_posts (
  content_id   BIGINT UNSIGNED NOT NULL,
  excerpt      VARCHAR(300) NULL,
  body         MEDIUMTEXT NOT NULL,
  read_minutes TINYINT UNSIGNED NULL,
  review_note  VARCHAR(500) NULL COMMENT 'why a mentor sent it back',
  PRIMARY KEY (content_id),
  FULLTEXT KEY ft_blog_body (body),
  CONSTRAINT fk_blog_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE content_tags (
  content_id BIGINT UNSIGNED NOT NULL,
  tag_id     INT UNSIGNED NOT NULL,
  PRIMARY KEY (content_id, tag_id),
  KEY idx_content_tags_tag (tag_id),
  CONSTRAINT fk_content_tags_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_content_tags_tag     FOREIGN KEY (tag_id)     REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Monthly reading list on the Books page
CREATE TABLE reading_lists (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title        VARCHAR(150) NOT NULL,
  description  VARCHAR(500) NULL,
  month_label  VARCHAR(30) NULL COMMENT 'for example "October 2026"',
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  created_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_reading_lists_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE reading_list_items (
  list_id      BIGINT UNSIGNED NOT NULL,
  content_id   BIGINT UNSIGNED NOT NULL COMMENT 'must be a book',
  position     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  reason       VARCHAR(255) NULL,
  chapter_note VARCHAR(100) NULL,
  PRIMARY KEY (list_id, content_id),
  KEY idx_reading_list_order (list_id, position),
  CONSTRAINT fk_rli_list    FOREIGN KEY (list_id)    REFERENCES reading_lists(id) ON DELETE CASCADE,
  CONSTRAINT fk_rli_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 4. MEMBER ACTIVITY ON CONTENT
-- ---------------------------------------------------------------------
CREATE TABLE content_likes (
  user_id    BIGINT UNSIGNED NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, content_id),
  KEY idx_content_likes_content (content_id),
  CONSTRAINT fk_content_likes_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_content_likes_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- "Saved resources" page
CREATE TABLE bookmarks (
  user_id    BIGINT UNSIGNED NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, content_id),
  KEY idx_bookmarks_content (content_id),
  CONSTRAINT fk_bookmarks_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_bookmarks_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- "Continue watching" and the progress bar on video cards
CREATE TABLE video_progress (
  user_id         BIGINT UNSIGNED NOT NULL,
  content_id      BIGINT UNSIGNED NOT NULL,
  seconds_watched INT UNSIGNED NOT NULL DEFAULT 0,
  percent         TINYINT UNSIGNED NOT NULL DEFAULT 0,
  completed_at    DATETIME NULL,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, content_id),
  KEY idx_video_progress_content (content_id),
  CONSTRAINT chk_video_percent CHECK (percent <= 100),
  CONSTRAINT fk_video_progress_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_video_progress_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- E-book reader: where the member stopped
CREATE TABLE reading_progress (
  user_id    BIGINT UNSIGNED NOT NULL,
  content_id BIGINT UNSIGNED NOT NULL,
  last_page  SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, content_id),
  KEY idx_reading_progress_content (content_id),
  CONSTRAINT fk_reading_progress_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_reading_progress_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 5. COMMENTS AND MODERATION
-- ---------------------------------------------------------------------
CREATE TABLE comments (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  parent_id  BIGINT UNSIGNED NULL COMMENT 'set for replies',
  body       TEXT NOT NULL,
  status     ENUM('visible','removed') NOT NULL DEFAULT 'visible',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_comments_content (content_id, created_at),
  KEY idx_comments_user (user_id),
  KEY idx_comments_parent (parent_id),
  CONSTRAINT fk_comments_content FOREIGN KEY (content_id) REFERENCES content_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_comments_user    FOREIGN KEY (user_id)    REFERENCES users(id),
  CONSTRAINT fk_comments_parent  FOREIGN KEY (parent_id)  REFERENCES comments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE comment_likes (
  user_id    BIGINT UNSIGNED NOT NULL,
  comment_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, comment_id),
  KEY idx_comment_likes_comment (comment_id),
  CONSTRAINT fk_comment_likes_user    FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_comment_likes_comment FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Mentor portal > Moderation. Keep = status 'kept', Remove = 'removed'
-- (and set comments.status = 'removed' in the same transaction).
CREATE TABLE flags (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  comment_id  BIGINT UNSIGNED NOT NULL,
  reporter_id BIGINT UNSIGNED NOT NULL,
  reason      ENUM('spam','unkind','inappropriate','other') NOT NULL,
  details     VARCHAR(500) NULL,
  status      ENUM('open','kept','removed') NOT NULL DEFAULT 'open',
  resolved_by BIGINT UNSIGNED NULL,
  resolved_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_flags_once (comment_id, reporter_id),
  KEY idx_flags_status (status, created_at),
  CONSTRAINT fk_flags_comment  FOREIGN KEY (comment_id)  REFERENCES comments(id) ON DELETE CASCADE,
  CONSTRAINT fk_flags_reporter FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_flags_resolver FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 6. LEARNING PATHS, PROGRESS, STREAKS, XP, ACHIEVEMENTS
-- ---------------------------------------------------------------------
CREATE TABLE learning_paths (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title        VARCHAR(150) NOT NULL,
  slug         VARCHAR(150) NOT NULL,
  description  VARCHAR(500) NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_paths_slug (slug)
) ENGINE=InnoDB;

CREATE TABLE path_modules (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  path_id     BIGINT UNSIGNED NOT NULL,
  position    SMALLINT UNSIGNED NOT NULL,
  title       VARCHAR(150) NOT NULL,
  description VARCHAR(500) NULL,
  video_id    BIGINT UNSIGNED NULL COMMENT 'lesson video for this module (must be a video)',
  PRIMARY KEY (id),
  UNIQUE KEY uq_module_position (path_id, position),
  KEY idx_modules_video (video_id),
  CONSTRAINT fk_modules_path  FOREIGN KEY (path_id)  REFERENCES learning_paths(id) ON DELETE CASCADE,
  CONSTRAINT fk_modules_video FOREIGN KEY (video_id) REFERENCES content_items(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE path_enrollments (
  user_id    BIGINT UNSIGNED NOT NULL,
  path_id    BIGINT UNSIGNED NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, path_id),
  KEY idx_enroll_path (path_id),
  CONSTRAINT fk_enroll_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_enroll_path FOREIGN KEY (path_id) REFERENCES learning_paths(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Path progress % = completed modules / modules in the path
CREATE TABLE module_progress (
  user_id      BIGINT UNSIGNED NOT NULL,
  module_id    BIGINT UNSIGNED NOT NULL,
  completed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, module_id),
  KEY idx_module_progress_module (module_id),
  CONSTRAINT fk_modprog_user   FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_modprog_module FOREIGN KEY (module_id) REFERENCES path_modules(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- One row per day a member did something. The day streak is calculated from this.
CREATE TABLE activity_days (
  user_id       BIGINT UNSIGNED NOT NULL,
  activity_date DATE NOT NULL,
  PRIMARY KEY (user_id, activity_date),
  CONSTRAINT fk_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- "+20 XP" in recent activity. Total XP = SUM(points).
CREATE TABLE xp_ledger (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id    BIGINT UNSIGNED NOT NULL,
  points     INT NOT NULL,
  reason     VARCHAR(120) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_xp_user (user_id, created_at),
  CONSTRAINT fk_xp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE achievements (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(40) NOT NULL,
  title       VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_achievements_code (code)
) ENGINE=InnoDB;

CREATE TABLE user_achievements (
  user_id        BIGINT UNSIGNED NOT NULL,
  achievement_id INT UNSIGNED NOT NULL,
  earned_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, achievement_id),
  KEY idx_user_ach_ach (achievement_id),
  CONSTRAINT fk_user_ach_user FOREIGN KEY (user_id)        REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_ach_ach  FOREIGN KEY (achievement_id) REFERENCES achievements(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 7. ASK A MENTOR (member question > assigned mentor > reply)
-- ---------------------------------------------------------------------
CREATE TABLE questions (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  member_id   BIGINT UNSIGNED NOT NULL,
  title       VARCHAR(200) NOT NULL,
  body        TEXT NOT NULL,
  topic_id    INT UNSIGNED NULL,
  level       ENUM('beginner','intermediate','advanced') NOT NULL DEFAULT 'beginner',
  status      ENUM('open','answered','closed') NOT NULL DEFAULT 'open',
  assigned_to BIGINT UNSIGNED NULL COMMENT 'NULL = unassigned. API must ensure the user is a mentor',
  assigned_at DATETIME NULL,
  answered_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_questions_queue (status, assigned_to, created_at),
  KEY idx_questions_member (member_id, created_at),
  KEY idx_questions_assignee (assigned_to),
  FULLTEXT KEY ft_questions_search (title, body),
  CONSTRAINT fk_questions_member   FOREIGN KEY (member_id)   REFERENCES users(id),
  CONSTRAINT fk_questions_topic    FOREIGN KEY (topic_id)    REFERENCES topics(id) ON DELETE SET NULL,
  CONSTRAINT fk_questions_assignee FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE question_replies (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  question_id BIGINT UNSIGNED NOT NULL,
  author_id   BIGINT UNSIGNED NOT NULL COMMENT 'a mentor, or the member for a follow-up',
  body        TEXT NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_replies_question (question_id, created_at),
  KEY idx_replies_author (author_id),
  CONSTRAINT fk_replies_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  CONSTRAINT fk_replies_author   FOREIGN KEY (author_id)   REFERENCES users(id)
) ENGINE=InnoDB;

-- "Attach a screenshot or file" on the question form
CREATE TABLE question_attachments (
  question_id BIGINT UNSIGNED NOT NULL,
  file_id     BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (question_id, file_id),
  KEY idx_qattach_file (file_id),
  CONSTRAINT fk_qattach_question FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
  CONSTRAINT fk_qattach_file     FOREIGN KEY (file_id)     REFERENCES files(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 8. EVENTS AND WORKSHOPS
-- ---------------------------------------------------------------------
CREATE TABLE events (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title       VARCHAR(200) NOT NULL,
  kind        ENUM('workshop','meetup','qa') NOT NULL DEFAULT 'workshop',
  description TEXT NULL,
  starts_at   DATETIME NOT NULL,
  ends_at     DATETIME NULL,
  host_id     BIGINT UNSIGNED NOT NULL,
  location    VARCHAR(255) NOT NULL COMMENT 'room name or meeting link',
  capacity    SMALLINT UNSIGNED NULL COMMENT 'NULL = unlimited',
  created_by  BIGINT UNSIGNED NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_events_start (starts_at),
  KEY idx_events_host (host_id),
  CONSTRAINT chk_events_time CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT fk_events_host    FOREIGN KEY (host_id)    REFERENCES users(id),
  CONSTRAINT fk_events_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- "+18 going" = COUNT(*) per event
CREATE TABLE event_rsvps (
  event_id   BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id, user_id),
  KEY idx_rsvps_user (user_id),
  CONSTRAINT fk_rsvps_event FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT fk_rsvps_user  FOREIGN KEY (user_id)  REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 9. ANNOUNCEMENTS AND NOTIFICATIONS
-- ---------------------------------------------------------------------
CREATE TABLE announcements (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  title    VARCHAR(200) NOT NULL,
  body     TEXT NOT NULL,
  audience ENUM('all','beginners','intermediate_up','mentors') NOT NULL DEFAULT 'all',
  sent_by  BIGINT UNSIGNED NULL,
  sent_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_announcements_sent (sent_at),
  CONSTRAINT fk_announcements_sender FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- One row per recipient. Sending an announcement inserts one row for each user in its audience.
CREATE TABLE notifications (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  type            ENUM('mentor_reply','question_assigned','like','event','streak','announcement','system') NOT NULL,
  title           VARCHAR(200) NOT NULL,
  body            VARCHAR(500) NULL,
  ref_type        VARCHAR(30) NULL COMMENT 'question, content, event, ...',
  ref_id          BIGINT UNSIGNED NULL,
  announcement_id BIGINT UNSIGNED NULL,
  is_read         TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notifications_inbox (user_id, is_read, created_at),
  KEY idx_notifications_announcement (announcement_id),
  CONSTRAINT fk_notifications_user         FOREIGN KEY (user_id)         REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_announcement FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 10. SETTINGS, ROLES AND PERMISSIONS, AUDIT LOG
-- ---------------------------------------------------------------------
-- Exactly one row (id = 1)
CREATE TABLE club_settings (
  id                    TINYINT UNSIGNED NOT NULL DEFAULT 1,
  club_name             VARCHAR(100) NOT NULL,
  support_email         VARCHAR(190) NOT NULL,
  require_post_approval TINYINT(1) NOT NULL DEFAULT 1,
  allow_comments        TINYINT(1) NOT NULL DEFAULT 1,
  updated_by            BIGINT UNSIGNED NULL,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT chk_settings_single_row CHECK (id = 1),
  CONSTRAINT fk_settings_updater FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Same permission matrix as the Settings > Roles table in the mentor portal
CREATE TABLE permissions (
  permission_key VARCHAR(50)  NOT NULL,
  description    VARCHAR(150) NOT NULL,
  PRIMARY KEY (permission_key)
) ENGINE=InnoDB;

CREATE TABLE role_permissions (
  role           ENUM('mentor','head_admin') NOT NULL,
  permission_key VARCHAR(50) NOT NULL,
  PRIMARY KEY (role, permission_key),
  CONSTRAINT fk_role_perm_key FOREIGN KEY (permission_key) REFERENCES permissions(permission_key) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Who did what in the mentor portal (deletes, role changes, announcements, ...)
CREATE TABLE audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  actor_id    BIGINT UNSIGNED NULL,
  action      VARCHAR(60) NOT NULL COMMENT 'for example content.delete, mentor.role_change',
  entity_type VARCHAR(40) NOT NULL,
  entity_id   BIGINT UNSIGNED NULL,
  details     JSON NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_actor (actor_id, created_at),
  CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 11. VIEWS (read-only helpers for the API)
-- ---------------------------------------------------------------------
-- Mentors page: open questions per mentor
CREATE VIEW v_mentor_workload AS
SELECT u.id AS mentor_id, u.display_name, u.role, u.status,
       mp.specialty, COUNT(q.id) AS open_questions
FROM users u
LEFT JOIN mentor_profiles mp ON mp.user_id = u.id
LEFT JOIN questions q ON q.assigned_to = u.id AND q.status = 'open'
WHERE u.role IN ('mentor','head_admin')
GROUP BY u.id, u.display_name, u.role, u.status, mp.specialty;

-- Content page: every non-deleted item with author, counts and file info
CREATE VIEW v_content_overview AS
SELECT c.id, c.type, c.title, c.status, c.level, c.is_featured,
       c.author_id, u.display_name AS author_name,
       c.published_at, c.updated_at,
       COALESCE(f_v.original_name, f_b.original_name) AS file_name,
       COALESCE(f_v.size_bytes,    f_b.size_bytes)    AS file_size,
       (SELECT COUNT(*) FROM content_likes l WHERE l.content_id = c.id) AS like_count,
       (SELECT COUNT(*) FROM comments m WHERE m.content_id = c.id AND m.status = 'visible') AS comment_count
FROM content_items c
JOIN users u ON u.id = c.author_id
LEFT JOIN videos v ON v.content_id = c.id
LEFT JOIN files f_v ON f_v.id = v.file_id
LEFT JOIN books  b ON b.content_id = c.id
LEFT JOIN files f_b ON f_b.id = b.file_id
WHERE c.deleted_at IS NULL;

-- Events page: events with host name and "going" count
CREATE VIEW v_event_overview AS
SELECT e.id, e.title, e.kind, e.starts_at, e.ends_at, e.location, e.capacity,
       e.host_id, u.display_name AS host_name,
       (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id) AS going
FROM events e
JOIN users u ON u.id = e.host_id;

-- Overview page: the four stat cards in one row
CREATE VIEW v_admin_overview AS
SELECT
  (SELECT COUNT(*) FROM users WHERE role = 'member' AND status = 'active')            AS active_members,
  (SELECT COUNT(*) FROM questions WHERE status = 'open')                              AS open_questions,
  (SELECT COUNT(*) FROM content_items WHERE status = 'pending' AND deleted_at IS NULL) AS posts_to_approve,
  (SELECT COUNT(*) FROM flags WHERE status = 'open')                                  AS flagged_comments;

-- ---------------------------------------------------------------------
-- 12. STORED PROCEDURE: deactivate a mentor safely
--     Puts their open questions back in the unassigned queue and refuses
--     to deactivate the last active Head admin.
-- ---------------------------------------------------------------------
DELIMITER $$
CREATE PROCEDURE sp_deactivate_mentor(IN p_mentor_id BIGINT UNSIGNED)
BEGIN
  DECLARE v_role VARCHAR(20);
  DECLARE v_other_heads INT DEFAULT 0;

  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    RESIGNAL;
  END;

  SELECT role INTO v_role FROM users WHERE id = p_mentor_id;
  IF v_role IS NULL OR v_role = 'member' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Not a mentor account';
  END IF;

  IF v_role = 'head_admin' THEN
    SELECT COUNT(*) INTO v_other_heads FROM users
    WHERE role = 'head_admin' AND status = 'active' AND id <> p_mentor_id;
    IF v_other_heads = 0 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Cannot deactivate the last Head admin';
    END IF;
  END IF;

  START TRANSACTION;
  UPDATE users SET status = 'deactivated' WHERE id = p_mentor_id;
  UPDATE questions SET assigned_to = NULL, assigned_at = NULL
   WHERE assigned_to = p_mentor_id AND status = 'open';
  COMMIT;
END$$
DELIMITER ;

-- ---------------------------------------------------------------------
-- 13. SEED DATA
-- ---------------------------------------------------------------------
INSERT INTO club_settings (id, club_name, support_email, require_post_approval, allow_comments)
VALUES (1, 'Friends of Python', 'club@example.com', 1, 1);

INSERT INTO permissions (permission_key, description) VALUES
  ('questions.answer',    'Answer and assign questions'),
  ('content.edit',        'Approve, publish and edit content'),
  ('content.upload',      'Upload videos and books'),
  ('events.manage',       'Manage events'),
  ('moderation.review',   'Moderate comments'),
  ('content.delete',      'Delete content'),
  ('mentors.manage',      'Add or deactivate mentors'),
  ('mentors.roles',       'Change mentor roles'),
  ('announcements.send',  'Send announcements'),
  ('settings.manage',     'Change club settings'),
  ('members.manage',      'Suspend or reinstate members');

INSERT INTO role_permissions (role, permission_key)
SELECT 'head_admin', permission_key FROM permissions;

INSERT INTO role_permissions (role, permission_key) VALUES
  ('mentor', 'questions.answer'),
  ('mentor', 'content.edit'),
  ('mentor', 'content.upload'),
  ('mentor', 'events.manage'),
  ('mentor', 'moderation.review'),
  ('mentor', 'members.manage');

INSERT INTO topics (name, slug, sort_order) VALUES
  ('Python basics',      'python-basics',      1),
  ('Web development',    'web-development',    2),
  ('Data science',       'data-science',       3),
  ('Projects',           'projects',           4),
  ('Learning in public', 'learning-in-public', 5),
  ('Python tutorials',   'python-tutorials',   6),
  ('Project diaries',    'project-diaries',    7),
  ('Career stories',     'career-stories',     8),
  ('Community news',     'community-news',     9);

INSERT INTO achievements (code, title, description) VALUES
  ('streak_7',       '7 day streak',   'Learned on 7 days in a row'),
  ('bookworm',       'Bookworm',       'Read 3 books from the library'),
  ('great_question', 'Great question', 'Asked a question a mentor highlighted');

INSERT INTO learning_paths (title, slug, description, is_published) VALUES
  ('Python Foundations', 'python-foundations', 'A calm, structured path from your first script to real projects.', 1);

INSERT INTO path_modules (path_id, position, title, description)
SELECT p.id, m.position, m.title, m.description
FROM learning_paths p
JOIN (
  SELECT 1 AS position, 'Hello, Python' AS title, 'Install, run your first script, and get comfortable with the basics.' AS description
  UNION ALL SELECT 2, 'Variables & Data Types', 'Numbers, strings, lists, and how Python thinks about data.'
  UNION ALL SELECT 3, 'Functions & Scope',      'Write reusable code and understand where names live.'
  UNION ALL SELECT 4, 'Control Flow',            'If, for, while, and when to reach for each.'
  UNION ALL SELECT 5, 'Working with Files',      'Read, write, and organize information on disk.'
  UNION ALL SELECT 6, 'Errors & Debugging',      'Treat bugs as teachers, not failures.'
  UNION ALL SELECT 7, 'Mini Project',            'Build something small that solves a real problem for you.'
  UNION ALL SELECT 8, 'Next Steps',              'Web, data, automation. Choose your path forward.'
) m
WHERE p.slug = 'python-foundations';

-- First Head admin. Invites need an existing admin, so create this one by hand.
-- Generate the hash with bcrypt in Node, then uncomment and run:
--
-- INSERT INTO users (email, password_hash, display_name, username, role, status, email_verified_at)
-- VALUES ('you@example.com', '<PASTE_BCRYPT_HASH>', 'Your Name', 'yourname', 'head_admin', 'active', NOW());
-- INSERT INTO mentor_profiles (user_id, specialty) VALUES (LAST_INSERT_ID(), 'Club lead');
