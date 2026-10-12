# Friends of Python: API

One Node.js + Express 5 API for **both** portals (member portal and mentor portal), on the
`friends_of_python_club` MySQL database.

```
Member portal (:5173) ──┐
                        ├──►  this API (:4000, /api/v1)  ──►  MySQL  +  uploads/
Mentor portal (:5174) ──┘
```

## Quick start

```bash
# 1. Database (MySQL 8+). Creates friends_of_python_club with all tables, views and seed data
mysql -u root -p < db/schema.sql

# 2. A MySQL user for the app (never connect as root)
mysql -u root -p -e "CREATE USER 'club_app'@'localhost' IDENTIFIED BY 'choose-a-password';
                     GRANT ALL ON friends_of_python_club.* TO 'club_app'@'localhost';"

# 3. Configure
cp .env.example .env        # fill in DB_PASSWORD and JWT_SECRET (32+ random characters)

# 4. Install, create the first Head admin, run
npm install
npm run create-admin -- you@example.com "Your Name" "a-strong-password"
npm run dev                 # http://localhost:4000/api/v1/health
```

Already imported an older copy of the schema? Run `db/migrations/001_*.sql` and `002_*.sql` once.

## Tests

```bash
mysql -u root -p -e "CREATE USER 'club_test'@'localhost' IDENTIFIED BY 'club_test_pw';
                     GRANT ALL ON friends_of_python_club_test.* TO 'club_test'@'localhost';"
sed 's/friends_of_python_club/friends_of_python_club_test/g' db/schema.sql | mysql -u root -p
npm test        # 28 integration tests against the throwaway database (.env.test)
```

## How it is organised

```
src/
  server.js  app.js            start-up, middleware, route mounting
  config/                      env.js (validated with zod), db.js (pool + tx helper), logger.js
  middleware/                  auth (authenticate, requireStaff, requirePermission), validate,
                               upload (multer + file-content check), rateLimit, errorHandler
  services/                    permissions, tokens, session, mailer, notify (+fan-out), audit, progress
  modules/                     one file per feature (SQL, validation and routes together)
  routes/index.js              member routes; everything after /auth needs a signed-in user
  routes/admin.js              mentor routes, behind requireStaff, each with its own permission
```

## Conventions

* **JSON is camelCase** (`displayName`); the database is snake_case. Conversion is automatic.
* **Lists** return `{ items, page, limit, hasMore }`. Use `?page=2&limit=20` (limit max 50).
* **Actions** (like, delete, publish...) return `{ ok: true }`.
* **Errors** return `{ error: { code, message, fields? } }` with the right status
  (400 validation, 401 sign in, 403 permission, 404, 409 duplicate/full, 413 too large).
  `error.message` is safe to show to the user; `error.fields` maps field name to messages.
* **Times** are UTC ISO strings. Send event times as `new Date("2026-10-30T18:00").toISOString()`.

## Auth model

* Login sets two httpOnly cookies: an access token (15 min) and a refresh token (14 days, stored
  hashed and rotated on every use). Call `POST /auth/refresh` when a request returns 401 `token_expired`.
* **Each portal has its own session.** The API looks at the request's `Origin` header
  (`MENTOR_PORTAL_URL` means mentor, anything else means member), so you can be a member in one tab
  and a mentor in another. Send requests with `credentials: "include"`.
* The user is re-read from the database on **every** request: suspending a member or deactivating a
  mentor signs them out instantly, and role changes apply immediately.
* Permissions come from the `role_permissions` table. `GET /me` returns `permissions: [...]` so the
  mentor portal can hide buttons the server would refuse anyway.
* Mentor invite: Head admin `POST /admin/mentors` &rarr; email link
  `MENTOR_PORTAL_URL/accept-invite?token=...` &rarr; the page calls `GET /auth/invite/:token`
  (to show the name) then `POST /auth/accept-invite { token, password }`.
  Without SMTP configured, emails are printed in the server log, and the invite response includes
  `devInviteLink` (never in production).
* Production across different domains: cookies are `SameSite=Lax`. Keep the API and both portals under one
  registrable domain (`api.club.org`, `app.club.org`, `mentors.club.org`).

## Endpoints

### Auth (public) and profile
| | |
|---|---|
| `POST /auth/register` `/login` `/refresh` `/logout` | sessions |
| `POST /auth/forgot-password` `/reset-password` | `{ email }` / `{ token, password }` |
| `GET /auth/invite/:token`, `POST /auth/accept-invite` | mentor invites |
| `GET /me`, `PATCH /me`, `POST /me/avatar`, `POST /me/password` | own profile (avatar is multipart field `avatar`) |
| `GET /users/:username`, `POST/DELETE /users/:id/follow` | public profiles |

