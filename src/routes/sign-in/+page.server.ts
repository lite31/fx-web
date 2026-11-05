import { error, redirect } from "@sveltejs/kit";
import { sessionSchema } from "$lib/contract";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ fetch, setHeaders }) => {
  setHeaders({ "cache-control": "no-store" });
  // SvelteKit forwards the request cookie to this same-origin fetch.
  const response = await fetch("/api/auth/get-session");
  if (!response.ok) error(503, "Unable to check your account. Try again.");
  const session = sessionSchema.safeParse(await response.json());
  if (!session.success) error(503, "Unable to check your account. Try again.");
  const { user } = session.data;
  if (user) redirect(303, "/");
  return {};
};
