# Kenan Stack design

One Node process per channel serves the Preact app and Android WebView client. PostgreSQL stores conversations, messages, goals, workers and scheduled wakes. `shared/contract.ts` defines the client/server contract.

Each person has a manager and optional workers. Agent sessions use the Pi engine and the person's configured model broker. Workers run as the configured Unix user. User messages take priority over background work. Durable pending inputs resume interrupted work after a restart.

## App

Classic provides a conversation sidebar. Organized adds Home, chat groups, projects, calendar, to-dos and shopping lists. Choosing a layout does not remove stored data. Features are configured in `people[].extensions`.

Dictation uses the microphone to transcribe messages (`web/dictation.ts`, `server/extensions/dictation.ts`). Organized also offers a floating microphone and quick chat. Live voice (`web/extensions/Voice.tsx`, `server/extensions/voice.ts`) streams audio through WebRTC. Set `composerVoice: true` alongside the `voice` extension to show its composer button. GPT Live streams audio continuously in both directions; there is no turn-detection layer.

## Tools and channels

Core tools manage files, shell commands, goals, workers and wakes. Extensions add mail, calendar, browser, phone, messaging and other capabilities. Each person configures their own credentials and permissions. External sends pass through one channel writer, and request IDs prevent duplicate sends.

Wakes resume work on matching events or deadlines, instead of model polling. Host events, mail and messages can trigger them. Workers report results to their parent.

## Deployment

Linux with systemd, Node 24 and PostgreSQL 18 are required. Start from `config/channel.example.json` and the validation in `server/config.ts`. Deployment scripts build into a staged directory and update the selected channel. New changes go to Beta first; Production promotion uses Beta's running source. Configure paths, users, brokers, integrations and host services for your installation.

Private deployment notes, artwork and identity data are not distributed. Public examples are fictional.
