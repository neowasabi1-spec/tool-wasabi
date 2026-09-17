-- DO NOT RUN THIS in the SQL editor if the project is under load.
-- The previous version read cloned_data JSONB (full HTML). That detoasts
-- every landing snapshot and the editor connection times out.
--
-- The app no longer needs this function. Clone/Swipe lists metadata columns
-- only; HTML is read from page_html when a page is opened.
--
-- Leave this file as a no-op so it is safe if someone runs it anyway.

SELECT 1;
