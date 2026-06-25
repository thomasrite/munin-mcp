ALTER TABLE "generation_feedback" ALTER COLUMN "model_draft" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_feedback" ALTER COLUMN "human_final" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_feedback" ADD COLUMN "content_scrubbed_at" timestamp with time zone;