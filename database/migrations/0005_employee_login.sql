-- Keep legacy identities and business data; old accounts retain their login name.
ALTER TABLE users ADD COLUMN username text;
UPDATE users SET username = email;
ALTER TABLE users ALTER COLUMN username SET NOT NULL;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_username_key UNIQUE (username);
ALTER TABLE users ADD CONSTRAINT users_username_check CHECK (
  username = lower(btrim(username)) AND length(username) BETWEEN 1 AND 254
  AND username !~ '[[:space:]]'
);
-- Email authentication is retired; outstanding codes must no longer authenticate.
TRUNCATE auth_codes;
