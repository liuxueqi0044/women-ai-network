-- WLD-01 durable discovery projection and owner-bound bookmarks.
-- The projection is only a recall accelerator. Every read joins the current
-- letters/publications/revision/account rows before returning a candidate.
-- +BEGIN UP
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS world_discovery;

CREATE TABLE world_discovery.discovery_index (
  publication_id uuid PRIMARY KEY REFERENCES letters.publications(id) ON DELETE CASCADE,
  letter_id uuid NOT NULL REFERENCES letters.letters(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES letters.letter_revisions(id) ON DELETE CASCADE,
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  locale text NOT NULL CHECK (locale ~ '^[a-z]{2,8}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$' AND length(locale) BETWEEN 2 AND 32),
  topics text[] NOT NULL CHECK (
    cardinality(topics) BETWEEN 1 AND 4
    AND topics <@ ARRAY['life_story','family','relationships','migration','values_beliefs','work','friendship','culture','education','language_learning','professional','travel','nature','wellbeing','technology']::text[]
    AND (cardinality(topics) = 1
      OR (cardinality(topics) = 2 AND topics[1] <> topics[2])
      OR (cardinality(topics) = 3 AND topics[1] <> topics[2] AND topics[1] <> topics[3] AND topics[2] <> topics[3])
      OR (cardinality(topics) = 4 AND topics[1] <> topics[2] AND topics[1] <> topics[3] AND topics[1] <> topics[4] AND topics[2] <> topics[3] AND topics[2] <> topics[4] AND topics[3] <> topics[4]))
  ),
  search_text text NOT NULL CHECK (length(search_text) <= 25000),
  search_vector tsvector NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_discovery_index_filter_idx ON world_discovery.discovery_index(country_code,locale);
CREATE INDEX world_discovery_index_topics_idx ON world_discovery.discovery_index USING gin(topics);
CREATE INDEX world_discovery_index_fts_idx ON world_discovery.discovery_index USING gin(search_vector);
CREATE INDEX world_discovery_index_trgm_idx ON world_discovery.discovery_index USING gin(search_text gin_trgm_ops);
CREATE INDEX world_discovery_index_letter_idx ON world_discovery.discovery_index(letter_id,revision_id,source_hash);

CREATE TABLE world_discovery.bookmarks (
  viewer_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL REFERENCES letters.publications(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(viewer_id, publication_id)
);
CREATE INDEX world_discovery_bookmarks_cursor_idx ON world_discovery.bookmarks(viewer_id,created_at DESC,publication_id DESC);
CREATE TABLE world_discovery.bookmark_idempotency (
  viewer_id uuid NOT NULL REFERENCES iam.accounts(id) ON DELETE CASCADE,
  key_digest text NOT NULL CHECK (key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  result_json jsonb NOT NULL CHECK (jsonb_typeof(result_json) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(viewer_id,key_digest)
);

CREATE OR REPLACE FUNCTION world_discovery.index_publication() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p jsonb := NEW.projection_json;
  title text := COALESCE(p->>'title','');
  body text := COALESCE((SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(COALESCE(p->'body'->'paragraphs','[]'::jsonb))), '');
  topics text[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p->'topics','[]'::jsonb)));
BEGIN
  -- Private drafts/publications never enter the discovery accelerator. The
  -- current publication join remains the final authorization gate on reads.
  IF NOT EXISTS (
    SELECT 1 FROM letters.letters l
    WHERE l.id = NEW.letter_id AND l.kind = 'public_letter' AND l.state = 'published'
  ) THEN
    RETURN NEW;
  END IF;
  INSERT INTO world_discovery.discovery_index(publication_id,letter_id,revision_id,source_hash,country_code,locale,topics,search_text,search_vector,indexed_at)
  VALUES (NEW.id,NEW.letter_id,NEW.revision_id,NEW.source_hash,p->>'country_code',p->>'locale',topics,left(title || ' ' || body,25000),to_tsvector('simple',left(title || ' ' || body,25000)),NEW.published_at)
  ON CONFLICT (publication_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,source_hash=EXCLUDED.source_hash,country_code=EXCLUDED.country_code,locale=EXCLUDED.locale,topics=EXCLUDED.topics,search_text=EXCLUDED.search_text,search_vector=EXCLUDED.search_vector,indexed_at=EXCLUDED.indexed_at;
  RETURN NEW;
END;
$$;
CREATE TRIGGER world_discovery_publication_index AFTER INSERT ON letters.publications FOR EACH ROW EXECUTE FUNCTION world_discovery.index_publication();

CREATE TABLE world_discovery.audit_events (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN ('index_refreshed','bookmark_created','bookmark_removed')),
  viewer_id uuid REFERENCES iam.accounts(id) ON DELETE SET NULL,
  publication_id uuid REFERENCES letters.publications(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- +END UP
-- +BEGIN DOWN
DROP TABLE IF EXISTS world_discovery.audit_events;
DROP TRIGGER IF EXISTS world_discovery_publication_index ON letters.publications;
DROP FUNCTION IF EXISTS world_discovery.index_publication();
DROP TABLE IF EXISTS world_discovery.bookmarks;
DROP TABLE IF EXISTS world_discovery.bookmark_idempotency;
DROP TABLE IF EXISTS world_discovery.discovery_index;
DROP SCHEMA IF EXISTS world_discovery;
-- +END DOWN
