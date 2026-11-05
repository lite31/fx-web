import { forward } from "$lib/server/server-environment";
import type { RequestHandler } from "./$types";

export const fallback: RequestHandler = forward;
