-- Esquema de PeopleHub Fund · fase 1 (sin blockchain). Idempotente: se ejecuta en cada arranque.
--
-- Los importes se guardan en céntimos de crédito (1 crédito = 100). Los créditos son unidades
-- internas a precio unitario: no se compran ni se canjean por dinero. En la fase 2 se tokenizarán
-- (ver contracts/).

CREATE SCHEMA IF NOT EXISTS fund;

CREATE TABLE IF NOT EXISTS fund.users (
  id             text PRIMARY KEY,               -- "sub" de Keycloak (o 'platform' para la cuenta de la plataforma)
  name           text NOT NULL,
  email          text,
  wallet_address text,                           -- fase 2 (blockchain); sin uso en la fase 1
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fund.users ADD COLUMN IF NOT EXISTS balance_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE fund.users ADD COLUMN IF NOT EXISTS welcome_granted boolean NOT NULL DEFAULT false;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_balance_nonnegative') THEN
    ALTER TABLE fund.users ADD CONSTRAINT users_balance_nonnegative CHECK (balance_cents >= 0 OR id = 'platform');
  END IF;
END $$;

-- Cuenta de la plataforma: recibe las comisiones (2 % y 5 %).
INSERT INTO fund.users (id, name) VALUES ('platform', 'PeopleHub (plataforma)') ON CONFLICT (id) DO NOTHING;

-- Proyectos de la fábrica: una idea que busca financiación y un desarrollador.
CREATE TABLE IF NOT EXISTS fund.projects (
  id                bigserial PRIMARY KEY,
  creator_id        text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  summary           text NOT NULL CHECK (char_length(summary) BETWEEN 10 AND 280),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 8000),
  goal              integer NOT NULL CHECK (goal BETWEEN 1000 AND 100000),          -- créditos
  price_cents       bigint NOT NULL CHECK (price_cents >= 1),                        -- precio de acceso a la app
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'rejected', 'funding', 'active', 'failed')),
  admin_note        text,
  funding_ends_at   timestamptz,
  raised            integer NOT NULL DEFAULT 0,                                       -- créditos aportados en financiación
  total_stake_cents bigint NOT NULL DEFAULT 0,
  dev_fund_cents    bigint NOT NULL DEFAULT 0,                                        -- pendiente de pagar al desarrollador
  -- Desarrollador (único)
  dev_period_days   integer NOT NULL CHECK (dev_period_days BETWEEN 7 AND 365),
  dev_mode          text NOT NULL CHECK (dev_mode IN ('assigned', 'open')),
  dev_status        text NOT NULL DEFAULT 'none'
                    CHECK (dev_status IN ('none', 'invited', 'candidacy', 'selected', 'active', 'finished', 'declined')),
  developer_id      text REFERENCES fund.users(id) ON DELETE SET NULL,
  invited_email     text,
  candidacy_days    integer CHECK (candidacy_days BETWEEN 1 AND 30),
  votes_required    integer CHECK (votes_required BETWEEN 1 AND 100),
  candidacy_ends_at timestamptz,
  dev_started_at    timestamptz,
  dev_ends_at       timestamptz,
  -- Votación semanal de precio
  vote_week         integer NOT NULL DEFAULT 0,
  vote_weighted_sum bigint NOT NULL DEFAULT 0,
  vote_total_weight bigint NOT NULL DEFAULT 0,
  app_url           text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  activated_at      timestamptz
);

CREATE INDEX IF NOT EXISTS projects_status_idx ON fund.projects (status, created_at DESC);
CREATE INDEX IF NOT EXISTS projects_creator_idx ON fund.projects (creator_id);
CREATE INDEX IF NOT EXISTS projects_developer_idx ON fund.projects (developer_id);

-- Participación de cada usuario en cada proyecto.
CREATE TABLE IF NOT EXISTS fund.stakes (
  project_id     bigint NOT NULL REFERENCES fund.projects(id) ON DELETE CASCADE,
  user_id        text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  stake_cents    bigint NOT NULL DEFAULT 0 CHECK (stake_cents >= 0),
  funding_cents  bigint NOT NULL DEFAULT 0 CHECK (funding_cents >= 0),  -- aportado en financiación (para reembolsos)
  invested_cents bigint NOT NULL DEFAULT 0,                              -- total aportado
  earned_cents   bigint NOT NULL DEFAULT 0,                              -- total recibido en repartos
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS stakes_user_idx ON fund.stakes (user_id);

-- Candidaturas a desarrollador y sus votos (1 voto por usuario y proyecto; cuesta 1 crédito).
CREATE TABLE IF NOT EXISTS fund.candidates (
  project_id bigint NOT NULL REFERENCES fund.projects(id) ON DELETE CASCADE,
  user_id    text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  pitch      text NOT NULL CHECK (char_length(pitch) BETWEEN 10 AND 1000),
  votes      integer NOT NULL DEFAULT 0,
  round      integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id, round)
);

CREATE TABLE IF NOT EXISTS fund.candidate_votes (
  project_id   bigint NOT NULL REFERENCES fund.projects(id) ON DELETE CASCADE,
  round        integer NOT NULL DEFAULT 1,
  voter_id     text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  candidate_id text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, round, voter_id)
);

ALTER TABLE fund.projects ADD COLUMN IF NOT EXISTS dev_round integer NOT NULL DEFAULT 1;

-- Acceso comprado a las apps.
CREATE TABLE IF NOT EXISTS fund.access (
  project_id  bigint NOT NULL REFERENCES fund.projects(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  price_cents bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Votos semanales de precio.
CREATE TABLE IF NOT EXISTS fund.price_votes (
  project_id bigint NOT NULL REFERENCES fund.projects(id) ON DELETE CASCADE,
  week       integer NOT NULL,
  user_id    text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  percent    integer NOT NULL CHECK (percent IN (50, 30, 10, 0, -10, -30, -50)),
  weight     bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, week, user_id)
);

-- Historial de precios aplicados.
CREATE TABLE IF NOT EXISTS fund.price_history (
  project_id  bigint NOT NULL REFERENCES fund.projects(id) ON DELETE CASCADE,
  week        integer NOT NULL,
  avg_bps     integer NOT NULL,     -- media ponderada en puntos básicos (1500 = +15 %)
  price_cents bigint NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, week)
);

-- Libro de movimientos: cada cambio de saldo deja una línea.
CREATE TABLE IF NOT EXISTS fund.ledger (
  id           bigserial PRIMARY KEY,
  user_id      text NOT NULL REFERENCES fund.users(id) ON DELETE CASCADE,
  project_id   bigint REFERENCES fund.projects(id) ON DELETE SET NULL,
  amount_cents bigint NOT NULL,
  kind         text NOT NULL,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_user_idx ON fund.ledger (user_id, created_at DESC);

-- Ranking de desarrolladores (ELO, base 1500).
CREATE TABLE IF NOT EXISTS fund.developer_ratings (
  user_id    text PRIMARY KEY REFERENCES fund.users(id) ON DELETE CASCADE,
  rating     double precision NOT NULL DEFAULT 1500,
  wins       integer NOT NULL DEFAULT 0,
  losses     integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS fund.session (
  sid    varchar NOT NULL PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON fund.session (expire);
