-- Fast competitor-library list: aggregate per-brand stats in one SQL pass
-- instead of downloading every competitor_ads row into the Node handler.

CREATE OR REPLACE FUNCTION public.competitor_library_brand_stats(p_project_id uuid)
RETURNS TABLE (
  brand_id bigint,
  ads_count bigint,
  video_count bigint,
  image_count bigint,
  new_count bigint,
  preview_paths text[],
  preview_types text[]
)
LANGUAGE sql
STABLE
AS $$
  WITH brands AS (
    SELECT id, coalesce(last_viewed_at, '-infinity'::timestamptz) AS last_viewed_at
    FROM competitor_brands
    WHERE project_id = p_project_id
  ),
  ranked AS (
    SELECT
      a.brand_id,
      a.media_type,
      a.file_path,
      a.created_at,
      row_number() OVER (
        PARTITION BY a.brand_id
        ORDER BY a.created_at DESC NULLS LAST
      ) AS rn
    FROM competitor_ads a
    WHERE a.project_id = p_project_id
      AND coalesce(a.file_path, '') <> ''
  ),
  previews AS (
    SELECT
      brand_id,
      array_agg(file_path ORDER BY rn) FILTER (WHERE rn <= 4) AS preview_paths,
      array_agg(media_type ORDER BY rn) FILTER (WHERE rn <= 4) AS preview_types
    FROM ranked
    GROUP BY brand_id
  ),
  counts AS (
    SELECT
      a.brand_id,
      count(*)::bigint AS ads_count,
      count(*) FILTER (WHERE a.media_type = 'video')::bigint AS video_count,
      count(*) FILTER (WHERE a.media_type IS DISTINCT FROM 'video')::bigint AS image_count,
      count(*) FILTER (
        WHERE a.created_at > b.last_viewed_at
      )::bigint AS new_count
    FROM competitor_ads a
    JOIN brands b ON b.id = a.brand_id
    WHERE a.project_id = p_project_id
    GROUP BY a.brand_id
  )
  SELECT
    c.brand_id,
    c.ads_count,
    c.video_count,
    c.image_count,
    c.new_count,
    coalesce(p.preview_paths, '{}'::text[]),
    coalesce(p.preview_types, '{}'::text[])
  FROM counts c
  LEFT JOIN previews p ON p.brand_id = c.brand_id;
$$;

-- Helps the GROUP BY / window above (project-scoped scans).
CREATE INDEX IF NOT EXISTS idx_competitor_ads_project_created
  ON competitor_ads (project_id, created_at DESC);

NOTIFY pgrst, 'reload schema';
