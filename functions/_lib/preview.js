// Link-preview bots (WhatsApp, Telegram, Discord, ...) read Open Graph tags
// from the page they fetch and ignore the bytes of a raw video. For those bots
// only, a video URL answers with a tiny HTML page; everyone else gets the file.

const CRAWLERS = /WhatsApp|facebookexternalhit|Facebot|TelegramBot|Twitterbot|Discordbot|Slackbot|LinkedInBot|SkypeUriPreview|Pinterestbot|redditbot|Signal|Googlebot|bingbot/i;

export function isCrawler(request) {
    return CRAWLERS.test(request.headers.get('User-Agent') || '');
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function videoPreviewPage({ title, videoUrl, thumbUrl, videoType }) {
    const t = escapeHtml(title);
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${t}</title>
<meta property="og:type" content="video.other">
<meta property="og:title" content="${t}">
<meta property="og:image" content="${escapeHtml(thumbUrl)}">
<meta property="og:video" content="${escapeHtml(videoUrl)}">
<meta property="og:video:secure_url" content="${escapeHtml(videoUrl)}">
<meta property="og:video:type" content="${escapeHtml(videoType)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(thumbUrl)}">
<meta name="robots" content="noindex">
</head><body><video controls src="${escapeHtml(videoUrl)}" poster="${escapeHtml(thumbUrl)}"></video></body></html>`;
    return new Response(html, {
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache' },
    });
}
