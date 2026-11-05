-- EUM AI SOFTWARE FACTORY PRO — 초기 스키마
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text NOT NULL,
  name text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','member','viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members (user_id);

CREATE TABLE desktop_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  platform text,
  engine_version text,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline')),
  paused boolean NOT NULL DEFAULT false,
  max_concurrency int NOT NULL DEFAULT 1,
  system_info jsonb NOT NULL DEFAULT '{}',
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX desktop_agents_org_idx ON desktop_agents (organization_id);

CREATE TABLE agent_pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES desktop_agents(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('web','pc','android','api','integrated')),
  platforms text[] NOT NULL DEFAULT '{}',
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  automation_mode text NOT NULL DEFAULT 'semi' CHECK (automation_mode IN ('manual','semi','auto')),
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','awaiting_approval','review','completed','failed','cancelled')),
  max_fix_attempts int NOT NULL DEFAULT 3,
  reference_urls text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_org_idx ON projects (organization_id, created_at DESC);

CREATE TABLE project_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type text NOT NULL DEFAULT 'text',
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_requirements_project_idx ON project_requirements (project_id);

CREATE TABLE project_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename text NOT NULL,
  mime text,
  size bigint NOT NULL DEFAULT 0,
  sha256 text,
  storage_key text NOT NULL,
  parsed_text text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_files_project_idx ON project_files (project_id);

CREATE TABLE project_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version int NOT NULL,
  kind text NOT NULL,
  content jsonb NOT NULL DEFAULT '{}',
  git_commit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, version)
);

CREATE TABLE ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES desktop_agents(id) ON DELETE CASCADE,
  key text NOT NULL,
  display_name text NOT NULL,
  installed boolean NOT NULL DEFAULT false,
  authenticated boolean NOT NULL DEFAULT false,
  version text,
  execution_policy jsonb NOT NULL DEFAULT '{}',
  usage_status jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, key)
);

CREATE TABLE ai_provider_capabilities (
  provider_id uuid NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  capability text NOT NULL,
  supported boolean NOT NULL DEFAULT false,
  PRIMARY KEY (provider_id, capability)
);

CREATE TABLE ai_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role text NOT NULL,
  provider_key text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, role)
);

CREATE TABLE ai_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq int NOT NULL,
  key text NOT NULL,
  title text NOT NULL,
  role text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ai','verify','package')),
  provider_key text,
  prompt text,
  spec jsonb NOT NULL DEFAULT '{}',
  priority int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'blocked'
    CHECK (status IN ('blocked','awaiting_approval','queued','running','succeeded','failed','cancelled')),
  max_attempts int NOT NULL DEFAULT 3,
  attempt_count int NOT NULL DEFAULT 0,
  timeout_sec int NOT NULL DEFAULT 3600,
  lease_agent_id uuid REFERENCES desktop_agents(id) ON DELETE SET NULL,
  lease_expires_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  superseded_by uuid REFERENCES ai_tasks(id) ON DELETE SET NULL,
  result jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (project_id, key)
);
CREATE INDEX ai_tasks_project_idx ON ai_tasks (project_id, seq);
CREATE INDEX ai_tasks_queue_idx ON ai_tasks (status, priority DESC, created_at) WHERE status = 'queued';
CREATE INDEX ai_tasks_lease_idx ON ai_tasks (lease_expires_at) WHERE status = 'running';

CREATE TABLE ai_task_dependencies (
  task_id uuid NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE TABLE ai_task_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  attempt_no int NOT NULL,
  agent_id uuid REFERENCES desktop_agents(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','succeeded','failed','cancelled','lost')),
  exit_code int,
  error text,
  git_before text,
  git_after text,
  changed_files jsonb NOT NULL DEFAULT '[]',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (task_id, attempt_no)
);

CREATE TABLE ai_execution_events (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  attempt_no int NOT NULL,
  seq int NOT NULL,
  type text NOT NULL,
  message text NOT NULL DEFAULT '',
  data jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_no, seq)
);
CREATE INDEX ai_execution_events_project_idx ON ai_execution_events (project_id, id);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES ai_tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('task','final','deploy','risky_command')),
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz
);
CREATE INDEX approvals_project_idx ON approvals (project_id, status);

CREATE TABLE git_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES desktop_agents(id) ON DELETE SET NULL,
  local_path text,
  default_branch text NOT NULL DEFAULT 'main',
  head_commit text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE git_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id uuid NOT NULL REFERENCES git_repositories(id) ON DELETE CASCADE,
  name text NOT NULL,
  head_commit text,
  task_id uuid REFERENCES ai_tasks(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repository_id, name)
);

CREATE TABLE test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
  attempt_no int NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed','unverified')),
  git_commit text,
  summary jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_no)
);

CREATE TABLE test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_run_id uuid NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
  ord int NOT NULL,
  category text NOT NULL,
  name text NOT NULL,
  command text NOT NULL,
  cwd text NOT NULL DEFAULT '.',
  exit_code int,
  status text NOT NULL CHECK (status IN ('passed','failed','skipped')),
  duration_ms int NOT NULL DEFAULT 0,
  log_tail text NOT NULL DEFAULT ''
);
CREATE INDEX test_results_run_idx ON test_results (test_run_id, ord);

CREATE TABLE build_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES ai_tasks(id) ON DELETE SET NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  git_commit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE build_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_job_id uuid NOT NULL REFERENCES build_jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id uuid REFERENCES ai_tasks(id) ON DELETE SET NULL,
  kind text NOT NULL,
  filename text NOT NULL,
  size bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  git_commit text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, sha256)
);
CREATE INDEX build_artifacts_project_idx ON build_artifacts (project_id, created_at DESC);

CREATE TABLE deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_id uuid REFERENCES build_artifacts(id) ON DELETE SET NULL,
  approval_id uuid REFERENCES approvals(id) ON DELETE SET NULL,
  target text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_org_idx ON notifications (organization_id, created_at DESC);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  organization_id uuid,
  user_id uuid,
  agent_id uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_idx ON audit_logs (organization_id, id DESC);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES
  ('metered_api_enabled', 'false'),
  ('default_max_fix_attempts', '3');
