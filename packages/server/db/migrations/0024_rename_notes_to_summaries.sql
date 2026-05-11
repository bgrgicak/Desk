-- Rename the chat-summary content/kind terminology from note/ai_note to
-- summary/summary_request. The filesystem mirror intentionally remains under
-- `.chats/<chatId>/notes/`.
UPDATE messages
SET content = json_set(content, '$.type', 'summary')
WHERE json_extract(content, '$.type') = 'note';

UPDATE messages
SET content = json_set(content, '$.type', 'summary_request')
WHERE json_extract(content, '$.type') = 'ai_note_request';

UPDATE messages
SET kind = 'summary'
WHERE kind = 'ai_note';
