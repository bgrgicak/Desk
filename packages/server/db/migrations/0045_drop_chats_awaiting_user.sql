-- `chats.awaiting_user` was a boolean meant to track "ball is in the user's
-- court" durably across chat opens. Nothing in production code ever flipped
-- it on — only tests did — so it was an inert column. Its semantics
-- (delivered minus replied) collapse cleanly into the tightened `unread`
-- flag (agent activity not yet engaged with), which is what the Tasks page
-- now reads for the "Needs input" bucket. Drop the column.
ALTER TABLE chats DROP COLUMN awaiting_user;
