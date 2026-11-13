-- 기획 결과를 여러 AI 세션으로 분할할지 (기본: 한 세션에서 전체 구현 — 한도·속도·일관성 측면에서 유리)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS split_tasks boolean NOT NULL DEFAULT false;
