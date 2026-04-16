async function errorHandling(context) {
  try {
    return await context.next();
  } catch (err) {
    // Never leak internal error messages or stack traces to clients —
    // they can reveal routes, env variable names, and implementation details.
    console.error("Manage API error:", err && err.stack ? err.stack : err);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function basicAuthentication(request) {
  const Authorization = request.headers.get("Authorization") || "";

  const [scheme, encoded] = Authorization.split(" ");

  // The Authorization header must start with Basic, followed by a space.
  if (!encoded || scheme !== "Basic") {
    return null;
  }

  let decoded;
  try {
    const buffer = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(buffer).normalize();
  } catch (e) {
    return null;
  }

  const index = decoded.indexOf(":");

  // The user & password MUST NOT contain control characters.
  // @see https://tools.ietf.org/html/rfc5234#appendix-B.1 (=> "CTL = %x00-1F / %x7F")
  if (index === -1 || /[\0-\x1F\x7F]/.test(decoded)) {
    return null;
  }

  return {
    user: decoded.substring(0, index),
    pass: decoded.substring(index + 1),
  };
}

function unauthorizedResponse(reason) {
  return new Response(reason, {
    status: 401,
    statusText: "Unauthorized",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Cache-Control": "no-store",
      "WWW-Authenticate": 'Basic realm="admin", charset="UTF-8"',
    },
  });
}

function badRequestResponse(reason) {
  return new Response(reason, {
    status: 400,
    statusText: "Bad Request",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

// Constant-time string comparison to mitigate timing attacks on credential
// checks. Both inputs are coerced to strings first.
function timingSafeEqual(a, b) {
  const aStr = String(a);
  const bStr = String(b);
  if (aStr.length !== bStr.length) return false;
  let result = 0;
  for (let i = 0; i < aStr.length; i++) {
    result |= aStr.charCodeAt(i) ^ bStr.charCodeAt(i);
  }
  return result === 0;
}

function authentication(context) {
  // If the KV namespace is not bound, the dashboard is disabled entirely.
  if (
    typeof context.env.img_url == "undefined" ||
    context.env.img_url == null ||
    context.env.img_url == ""
  ) {
    return new Response(
      "Dashboard is disabled. Please bind a KV namespace to use this feature.",
      { status: 200 }
    );
  }

  // If basic auth is not configured, the dashboard is left unauthenticated
  // (historical behaviour). Operators are strongly encouraged to set both
  // BASIC_USER and BASIC_PASS in production — see SECURITY.md.
  if (
    typeof context.env.BASIC_USER == "undefined" ||
    context.env.BASIC_USER == null ||
    context.env.BASIC_USER == ""
  ) {
    return context.next();
  }

  if (!context.request.headers.has("Authorization")) {
    return unauthorizedResponse("You need to login.");
  }

  const credentials = basicAuthentication(context.request);
  if (!credentials) {
    return badRequestResponse("Malformed authorization header.");
  }

  const userOk = timingSafeEqual(context.env.BASIC_USER, credentials.user);
  const passOk = timingSafeEqual(context.env.BASIC_PASS, credentials.pass);
  if (!userOk || !passOk) {
    return unauthorizedResponse("Invalid credentials.");
  }

  return context.next();
}

export const onRequest = [errorHandling, authentication];
