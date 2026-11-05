import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ApiError, chatSnapshotSchema, type ChatCommand, type ChatSnapshot } from "../contract.ts";
import { transaction } from "./commerce.ts";

const chatSql = {
  schema:
    "CREATE TABLE IF NOT EXISTS chat_history(userId TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL DEFAULT 0, snapshot TEXT NOT NULL, operationId TEXT, digest TEXT)",
  ensure: "INSERT OR IGNORE INTO chat_history(userId,snapshot) VALUES(?,?)",
  read: "SELECT revision,snapshot,operationId,digest FROM chat_history WHERE userId=?",
  write: "UPDATE chat_history SET revision=?,snapshot=?,operationId=?,digest=? WHERE userId=?",
};

const rowSchema = z.object({
  revision: z.number(),
  snapshot: z.string(),
  operationId: z.string().nullable(),
  digest: z.string().nullable(),
});

export function createChatHistory(db: DatabaseSync) {
  db.exec(chatSql.schema);
  const empty = { checkpoint: null, messages: [], limited: false, pending: null };
  function row(userId: string) {
    db.prepare(chatSql.ensure).run(userId, JSON.stringify(empty));
    return rowSchema.parse(db.prepare(chatSql.read).get(userId));
  }
  function snapshot(stored: z.infer<typeof rowSchema>): ChatSnapshot {
    return chatSnapshotSchema.parse({ ...JSON.parse(stored.snapshot), revision: stored.revision });
  }
  return {
    load(userId: string) {
      return snapshot(row(userId));
    },
    change(userId: string, input: ChatCommand) {
      return transaction(db, () => {
        const stored = row(userId);
        const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
        // Check the last receipt before the revision. A retry after a lost response
        // carries the old revision but must return the already committed snapshot.
        if (stored.operationId === input.operationId) {
          if (stored.digest !== digest)
            throw new ApiError(
              "This save identifier was already used. Refresh to load saved chat.",
              409,
            );
          return snapshot(stored);
        }
        if (stored.revision !== input.revision)
          throw new ApiError("Chat changed in another tab. Refresh to load saved chat.", 409);
        const current = snapshot(stored);
        let next: Omit<ChatSnapshot, "revision">;
        switch (input.kind) {
          // Keep the last completed checkpoint while a turn is pending. Discarding
          // that marker never undoes cart changes or replays the unfinished prompt.
          case "begin":
            if (current.pending)
              throw new ApiError("An unfinished turn needs your decision before sending.", 409);
            next = { ...current, pending: { turnId: input.turnId, prompt: input.prompt } };
            break;
          case "complete":
            if (current.pending?.turnId !== input.turnId)
              throw new ApiError(
                "This turn is no longer current. Refresh to load saved chat.",
                409,
              );
            next = {
              checkpoint: input.checkpoint,
              messages: input.messages,
              limited: input.limited,
              pending: null,
            };
            break;
          case "discard":
            if (current.pending?.turnId !== input.turnId)
              throw new ApiError(
                "This turn is no longer current. Refresh to load saved chat.",
                409,
              );
            next = { ...current, pending: null };
            break;
          case "reset":
            next = empty;
            break;
        }
        const { revision, ...data } = chatSnapshotSchema.parse({
          ...next,
          revision: current.revision + 1,
        });
        db.prepare(chatSql.write).run(
          revision,
          JSON.stringify(data),
          input.operationId,
          digest,
          userId,
        );
        return { ...data, revision };
      });
    },
  };
}
