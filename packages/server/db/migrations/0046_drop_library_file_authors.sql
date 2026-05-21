-- 0046_drop_library_file_authors.sql — Remove the library-file authorship
-- feature. The table was added in 0020 (and extended in 0021) to track which
-- agent last touched each library file, but no production code ever wrote
-- to it, so the table was permanently empty and the read-side queries on
-- the GET /library hot path produced empty Maps. Dropping it removes the
-- dead code path entirely.

DROP TABLE IF EXISTS library_file_authors;
