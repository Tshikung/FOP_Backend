-- Needed by the API's login sessions. Only run this if you imported an older copy of the schema.
USE friends_of_python_club;
ALTER TABLE auth_tokens
  MODIFY purpose ENUM('invite','password_reset','email_verify','refresh') NOT NULL;
