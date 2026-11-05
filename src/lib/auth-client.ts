import {
  credentialsSchema,
  signupSchema,
  authUserSchema,
  authErrorSchema,
  errorSchema,
} from "./contract.ts";

export async function authenticate(input: unknown, register: boolean) {
  const credentials = register ? signupSchema.parse(input) : credentialsSchema.parse(input);
  const response = await fetch(`/api/auth/${register ? "sign-up/email" : "sign-in/username"}`, {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(register ? { ...credentials, name: credentials.username } : credentials),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(errorSchema.or(authErrorSchema).parse(data).error);
  return authUserSchema.parse(data).user;
}
