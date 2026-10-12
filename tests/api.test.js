import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import fs from "node:fs/promises";
import { createApp } from "../src/app.js";
import { loadPermissions } from "../src/services/permissions.js";
import { query, pool } from "../src/config/db.js";
import { outbox } from "../src/services/mailer.js";
import { env } from "../src/config/env.js";

// Runs against a throwaway database: friends_of_python_club_test (see README)
const app = createApp();
const tag = Date.now().toString(36);
const PW = "correct-horse-1";
const API = "/api/v1";
const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmp42"), Buffer.alloc(64)]);

let head, mentorA, memberA, memberB; // { id, email }
let headAgent, mentorAgent, memberAgent, memberBAgent;

async function makeUser(role, name, level = "new") {
  const email = `${role}.${name}.${tag}@test.dev`;
  const hash = await bcrypt.hash(PW, 4);
  const r = await query(
    "INSERT INTO users (email, password_hash, display_name, role, status, experience_level) VALUES (?, ?, ?, ?, 'active', ?)",
    [email, hash, `${name} ${tag}`, role, level],
  );
  if (role !== "member") await query("INSERT INTO mentor_profiles (user_id, specialty) VALUES (?, 'Testing')", [r.insertId]);
  return { id: r.insertId, email };
}

async function login(user) {
  const agent = request.agent(app);
  const res = await agent.post(`${API}/auth/login`).send({ email: user.email, password: PW });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  await loadPermissions();
  head = await makeUser("head_admin", "head");
  mentorA = await makeUser("mentor", "mentorA");
  memberA = await makeUser("member", "memberA", "new");
  memberB = await makeUser("member", "memberB", "experienced");
  [headAgent, mentorAgent, memberAgent, memberBAgent] = await Promise.all([login(head), login(mentorA), login(memberA), login(memberB)]);
});

afterAll(async () => {
  await fs.rm(env.UPLOAD_DIR, { recursive: true, force: true });
  await pool.end();
});

