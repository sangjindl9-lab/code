-- 구독 사용량 한도 도달 시 재개 예정 시각 (이 시각 전에는 claim 되지 않음)
ALTER TABLE ai_tasks ADD COLUMN IF NOT EXISTS not_before timestamptz;
