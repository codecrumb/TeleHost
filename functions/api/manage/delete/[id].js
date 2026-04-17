// Destructive endpoint — restricted to POST/DELETE to prevent cross-site
// requests (e.g. <img>, <link rel=prefetch>) from mutating state.
export async function onRequest(context) {
  const { request, env, params } = context;

  if (request.method !== "POST" && request.method !== "DELETE") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { "Allow": "POST, DELETE" },
    });
  }

  await env.img_url.delete(params.id);
  return new Response(JSON.stringify(params.id), {
    headers: { "Content-Type": "application/json" },
  });
}
