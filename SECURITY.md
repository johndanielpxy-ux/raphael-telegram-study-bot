# Security and privacy

Run your own deployment with a new Telegram bot. This repository does not grant
access to the author's private bot, account, study decks or Cloudflare resources.

- Only the configured owner and one approved friend can study in private chats.
- `/id` returns the sender's ID without granting access. Groups cannot study.
- Telegram sends updates with a webhook secret. Keep it and the bot token private.
- Setup reads the token with hidden input and uploads secrets through Wrangler's
  secret mechanism. Do not put tokens in shell commands, Git, cards or screenshots.
- D1 stores cards, Telegram user IDs, review history, sessions and optional repair
  queues. Telegram and Cloudflare process messages and stored data; this is not
  end-to-end encrypted study storage. Do not import confidential material.
- `/clear` requires confirmation and resets only that user's study progress and
  repair queue. It does not delete Telegram messages, all retained update metadata,
  other users' data or private backups. Revocation also retains stored progress.
- Failed queued updates may retain their payloads for diagnosis. The once-a-minute
  timer retries pending work; it does not send reminders. Retries stop after three
  failures. A timeout can cause duplicate Telegram messages, but review commits
  are guarded against repeated callbacks.
- Store backups outside Git, restrict Cloudflare access and rotate a token through
  BotFather if exposed. Do not publish an exploit or secret in a public issue.

Report vulnerabilities privately through this repository's GitHub security
advisory feature if enabled. Otherwise ask for a private reporting channel without
including exploit details. This is a personal project, not a monitored service
with guaranteed support, capacity or availability.
