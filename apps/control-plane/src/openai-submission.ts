import type { Env } from "./env";

const CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
const TOKEN_MIN_LENGTH = 16;
const TOKEN_MAX_LENGTH = 1024;

function challengeToken(env: Env): string | null {
  const value = env.OPENAI_APPS_CHALLENGE_TOKEN;
  if (
    typeof value !== "string" ||
    value.length < TOKEN_MIN_LENGTH ||
    value.length > TOKEN_MAX_LENGTH ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  return value;
}

export function openAiSubmissionRoute(
  request: Request,
  env: Env,
  url: URL,
): Response | null {
  if (url.pathname !== CHALLENGE_PATH) {
    return null;
  }

  if (request.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: {
        allow: "GET",
        "cache-control": "no-store",
      },
    });
  }

  const token = challengeToken(env);
  if (!token) {
    return new Response("Not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  return new Response(token, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