### Member portal
| Area | Endpoints |
|---|---|
| Home | `GET /dashboard`, `GET /learn/path`, `POST /learn/modules/:id/complete` |
| Library | `GET /videos` `/books` `/blogs` (`?level&topic&tag&q`), `GET .../:id`, `GET /reading-lists/current` |
| Watching/reading | `POST /videos/:id/progress {seconds,percent}`, `POST /books/:id/progress {page}`, `GET /content/:id/file` (secure stream) |
| Blogs | `POST /blogs`, `PATCH /blogs/:id`, `DELETE /blogs/:id`, `GET /me/blogs` |
| Reactions | `POST/DELETE /content/:id/like`, `/content/:id/bookmark`, `GET /me/bookmarks` |
| Comments | `GET/POST /content/:id/comments`, `POST/DELETE /comments/:id/like`, `POST /comments/:id/flag` |
| Ask a Mentor | `POST /questions` (multipart: `title, body, topicId, level, attachments` up to 3), `GET /me/questions`, `GET /questions/:id`, `POST /questions/:id/replies` |
| Events | `GET /events?when=upcoming\|past`, `POST/DELETE /events/:id/rsvp` |
| Notifications | `GET /notifications?unread=1`, `GET /notifications/unread-count`, `PATCH /notifications/:id/read`, `POST /notifications/read-all` |
| Other | `GET /search?q=`, `GET /settings/public`, `GET /files/:id` |

### Mentor portal (`/admin/...`, mentors and Head admins only)
| Area | Endpoints | Permission |
|---|---|---|
| Overview | `GET /admin/overview` | any staff |
| Questions | `GET /admin/questions?status=open\|mine\|unassigned\|answered\|all`, `GET /counts`, `GET /:id` | any staff |
| | `PATCH /:id/assign {assignedTo\|null}`, `POST /:id/replies {body}` | `questions.answer` |
| Members | `GET /admin/members?q&status` | any staff |
| | `PATCH /admin/members/:id/status {status: active\|suspended}` | `members.manage` |
| Mentors | `GET /admin/mentors` | any staff |
| | `POST /admin/mentors {name,email,specialty}`, `POST /:id/resend-invite`, `POST /:id/deactivate`, `POST /:id/reactivate` | `mentors.manage` |
| | `PATCH /admin/mentors/:id/role {role}` | `mentors.roles` |
| Content | `GET /admin/content?type&status&q`, `GET /:id`, `GET /deleted` (Head admin) | any staff |
| | `POST /admin/content/video` and `/book` (multipart, field `file`), `PUT /:id/file` | `content.upload` |
| | `POST /admin/content/blog`, `PATCH /:id`, `POST /:id/publish` `/approve` `/unpublish` `/reject {note}` | `content.edit` |
| | `DELETE /:id` (soft), `POST /:id/restore` | `content.delete` |
| Events | `GET /admin/events`, `POST`, `PATCH /:id`, `DELETE /:id` | `events.manage` |
| Announcements | `GET /admin/announcements` (any staff), `POST {title,body,audience}` | `announcements.send` |
| Moderation | `GET /admin/flags`, `POST /admin/flags/:commentId/keep` `/remove` | `moderation.review` |
| Settings | `GET /admin/settings` (any staff), `PATCH` | `settings.manage` |
| Roles table | `GET /admin/permissions` | any staff |

Announcement audiences: `all`, `beginners`, `intermediate_up`, `mentors`.
Content levels: `beginner`, `intermediate`, `project`, `all_levels`. Event kinds: `workshop`, `meetup`, `qa`.

## Connecting the frontends

Create `src/api.ts` in each portal and replace the `seed*` arrays with calls to it:

```ts
const API = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api/v1";

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const isForm = init.body instanceof FormData;
  const res = await fetch(API + path, {
    credentials: "include",
    ...init,
    headers: isForm ? init.headers : { "Content-Type": "application/json", ...init.headers },
  });
  if (res.status === 401 && retry && !path.startsWith("/auth/")) {
    const r = await fetch(API + "/auth/refresh", { method: "POST", credentials: "include" });
    if (r.ok) return api<T>(path, init, false);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error?.message ?? "Something went wrong"), data.error);
  return data as T;
}
```

Mentor portal checklist: real sign-in (reject `role === "member"`), take the signed-in mentor from `GET /me`
instead of `ME_ID`, hide buttons using `me.permissions`, and add the three pages the API expects:
accept-invite, forgot-password and reset-password.

## Production checklist

* `NODE_ENV=production`, HTTPS, strong `JWT_SECRET`, a least-privilege MySQL user, real SMTP settings.
* Run behind a reverse proxy (nginx, Caddy); `trust proxy` is already enabled in production.
* Back up the database daily (`mysqldump`) and the `uploads/` folder. Consider S3-compatible storage later.
* Large videos: nginx `client_max_body_size 520m;` and a generous proxy timeout for uploads.

## Known limits (intentional, for a first version)

* Email verification and "Sign in with Google" are not built (the columns exist).
* Video duration comes from the upload form (`durationSeconds`); nothing inspects the file.
* Reading lists are read-only through the API (create them in SQL for now).
* Blog bodies are stored as sanitized HTML (links, lists, code, headings, quotes only).
* Lists use `hasMore` paging, not total counts.
