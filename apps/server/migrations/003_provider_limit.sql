-- PC 별 AI 도구의 구독 사용량 한도 재개 시각
ALTER TABLE ai_providers ADD COLUMN IF NOT EXISTS limited_until timestamptz;
