ALTER TABLE "tenant_settings" ADD COLUMN "model_provider" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "ollama_model" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "anthropic_api_key_encrypted" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "openai_api_key_encrypted" text;