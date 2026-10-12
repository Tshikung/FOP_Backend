-- Adds the permission for suspending / reinstating members. Only run this if you imported an older copy of the schema.
USE friends_of_python_club;
INSERT IGNORE INTO permissions (permission_key, description) VALUES ('members.manage', 'Suspend or reinstate members');
INSERT IGNORE INTO role_permissions (role, permission_key) VALUES ('head_admin', 'members.manage'), ('mentor', 'members.manage');