describe("auth and access control", () => {
  it("health check works", async () => {
    expect((await request(app).get(`${API}/health`)).body.ok).toBe(true);
  });

  it("registers a member, signs in, and never leaks the password hash", async () => {
    const agent = request.agent(app);
    const email = `new.${tag}@test.dev`;
    const reg = await agent.post(`${API}/auth/register`).send({ email, password: PW, displayName: "New Person" });
    expect(reg.status).toBe(201);
    expect(reg.body.user.passwordHash).toBeUndefined();
    const me = await agent.get(`${API}/me`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
    expect(me.body.role).toBe("member");
    expect((await agent.post(`${API}/auth/register`).send({ email, password: PW, displayName: "Again" })).status).toBe(409);
  });

  it("rejects bad credentials and unauthenticated requests", async () => {
    expect((await request(app).post(`${API}/auth/login`).send({ email: memberA.email, password: "wrong-password" })).status).toBe(401);
    expect((await request(app).get(`${API}/me`)).status).toBe(401);
    expect((await request(app).get(`${API}/videos`)).status).toBe(401);
  });

  it("keeps the member and mentor portal sessions separate", async () => {
    const origin = env.MENTOR_PORTAL_URL;
    const agent = request.agent(app);
    await agent.post(`${API}/auth/login`).set("Origin", origin).send({ email: head.email, password: PW }).expect(200);
    expect((await agent.get(`${API}/me`).set("Origin", origin)).status).toBe(200);
    expect((await agent.get(`${API}/me`)).status).toBe(401); // the member portal has no session
  });

  it("refreshes a session and signs out", async () => {
    const agent = await login(memberB);
    expect((await agent.post(`${API}/auth/refresh`)).status).toBe(200);
    await agent.post(`${API}/auth/logout`).expect(200);
    expect((await agent.post(`${API}/auth/refresh`)).status).toBe(401);
  });

  it("blocks members from the mentor API", async () => {
    expect((await memberAgent.get(`${API}/admin/overview`)).status).toBe(403);
    expect((await memberAgent.get(`${API}/admin/questions`)).status).toBe(403);
  });

  it("returns permissions with /me so the mentor portal can hide buttons", async () => {
    const mentor = (await mentorAgent.get(`${API}/me`)).body.permissions;
    expect(mentor).toContain("questions.answer");
    expect(mentor).not.toContain("content.delete");
    expect((await headAgent.get(`${API}/me`)).body.permissions).toContain("content.delete");
    const roles = await headAgent.get(`${API}/admin/permissions`);
    expect(roles.body.items.length).toBeGreaterThanOrEqual(10);
  });
});

describe("mentor invites and roles", () => {
  let invitedId;

  it("lets a Head admin invite a mentor, who sets a password from the emailed link", async () => {
    const email = `invited.${tag}@test.dev`;
    const res = await headAgent.post(`${API}/admin/mentors`).send({ name: "Invited Mentor", email, specialty: "Web" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("invited");
    invitedId = res.body.id;

    const mail = outbox.at(-1);
    expect(mail.to).toBe(email);
    const token = mail.text.match(/token=([\w-]+)/)[1];

    expect((await request(app).get(`${API}/auth/invite/${token}`)).body.email).toBe(email);
    const agent = request.agent(app);
    const accept = await agent.post(`${API}/auth/accept-invite`).send({ token, password: PW });
    expect(accept.status).toBe(200);
    expect(accept.body.user.role).toBe("mentor");
    expect((await agent.get(`${API}/admin/overview`)).status).toBe(200);
    expect((await agent.post(`${API}/auth/accept-invite`).send({ token, password: PW })).status).toBe(400); // used up
  });

  it("stops regular mentors from head-admin actions", async () => {
    expect((await mentorAgent.post(`${API}/admin/mentors`).send({ name: "X Y", email: `x.${tag}@test.dev` })).status).toBe(403);
    expect((await mentorAgent.patch(`${API}/admin/settings`).send({ clubName: "Hacked" })).status).toBe(403);
    expect((await mentorAgent.post(`${API}/admin/announcements`).send({ title: "Hi there", body: "Hello all" })).status).toBe(403);
    expect((await mentorAgent.patch(`${API}/admin/mentors/${invitedId}/role`).send({ role: "head_admin" })).status).toBe(403);
  });

  it("lets a Head admin change settings and roles, but not their own role", async () => {
    const s = await headAgent.patch(`${API}/admin/settings`).send({ requirePostApproval: true, allowComments: true });
    expect(s.status).toBe(200);
    expect(s.body.requirePostApproval).toBe(true);
    expect((await headAgent.patch(`${API}/admin/mentors/${invitedId}/role`).send({ role: "head_admin" })).status).toBe(200);
    expect((await headAgent.patch(`${API}/admin/mentors/${invitedId}/role`).send({ role: "mentor" })).status).toBe(200);
    expect((await headAgent.patch(`${API}/admin/mentors/${head.id}/role`).send({ role: "mentor" })).status).toBe(400);
  });
});

describe("ask a mentor", () => {
  let qid;

  it("lets a member ask and a mentor see it in the unassigned queue", async () => {
    const res = await memberAgent.post(`${API}/questions`).send({ title: "How do I validate input?", body: "My CLI crashes when I type a letter.", level: "beginner" });
    expect(res.status).toBe(201);
    qid = res.body.id;
    const list = await mentorAgent.get(`${API}/admin/questions?status=unassigned`);
    expect(list.body.items.some((q) => q.id === qid)).toBe(true);
    expect((await mentorAgent.get(`${API}/admin/questions/counts`)).body.unassigned).toBeGreaterThanOrEqual(1);
  });

  it("assigns to an active mentor only, and notifies them", async () => {
    expect((await headAgent.patch(`${API}/admin/questions/${qid}/assign`).send({ assignedTo: memberA.id })).status).toBe(400);
    expect((await headAgent.patch(`${API}/admin/questions/${qid}/assign`).send({ assignedTo: mentorA.id })).status).toBe(200);
    const notes = await mentorAgent.get(`${API}/notifications`);
    expect(notes.body.items.some((n) => n.type === "questionAssigned" || n.type === "question_assigned")).toBe(true);
    const mine = await mentorAgent.get(`${API}/admin/questions?status=mine`);
    expect(mine.body.items.some((q) => q.id === qid)).toBe(true);
  });

  it("marks it answered when the mentor replies and notifies the member", async () => {
    expect((await mentorAgent.post(`${API}/admin/questions/${qid}/replies`).send({ body: "Wrap it in a small helper function." })).status).toBe(201);
    const mine = await memberAgent.get(`${API}/me/questions`);
    expect(mine.body.items.find((q) => q.id === qid).status).toBe("answered");
    const detail = await memberAgent.get(`${API}/questions/${qid}`);
    expect(detail.body.replies).toHaveLength(1);
    const notes = await memberAgent.get(`${API}/notifications?unread=1`);
    expect(notes.body.items.some((n) => /replied/.test(n.title))).toBe(true);
    // another member cannot read it
    expect((await memberBAgent.get(`${API}/questions/${qid}`)).status).toBe(404);
  });

  it("returns a question to the queue when its mentor is deactivated, and protects the last Head admin", async () => {
    const q2 = (await memberAgent.post(`${API}/questions`).send({ title: "Second question here", body: "Another thing I am stuck on." })).body.id;
    await headAgent.patch(`${API}/admin/questions/${q2}/assign`).send({ assignedTo: mentorA.id }).expect(200);
    await headAgent.post(`${API}/admin/mentors/${mentorA.id}/deactivate`).expect(200);
    expect((await headAgent.get(`${API}/admin/questions/${q2}`)).body.assignedTo).toBeNull();
    expect((await mentorAgent.get(`${API}/me`)).status).toBe(401); // deactivated mentors are signed out immediately
    await headAgent.post(`${API}/admin/mentors/${mentorA.id}/reactivate`).expect(200);
    expect((await headAgent.post(`${API}/admin/mentors/${head.id}/deactivate`)).status).toBe(400);
    mentorAgent = await login(mentorA);
  });
});

describe("content, uploads and publishing", () => {
  let videoId;

  it("accepts a real video, keeps it as a draft, and hides it from members", async () => {
    const res = await mentorAgent.post(`${API}/admin/content/video`).field("title", "Python Functions").field("level", "beginner").attach("file", fakeMp4, "lesson.mp4");
    expect(res.status).toBe(201);
    videoId = res.body.id;
    expect(res.body.status).toBe("draft");
    expect((await memberAgent.get(`${API}/videos`)).body.items.some((v) => v.id === videoId)).toBe(false);
    expect((await memberAgent.get(`${API}/videos/${videoId}`)).status).toBe(404);
  });

  it("rejects files whose contents do not match their type", async () => {
    const bad = await mentorAgent.post(`${API}/admin/content/video`).field("title", "Not a video").attach("file", Buffer.from("just some text, not a video"), "fake.mp4");
    expect(bad.status).toBe(400);
    const wrongExt = await mentorAgent.post(`${API}/admin/content/video`).field("title", "Wrong type").attach("file", fakeMp4, "malware.exe");
    expect(wrongExt.status).toBe(400);
    expect((await mentorAgent.post(`${API}/admin/content/video`).field("title", "No file here")).status).toBe(400);
  });

  it("publishes, then members can list, like, bookmark, watch and stream it", async () => {
    expect((await mentorAgent.post(`${API}/admin/content/${videoId}/publish`)).status).toBe(200);
    const list = await memberAgent.get(`${API}/videos?level=beginner`);
    expect(list.body.items.find((v) => v.id === videoId).title).toBe("Python Functions");
    await memberAgent.post(`${API}/content/${videoId}/like`).expect(200);
    await memberAgent.post(`${API}/content/${videoId}/bookmark`).expect(200);
    const detail = (await memberAgent.get(`${API}/videos/${videoId}`)).body;
    expect(detail.likeCount).toBe(1);
    expect(detail.liked).toBe(true);
    expect(detail.bookmarked).toBe(true);
    expect((await memberAgent.get(`${API}/me/bookmarks`)).body.items).toHaveLength(1);
    await memberAgent.post(`${API}/videos/${videoId}/progress`).send({ seconds: 600, percent: 40 }).expect(200);
    expect((await memberAgent.get(`${API}/dashboard`)).body.continueWatching[0].id).toBe(videoId);
    const stream = await memberAgent.get(`${API}/content/${videoId}/file`).set("Range", "bytes=0-9");
    expect(stream.status).toBe(206);
  });

  it("lets mentors edit and replace the file, but only a Head admin delete or restore", async () => {
    expect((await mentorAgent.patch(`${API}/admin/content/${videoId}`).send({ title: "Python Functions, Clearly Explained", isFeatured: true })).status).toBe(200);
    expect((await mentorAgent.put(`${API}/admin/content/${videoId}/file`).attach("file", fakeMp4, "better.mp4")).status).toBe(200);
    const detail = (await mentorAgent.get(`${API}/admin/content/${videoId}`)).body;
    expect(detail.title).toBe("Python Functions, Clearly Explained");
    expect(detail.fileName).toBe("better.mp4");
    expect((await mentorAgent.delete(`${API}/admin/content/${videoId}`)).status).toBe(403);
    expect((await headAgent.delete(`${API}/admin/content/${videoId}`)).status).toBe(200);
    expect((await memberAgent.get(`${API}/videos`)).body.items.some((v) => v.id === videoId)).toBe(false);
    expect((await headAgent.post(`${API}/admin/content/${videoId}/restore`)).status).toBe(200);
    expect((await memberAgent.get(`${API}/videos`)).body.items.some((v) => v.id === videoId)).toBe(true);
  });

  it("sends member blogs through approval", async () => {
    const res = await memberAgent.post(`${API}/blogs`).send({ title: "My first week with Python", body: "<p>I learned about lists and loops this week and it was fun.</p><script>alert(1)</script>", tags: ["Learning", "Beginner"] });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    const id = res.body.id;
    expect((await memberBAgent.get(`${API}/blogs`)).body.items.some((b) => b.id === id)).toBe(false);
    expect((await mentorAgent.get(`${API}/admin/content?status=pending`)).body.items.some((c) => c.id === id)).toBe(true);
    await mentorAgent.post(`${API}/admin/content/${id}/approve`).expect(200);
    const blog = (await memberBAgent.get(`${API}/blogs/${id}`)).body;
    expect(blog.tags).toEqual(["Beginner", "Learning"]);
    expect(blog.body).not.toContain("script");
    expect((await memberAgent.get(`${API}/notifications`)).body.items.some((n) => /now live/.test(n.title))).toBe(true);
  });
});

describe("events, announcements and moderation", () => {
  it("manages events with RSVPs and capacity", async () => {
    const startsAt = new Date(Date.now() + 7 * 864e5).toISOString();
    const ev = await mentorAgent.post(`${API}/admin/events`).send({ title: "Build a web scraper", kind: "workshop", startsAt, hostId: mentorA.id, location: "Online", capacity: 1 });
    expect(ev.status).toBe(201);
    const id = ev.body.id;
    expect((await memberAgent.post(`${API}/events/${id}/rsvp`)).status).toBe(200);
    expect((await memberBAgent.post(`${API}/events/${id}/rsvp`)).status).toBe(409); // full
    const list = (await memberAgent.get(`${API}/events`)).body.items.find((e) => e.id === id);
    expect(list.going).toBe(1);
    expect(list.rsvped).toBe(true);
    expect((await mentorAgent.post(`${API}/admin/events`).send({ title: "Bad dates", kind: "meetup", startsAt, endsAt: new Date(Date.now()).toISOString(), hostId: mentorA.id, location: "Lab" })).status).toBe(400);
    expect((await memberAgent.post(`${API}/admin/events`).send({})).status).toBe(403);
  });

  it("sends announcements to the right audience", async () => {
    const res = await headAgent.post(`${API}/admin/announcements`).send({ title: "Workshop schedule is live", body: "Check the Events page.", audience: "beginners" });
    expect(res.status).toBe(201);
    expect(res.body.recipients).toBeGreaterThanOrEqual(1);
    expect((await memberAgent.get(`${API}/notifications`)).body.items.some((n) => n.title === "Workshop schedule is live")).toBe(true); // beginner
    expect((await memberBAgent.get(`${API}/notifications`)).body.items.some((n) => n.title === "Workshop schedule is live")).toBe(false); // experienced
    expect((await mentorAgent.get(`${API}/admin/announcements`)).body.items.length).toBeGreaterThanOrEqual(1);
  });

  it("handles comments, reports and removal", async () => {
    const video = (await memberAgent.get(`${API}/videos`)).body.items[0].id;
    const c = await memberAgent.post(`${API}/content/${video}/comments`).send({ body: "This is spam spam spam" });
    expect(c.status).toBe(201);
    expect((await memberAgent.post(`${API}/comments/${c.body.id}/flag`).send({ reason: "spam" })).status).toBe(400); // own comment
    expect((await memberBAgent.post(`${API}/comments/${c.body.id}/flag`).send({ reason: "spam" })).status).toBe(201);
    expect((await memberBAgent.post(`${API}/comments/${c.body.id}/flag`).send({ reason: "spam" })).status).toBe(409); // already reported
    const flags = await mentorAgent.get(`${API}/admin/flags`);
    expect(flags.body.items.find((f) => f.commentId === c.body.id).reasons).toEqual(["spam"]);
    expect((await mentorAgent.post(`${API}/admin/flags/${c.body.id}/remove`)).status).toBe(200);
    const after = await memberBAgent.get(`${API}/content/${video}/comments`);
    expect(after.body.items.some((x) => x.id === c.body.id)).toBe(false);
    expect((await mentorAgent.get(`${API}/admin/flags`)).body.items.some((f) => f.commentId === c.body.id)).toBe(false);
  });

  it("closes comments when the setting is off", async () => {
    await headAgent.patch(`${API}/admin/settings`).send({ allowComments: false }).expect(200);
    const video = (await memberAgent.get(`${API}/videos`)).body.items[0].id;
    expect((await memberAgent.post(`${API}/content/${video}/comments`).send({ body: "Hello" })).status).toBe(403);
    await headAgent.patch(`${API}/admin/settings`).send({ allowComments: true }).expect(200);
  });

  it("suspends a member instantly and shows the overview numbers", async () => {
    expect((await mentorAgent.get(`${API}/admin/members?q=memberB`)).body.items.length).toBe(1);
    await mentorAgent.patch(`${API}/admin/members/${memberB.id}/status`).send({ status: "suspended" }).expect(200);
    expect((await memberBAgent.get(`${API}/me`)).status).toBe(401);
    expect((await request(app).post(`${API}/auth/login`).send({ email: memberB.email, password: PW })).status).toBe(403);
    await mentorAgent.patch(`${API}/admin/members/${memberB.id}/status`).send({ status: "active" }).expect(200);
    const o = (await mentorAgent.get(`${API}/admin/overview`)).body;
    expect(o.weeklyActivity).toHaveLength(7);
    expect(o.activeMembers).toBeGreaterThanOrEqual(1);
  });
});

describe("learning, profile and search", () => {
  it("tracks the learning path and awards XP", async () => {
    const path = (await memberAgent.get(`${API}/learn/path`)).body.path;
    expect(path.modules).toHaveLength(8);
    const done = await memberAgent.post(`${API}/learn/modules/${path.modules[0].id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.path.percent).toBe(13);
    expect(done.body.path.nextModule.position).toBe(2);
    const dash = (await memberAgent.get(`${API}/dashboard`)).body;
    expect(dash.xp).toBeGreaterThanOrEqual(20);
    expect(dash.streak).toBeGreaterThanOrEqual(1);
  });

  it("edits the profile and shows it to other members without the email", async () => {
    const username = `user_${tag}`;
    const res = await memberAgent.patch(`${API}/me`).send({ username, bio: "Learning Python", skills: ["Flask", "SQL"] });
    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual(["Flask", "SQL"]);
    const other = await headAgent.get(`${API}/users/${username}`);
    expect(other.status).toBe(200);
    expect(other.body.email).toBeUndefined();
    expect((await memberBAgent.patch(`${API}/me`).send({ username })).status).toBe(409);
  });

  it("searches lessons and people", async () => {
    const r = await memberAgent.get(`${API}/search?q=Python`);
    expect(r.status).toBe(200);
    expect(r.body.videos.length).toBeGreaterThanOrEqual(1);
    expect((await memberAgent.get(`${API}/search?q=a`)).status).toBe(400);
  });

  it("validates input with helpful messages", async () => {
    const r = await request(app).post(`${API}/auth/register`).send({ email: "not-an-email", password: "short", displayName: "X" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("validation_error");
    expect(r.body.error.fields.password).toBeDefined();
  });
});

describe("public stats, directory and file types", () => {
  it("serves home page numbers without signing in", async () => {
    const res = await request(app).get(`${API}/public/stats`);
    expect(res.status).toBe(200);
    expect(res.body.mentors).toBeGreaterThanOrEqual(2);
    expect(res.body.lessons).toBeGreaterThanOrEqual(1);
    expect(res.body.members).toBeGreaterThanOrEqual(1);
  });

  it("lists mentors and topics for signed-in members only", async () => {
    expect((await request(app).get(`${API}/mentors`)).status).toBe(401);
    const mentors = await memberAgent.get(`${API}/mentors`);
    expect(mentors.body.items.some((m) => m.id === head.id)).toBe(true);
    const topics = await memberAgent.get(`${API}/topics`);
    expect(topics.body.items.map((t) => t.slug)).toContain("python-basics");
  });

  it("tells the portals what kind of file a lesson has, and allows framing it", async () => {
    const video = (await memberAgent.get(`${API}/videos`)).body.items[0];
    expect(video.fileMime).toBe("video/mp4");
    expect(video.lastPage).toBeNull();
    const file = await memberAgent.get(`${API}/content/${video.id}/file`);
    expect(file.headers["content-security-policy"]).toContain("frame-ancestors");
    expect(file.headers["x-frame-options"]).toBeUndefined();
  });
});
