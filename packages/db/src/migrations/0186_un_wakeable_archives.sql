CREATE TABLE IF NOT EXISTS "un_wakeable_archives" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    "company_id" uuid NOT NULL REFERENCES companies(id),
    "issue_id" uuid NOT NULL REFERENCES issues(id),
    "policy" text NOT NULL,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "un_wakeable_archives_company_policy_idx"
    ON "un_wakeable_archives" ("company_id", "policy");

CREATE INDEX IF NOT EXISTS "un_wakeable_archives_company_issue_idx"
    ON "un_wakeable_archives" ("company_id", "issue_id");
