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
| `LINK_SECRET` | output of `openssl rand -hex 32` | Optional but recommended: the secret that protects `/s/` expiry and password links. If unset the bot token is used instead. Set it before creating any such links; changing it later breaks existing `/s/` links (rotating the bot token no longer does). Must be at least 32 characters. |
| `ALLOW_HTML_RENDER` | `true` | Off by default. Lets uploaders tick "Open HTML files in the browser", which gives an HTML file a `/v/` link that shows a warning page and then the page itself in a sandbox. Read the security note first: you would be serving other people's web pages from your domain. |
| `UPLOAD_BASIC_USER` / `UPLOAD_BASIC_PASS` | | Set both to require Basic auth for uploads. |
| `LOG_UPLOADER_IP` | `true` | Adds the uploader's IP and country to each file's Telegram message. Off by default. |
| `ALLOWED_REFERERS` | `example.com,*.example.org` | Hostname allowlist for anti-hotlinking: stops other sites embedding your files. People opening a link directly (a page load) are never blocked, and neither are requests with no Referer. |

## How it works

- `/upload` sends the file to the Telegram channel and returns `/file/<file_id>.<ext>`.
- `/file/<file_id>.<ext>` streams it back from Telegram. Nothing is stored on the server.
- Uploads run two at a time (more would trip Telegram's per-chat message limit; if Telegram does rate limit, the worker answers `429` with `Retry-After` and the browser waits and retries with a countdown) and show in a stack in the bottom-right corner (bottom-center on phones): hover it, or tap it on touch screens, to see every file with its own progress bar and a cancel button. Finished links move to the history list, which keeps the last 100 and has a "Copy all" button.
- On Android (Chrome), install the site ("Install app" / "Add to Home screen") and TeleHost shows up in the share sheet: pick photos or files in any app, share to TeleHost, confirm, and they upload through the normal queue. A tiny service worker (`sw.js`) only handles that share and caches nothing else. iOS Safari does not support share targets.
- With `ALLOW_HTML_RENDER=true`, ticking "Open HTML files in the browser" (in Options) gives an HTML file a `/v/<id>.html` link. Visitors first see an "External Content Notice" page (logo, "hosted by a third party, not reviewed", Open the page / Go to homepage), then the page itself, served in a sandbox with no access to this site's data. Normal `/file/` links keep downloading HTML.
- Each history row has a ▾ menu to copy the link as Markdown, HTML or BBCode (image embeds for images, plain links otherwise).
- There is a hidden settings page at `/settings` (not linked anywhere): history size (0 = keep nothing, links last only for the session), link shortener (automatic, da.gd, tinyurl, none, or your own https service with a `{url}` placeholder) how many uploads run at once, and what the unlock page does after a file is unlocked (by default it downloads files and shows photos/video/audio instead). Stored in this browser only.
- Quality, link expiry and password live behind the "Options" link under the drop zone; a one-line summary shows when something non-default is set, and expiry and password reset after each successful batch.
- Pick "Link expires" before uploading to get a `/s/<id>` link instead. A small signed manifest stored in the channel holds the real file ids and the expiry; after it passes, the link returns 410 and the file's messages are deleted. Works for files of any size.
- Enter a password before uploading to protect a file. The browser encrypts it (AES-GCM, key from PBKDF2) so Telegram and the server only see ciphertext, and the link `/s/<id>` opens an unlock page that decrypts it in the browser. A lost password cannot be recovered. Works for files of any size and combines with expiry.
- Videos get link previews: the browser grabs a frame (Telegram's own thumbnail is the fallback) and the video URL becomes `/file/<video_id>~<thumbnail_id>.<ext>`. Only link-preview bots (WhatsApp, Telegram, Discord, ...) receive the small Open Graph page; browsers and players get the raw video from the same URL.
- Files over 19 MiB are split into chunks and reassembled by the `/join/<id>` page. Without an expiry or password, if an upload fails part-way, picking the same file again resumes: the browser remembers which parts already reached Telegram (for 7 days) and only sends the rest.
- With an expiry or password, big files are uploaded as parts that the server signs receipts for; `/finalize` turns them into one `/s/` link, and the unlock page downloads the parts one by one (checking the password on the first part, so a wrong one fails fast). Those uploads cannot resume yet.

## Limits

- Telegram bots can upload up to 50 MB per file and download up to 20 MB, which is why larger files are chunked.
- Cloudflare's free plan allows 100,000 Function requests per day.

## Development

```
npm install
npm start      # wrangler pages dev on :8080
npm test
```
