-- Monitor free tier: a new account may hold 2 monitors (was 5, 20261106000200_monitor_schema.sql).
--
-- Only the column default changes, so the cap applies to accounts created from now on: every
-- signup gets it through private.handle_new_user (20261106000400), which inserts the profile
-- without a monitor_limit and so takes the column default. Existing profiles are deliberately left
-- untouched (no UPDATE): accounts created under the old cap keep the 5 they signed up with, and a
-- cap an owner set by hand stays as it is. The owner role stays unlimited whatever the column
-- holds (monitors_limit_per_user reads the role). The column comment names no number, so it stays.
-- MONITOR_FREE_LIMIT in src/config/monitor.ts quotes this default on the landing page.

alter table public.profiles alter column monitor_limit set default 2;
