# Chat lifecycle

Users send messages, stop a reply, or start a new conversation while keeping
their stored cart. Changing account must retire the old account's agent.

## Sub-features

- `chat-send` submits with Enter or Send message; Shift+Enter inserts a newline.
- `chat-stop` cancels a turn and permits another message.
- `chat-reset` clears chat after the old runtime closes and preserves the cart.
- `chat-account` ignores results from a signed-out or disposed account.
- `chat-limit` retains displayed messages and offers New conversation after a limit.
- `chat-history` restores completed checkpoints after refresh or sign-in, per user.
- `chat-recovery` blocks unfinished turns and failed saves without replaying tools.

## How to get to it (user POV)

Sign in and use the Message composer beneath the shop. Stop reply appears
while chat is busy, including saves and resets. New conversation is beside the
composer. An unfinished turn offers Discard unfinished turn. Retry save retries a
retained save operation without rerunning `fx`. Any HTTP 409 from a save, such as
"Chat changed in another tab.", or a failed save before `fx` starts offers Reload
saved chat. Any other load or initialization failure offers Retry loading chat. Follow
the displayed guidance before retrying or discarding. Restoring history must
never replay cart actions.

## Driving it with Task and agent-browser

Preconditions: live inference requires an approved server-side Gateway key and
a JSPI-capable browser. The default verification run deliberately has no key.
Do not claim a live reply from that run or copy private keys into skill files.

The default run still proves three controls. The alert reads "Set
AI_GATEWAY_API_KEY in the server environment." and the Message composer and
Send message stay disabled.

- Retry loading chat returns the same alert with the composer still disabled.
- New conversation saves a reset. A `state` read before and after shows the
  cart unchanged.
- Reload saved chat. Open a second tab, click New conversation there, then
  return to the first tab and click New conversation again:

```bash
task -t "$FX_VERIFY_TASK" browser -- tab new "$(task -t "$FX_VERIFY_TASK" origin)"
task -t "$FX_VERIFY_TASK" browser -- find role button click --name "New conversation" --exact
task -t "$FX_VERIFY_TASK" browser -- tab t1
task -t "$FX_VERIFY_TASK" browser -- find role button click --name "New conversation" --exact
task -t "$FX_VERIFY_TASK" browser -- get text '[role="alert"]'
task -t "$FX_VERIFY_TASK" browser -- find role button click --name "Reload saved chat" --exact
```

The first tab's alert must read "Chat changed in another tab. Refresh to load
saved chat." After Reload saved chat, the page reloads with the same cart.
Close the second tab with `tab close t2`. Use the tab ids that `tab list` prints
if they differ.

Use the existing isolated browser suite for repeatable lifecycle proof:

```bash
task test-browser > "${FX_VERIFY_RUN}.evidence/browser-tests.log" 2>&1
```

It drives the real UI with a controlled `libfx/browser` fixture and real
account and API requests. It prints 12 chat PASS lines. Check them for:

- Stop reply during the first save, before `fx` starts.
- History restore on refresh and sign-in, account isolation, and logout cleanup.
- Rejected saves, lost acknowledgements, checkpoint failures, and save-only
  retries, including an interrupted cart mutation that is not replayed.
- Reset ordering, close failure, account change, and disposal.
- Malformed `/api/config` values.
- Discard unfinished turn while the Gateway key is missing keeps the alert,
  Retry loading chat, and the disabled composer.
- Message and byte limits, and an exhausted MCP app conversation.
- An ordinary protocol failure and an ordinary cancellation that still allow
  sending.
- Late limit responses after an account change or disposal.

The suite shows Reload saved chat after a rejected first save (HTTP 503) but
does not click it. It never clicks Send message, never uses Shift+Enter, and
never stops a reply that is already streaming. Its server has a fixture Gateway
key, so it reaches the missing-key alert only through a replaced `/api/config`
response. On the baseline run, which has no key, check the real alert and that
Retry loading chat keeps it. Keep the other checks in the manual and live-model
journeys.

For an explicitly authorized live-model run, use `#prompt`, the Send message,
Stop reply, and New conversation buttons, plus Enter and Shift+Enter. Capture
the sent message and reply, stop a reply mid-stream, then show that resetting
chat preserves the cart.

## Gotchas

The browser suite also runs MCP Apps and creates its own ports and databases.
Do not replace its fixture globals to manufacture a manual UI result. Tests
do not prove natural-language tool selection by a live model. The header check
means the runtime started, not that Gateway accepted a credential.
