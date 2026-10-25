-- Esquema de PeopleHub Fund. Idempotente: se ejecuta en cada arranque.
-- Aquí solo viven los datos que no están en la blockchain: usuarios, propuestas,
-- textos de los proyectos y la agenda de desarrollo. Tokens, inversiones y votos
-- viven en los contratos.

CREATE SCHEMA IF NOT EXISTS fund;

CREATE TABLE IF NOT EXISTS fund.users (
  id             text PRIMARY KEY,               -- "sub" de Keycloak
  name           text NOT NULL,
  email          text,
  wallet_address text,                           -- dirección pública vinculada (0x…)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fund.proposals (
  id                bigserial PRIMARY KEY,
  user_id           text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  summary           text NOT NULL CHECK (char_length(summary) BETWEEN 10 AND 280),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 8000),
  goal_tokens       integer NOT NULL CHECK (goal_tokens BETWEEN 1000 AND 100000),
  initial_price     numeric(20, 2) NOT NULL CHECK (initial_price >= 0.01),
  publisher_address text NOT NULL CHECK (publisher_address ~ '^0x[0-9a-fA-F]{40}$'),
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'published')),
  admin_note        text,
  onchain_id        integer UNIQUE,
  create_tx         text,
  development_date  date,
  app_url           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz
);

CREATE INDEX IF NOT EXISTS proposals_status_idx ON fund.proposals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS proposals_user_idx ON fund.proposals (user_id);

CREATE TABLE IF NOT EXISTS fund.session (
  sid    varchar NOT NULL PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON fund.session (expire);
