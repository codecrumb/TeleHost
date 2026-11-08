# TeleHost

Free file hosting on Cloudflare Pages, using a Telegram channel as storage. No KV, no database, no build step: fork it, connect the repo to Cloudflare Pages, set two environment variables, done.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Create a Telegram channel and add the bot as an administrator.
3. Get the channel's chat ID (for example via [@GetTheirIDBot](https://t.me/GetTheirIDBot)).
4. Fork this repo and deploy it with Cloudflare Pages (`Create project` -> `Connect to Git`; no build command).
5. Set the environment variables below, then redeploy.

| Variable | Example | Description |
|---|---|---|
| `TG_Bot_Token` | `123468:AAxxxGKrn5` | Bot token from BotFather (required). |
| `TG_Chat_ID` | `-1001234567` | Channel the bot uploads to (required). |
| `UPLOAD_BASIC_USER` / `UPLOAD_BASIC_PASS` | | Set both to require Basic auth for uploads. |
| `LOG_UPLOADER_IP` | `true` | Adds the uploader's IP and country to each file's Telegram message. Off by default. |
| `ALLOWED_REFERERS` | `example.com,*.example.org` | Hostname allowlist for anti-hotlinking. Empty referers always pass. |

## How it works

- `/upload` sends the file to the Telegram channel and returns `/file/<file_id>.<ext>`.
- `/file/<file_id>.<ext>` streams it back from Telegram. Nothing is stored on the server.
- Pick "Link expires" before uploading to get a `/s/<id>.<ext>` link instead. A small signed manifest stored in the channel holds the real file id and the expiry; after it passes, the link returns 410 and the file's message is deleted. Limited to files up to 19 MiB for now.
- Files over 19 MiB are split into chunks and reassembled by the `/join/<id>` page.

## Limits

- Telegram bots can upload up to 50 MB per file and download up to 20 MB, which is why larger files are chunked.
- Cloudflare's free plan allows 100,000 Function requests per day.

## Development

```
npm install
npm start      # wrangler pages dev on :8080
npm test
```
