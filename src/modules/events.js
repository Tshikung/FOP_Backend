import { Router } from "express";
import { z } from "zod";
import { query, one, tx } from "../config/db.js";
import { validate, idParam } from "../middleware/validate.js";
import { requirePermission } from "../middleware/auth.js";
import { badRequest, conflict, notFound } from "../utils/httpError.js";
import { pageQuery, pg, finish } from "../utils/paging.js";
import { fanOut } from "../services/notify.js";
import { audit } from "../services/audit.js";

export const eventsRouter = Router(); // member side
export const adminEventsRouter = Router(); // mentor side, mounted at /admin/events

const whenQuery = z.object({ when: z.enum(["upcoming", "past", "all"]).default("upcoming"), ...pageQuery });
const whenSql = { upcoming: "e.starts_at >= UTC_TIMESTAMP()", past: "e.starts_at < UTC_TIMESTAMP()", all: "1 = 1" };

const EVENT_SELECT = `SELECT e.id, e.title, e.kind, e.description, e.starts_at, e.ends_at, e.location, e.capacity, e.host_id,
    u.display_name AS host_name,
    (SELECT COUNT(*) FROM event_rsvps r WHERE r.event_id = e.id) AS going,
    EXISTS(SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = ?) AS rsvped
  FROM events e JOIN users u ON u.id = e.host_id`;

async function listEvents(req, res) {
  const f = req.valid.query;
  const p = pg(f);
  const order = f.when === "past" ? "DESC" : "ASC";
  const rows = await query(`${EVENT_SELECT} WHERE ${whenSql[f.when]} ORDER BY e.starts_at ${order} LIMIT ? OFFSET ?`, [req.user.id, p.limit, p.offset]);
  res.json(finish(rows, p));
}

// ---- Member -------------------------------------------------------------------------------
eventsRouter.get("/events", validate({ query: whenQuery }), listEvents);

eventsRouter.post("/events/:id/rsvp", validate({ params: idParam }), async (req, res) => {
  await tx(async (t) => {
    const e = await t.one("SELECT id, capacity, starts_at FROM events WHERE id = ? FOR UPDATE", [req.valid.params.id]);
    if (!e) throw notFound("Event");
    if (new Date(e.starts_at) < new Date()) throw conflict("This event has already started");
    if (e.capacity) {
      const { n } = await t.one("SELECT COUNT(*) AS n FROM event_rsvps WHERE event_id = ?", [e.id]);
      const already = await t.one("SELECT 1 AS x FROM event_rsvps WHERE event_id = ? AND user_id = ?", [e.id, req.user.id]);
      if (!already && n >= e.capacity) throw conflict("This event is full");
    }
    await t.query("INSERT IGNORE INTO event_rsvps (event_id, user_id) VALUES (?, ?)", [e.id, req.user.id]);
  });
  res.json({ ok: true });
});

eventsRouter.delete("/events/:id/rsvp", validate({ params: idParam }), async (req, res) => {
  await query("DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?", [req.valid.params.id, req.user.id]);
  res.json({ ok: true });
});

// ---- Mentor portal ------------------------------------------------------------------------
const eventFields = z.object({
  title: z.string().trim().min(3).max(200),
  kind: z.enum(["workshop", "meetup", "qa"]),
  description: z.string().trim().max(2000).optional(),
  startsAt: z.coerce.date(), // send an ISO string, for example new Date("2026-10-30T18:00").toISOString()
  endsAt: z.coerce.date().optional(),
  hostId: z.number().int().positive(),
  location: z.string().trim().min(2).max(255),
  capacity: z.number().int().positive().nullable().optional(),
});

async function assertHost(hostId) {
  const host = await one("SELECT id FROM users WHERE id = ? AND role IN ('mentor', 'head_admin') AND status = 'active'", [hostId]);
  if (!host) throw badRequest("Choose an active mentor as the host");
}

adminEventsRouter.get("/", validate({ query: whenQuery.extend({ when: z.enum(["upcoming", "past", "all"]).default("all") }) }), listEvents);

adminEventsRouter.post(
  "/",
  requirePermission("events.manage"),
  validate({ body: eventFields.extend({ notifyMembers: z.boolean().default(false) }) }),
  async (req, res) => {
    const { notifyMembers, ...b } = req.valid.body;
    if (b.endsAt && b.endsAt <= b.startsAt) throw badRequest("The event must end after it starts");
    await assertHost(b.hostId);
    const id = await tx(async (t) => {
      const r = await t.query(
        "INSERT INTO events (title, kind, description, starts_at, ends_at, host_id, location, capacity, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [b.title, b.kind, b.description ?? null, b.startsAt, b.endsAt ?? null, b.hostId, b.location, b.capacity ?? null, req.user.id],
      );
      if (notifyMembers) {
        await fanOut(t.query, "all", { type: "event", title: `New event: ${b.title}`, body: b.location, refType: "event", refId: r.insertId });
      }
      await audit(req, "event.create", "event", r.insertId, { title: b.title }, t.query);
      return r.insertId;
    });
    res.status(201).json({ id });
  },
);

adminEventsRouter.patch("/:id", requirePermission("events.manage"), validate({ params: idParam, body: eventFields.partial() }), async (req, res) => {
  const b = req.valid.body;
  const current = await one("SELECT starts_at, ends_at FROM events WHERE id = ?", [req.valid.params.id]);
  if (!current) throw notFound("Event");
  const starts = b.startsAt ?? current.starts_at;
  const ends = b.endsAt ?? current.ends_at;
  if (ends && new Date(ends) <= new Date(starts)) throw badRequest("The event must end after it starts");
  if (b.hostId) await assertHost(b.hostId);
  const columns = { title: "title", kind: "kind", description: "description", startsAt: "starts_at", endsAt: "ends_at", hostId: "host_id", location: "location", capacity: "capacity" };
  const sets = [], vals = [];
  for (const [key, col] of Object.entries(columns)) if (b[key] !== undefined) { sets.push(`${col} = ?`); vals.push(b[key]); }
  if (sets.length) await query(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`, [...vals, req.valid.params.id]);
  await audit(req, "event.update", "event", req.valid.params.id);
  res.json({ ok: true });
});

adminEventsRouter.delete("/:id", requirePermission("events.manage"), validate({ params: idParam }), async (req, res) => {
  const r = await query("DELETE FROM events WHERE id = ?", [req.valid.params.id]);
  if (r.affectedRows === 0) throw notFound("Event");
  await audit(req, "event.delete", "event", req.valid.params.id);
  res.json({ ok: true });
});
