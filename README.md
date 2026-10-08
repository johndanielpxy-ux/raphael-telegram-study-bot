# Raphael

**Short, spaced-repetition study sessions inside Telegram.** Built by John Phua
for memory practice on long commutes, without opening another study app.

Choose a subject and subtopic, try to recall the answer, reveal it, then rate your
recall. Raphael uses [FSRS](https://github.com/open-spaced-repetition/ts-fsrs) to
schedule normal reviews. It is inspired by Anki's review workflow, not an Anki
client or a sync integration.

This is a **self-hosting starter**, not a public invitation to the author's bot.
Deploy your own Telegram bot and bring your own cards. The MIT-licensed release
includes 10 clearly labelled synthetic demo cards, not NUS course materials.

## What you can do

- Review by subject, subtopic or mixed review within one subject.
- Pick a 5- or 10-card commute goal; normal sessions prioritise due cards.
- Use **Again** for forgotten/incorrect answers, **Hard** for correct but difficult
  recall, **Good** for correct recall with normal effort and **Easy** for effortless
  correct recall. Reveal first; these are self-ratings, not automatic grading.
- Use **Endless Gauntlet** for extra practice, including future-due cards, without
  changing the review schedule. `/stop` ends it.
- Save **Practise This Later** cards to a private `/repair` queue for desk practice.
- Track participation with XP and a weekly study-day goal. All ratings earn the
  same XP: 10 per card per day, capped at 200 per day. XP does not measure mastery.
- Approve one friend, with separate progress, schedules, XP and repair queues.
- Reset your own test progress with `/clear` and an explicit confirmation.

No generative-AI API, paid model subscription, automatic card writing, answer
grading, Anki deck import or proactive reminders are required or implemented.

## Run your own bot

You need Node.js 22+, npm, a Cloudflare account and a **new** Telegram bot from
[@BotFather](https://t.me/BotFather). Setup takes place in your terminal and browser;
never share passwords or tokens in chats, screenshots or GitHub issues.

### 1. Get the code and check it locally

```sh
git clone https://github.com/johndanielpxy-ux/raphael-telegram-study-bot.git
cd raphael-telegram-study-bot
npm ci --ignore-scripts
npm run typecheck
npm test
```

Tests create local Miniflare D1 databases and substitute Telegram network calls.
`npm test` first builds the Worker with a **dry run**; it does not deploy a bot.
Dependencies are locked. The emulator currently uses a Miniflare alpha version;
this is a personal prototype, not a production availability guarantee.
The public copy pins the emulator's transitive `sharp` dependency to 0.35.5 for
[GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).
This development-tool patch is not part of the deployed Worker's runtime bundle.

### 2. Create your own Cloudflare resources

```sh
npx wrangler login
npx wrangler d1 create raphael-cards
```

Complete the browser login yourself. In `wrangler.jsonc`, replace the all-zero
`database_id` with the ID returned by the create command. Keep the `DB` binding
and migration directory. The example Worker name is `raphael-study-bot`; change
it if you already use that name in your account. Do not reuse an existing live
bot's database or apply these migrations to one.

```sh
npx wrangler d1 migrations apply raphael-cards --remote
npm run deploy
```

Approve the migration prompt for your **new** database. Save the returned
`https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev` URL. `/health` only checks that
the Worker responds; it does not prove storage or Telegram delivery works.
The webhook is unavailable until the secrets have been configured.

### 3. Load the demo cards

```sh
npm run import:cards -- cards/demo.json --out exports/demo.generated.sql
npx wrangler d1 execute raphael-cards --remote --file exports/demo.generated.sql
```

The generator validates content and refuses to overwrite an output file. For
another import, use a new output filename. SQL exports are ignored by Git.

### 4. Connect Telegram securely

In Telegram, use the official `@BotFather` to create a new bot with `/newbot`.
Keep the token private, then run:

```sh
npm run telegram:setup
```

The script accepts the token with hidden input, asks you to send `/start` to your
bot, identifies your private sender ID, and asks you to confirm that ID and your
deployed Worker URL. On confirmation it uploads `BOT_TOKEN`, `OWNER_ID` and a
random `WEBHOOK_SECRET` using Wrangler's secret mechanism, then registers the
webhook. It does not save credentials in this project or pass them as shell
arguments. It refuses to overwrite an existing webhook. A partial failure may
have uploaded some secrets: inspect the failure and rerun for the same new bot.

Send `/start`, then `/study`. Pick **Bot basics**, pick **Recall**, try answering,
reveal, and rate. Check `/progress`, stop, and resume another session. Test all
four ratings before relying on your deployment. Registration is not the same
as verified end-to-end delivery.

## Bring your own study cards

Create a JSON array in a **private file outside this repository**, then use the
same import commands with that file. Each card needs a stable ID, subject,
subtopic, question, answer and source:

```json
[
  {
    "id": "my-topic-001",
    "subject": "Your subject",
    "subtopic": "Your topic",
    "question": "One focused retrieval question?",
    "answer": "A short, checked answer with any important qualification.",
    "source": "Your authorised source and page or section",
    "learning_order": 0
  }
]
```

Lower `learning_order` values put **new** warm-up cards before harder ones; due
reviews still take priority. IDs allow letters, numbers, hyphens and underscores
(1-80 characters). Maximum lengths: question 3,000, answer 20,000, source 2,000,
subject 100, subtopic 200. The importer supports up to 10,000 cards, not a claim
of tested hosted capacity at that scale.

Importing the same IDs edits content without resetting progress. Omitted IDs
are not deleted. Back up your database before changing a deck with real users.
Import only content you may use; do not commit lecturer slides, purchased notes,
personal data or confidential files to a public fork. Review source accuracy
yourself: the bot cannot verify that an answer is correct.

## Commands and sharing

| Command | Purpose |
| --- | --- |
| `/start`, `/help` | Introduction and rating guide |
| `/study` | Subject picker, topics, mixed review and gauntlet |
| `/repair` | Optional private desk-practice queue |
| `/progress`, `/status` | Participation and card availability |
| `/goal 4` | Target 1-7 study days per week |
| `/stop` | End the current session without rating the unfinished card |
| `/clear` | Confirmed reset of your own study progress and queue |
| `/id` | Show your ID without granting access |
| `/allow ID`, `/access`, `/revoke ID` | Owner-only approval of one friend |

A friend sends `/id` and privately sends you the result. Approve them from your
own bot chat with `/allow THEIR_ID`. Only the owner and one approved friend can
study in private chats. This is not a classroom-scale multi-user service.
Revocation stops their sessions but retains their stored progress. `/clear`
does not delete Telegram messages, other users' data or every retained metadata
record. See [security and privacy](SECURITY.md).

## Architecture and limits

Telegram webhook -> Cloudflare Worker -> D1 queue -> private card review.
`ts-fsrs` handles scheduling; D1 stores cards and per-user state. A once-a-minute
recovery timer drains pending updates, not scheduled reminders. Sessions and
callbacks are checked for user, message and position, and database transactions
guard repeated rating taps.

FSRS uses default parameters with fuzz disabled, not personalised training.
Activity days use **Asia/Singapore**; edit the relevant date handling if you need
another timezone. Costs and quotas depend on your Cloudflare plan and usage:
inspect current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), plus your
hosted CPU metrics. Local timing does not establish free-tier compliance.

Telegram/Cloudflare outages can delay replies. Retries stop after three failures;
send a fresh `/study` command to resume the saved session. A timeout after a
successful send can produce duplicate messages. This release is tested locally,
not independently deployed as a second live bot or guaranteed foolproof.

## Development and contributions

```sh
npm run typecheck
npm test
npm run benchmark
```

CI runs typecheck and local runtime/tests without Cloudflare or Telegram secrets.
The synthetic stress deck exercises 396 cards across 20 topics; it is not the
author's private law deck. The benchmark measures only the local FSRS adapter.
For changes, include focused tests and reproduce issues with synthetic cards,
redacted logs and dummy IDs. Never include tokens or private study decks.

Code, documentation and original synthetic demos: [MIT](LICENSE). Dependencies
retain their own licences. Source references:
[Telegram Bot API](https://core.telegram.org/bots/api),
[Cloudflare D1](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs).
