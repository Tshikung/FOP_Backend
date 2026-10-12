/** The only user fields that ever leave the API. password_hash is never included. */
export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  display_name: u.display_name,
  username: u.username,
  avatar_url: u.avatar_url,
  role: u.role,
  status: u.status,
  experience_level: u.experience_level,
});
