# Telnyx for Kenan's Canadian line

The inactive adapter lives in `server/extensions/texts-telnyx.ts`, `texts-line.ts` and `texts-outbound.ts`. Installing it changes no carrier settings. Alice's 438 XMPP account in `keptLines` and Dave's 510 account stay on JMP.

## SMS activation after the port

1. Store the Telnyx API key in `/etc/kenan/telnyx/api-key` and the account's **base64 Ed25519 public key** in `/etc/kenan/telnyx/public-key`. The service must be able to read these files; keep their existing private ownership/modes. Keys & Credentials in Telnyx supplies the public key. No API key is sent to the webhook.
2. Create a messaging profile with the official `POST /v2/messaging_profiles` API; set `webhook_url` to `https://kenan.example.com/kenan/beta/hooks/texts/telnyx/alice`. Assign the ported number to that profile using the phone-number messaging API. Save its real profile ID; placeholders below must be replaced.
3. Once Telnyx confirms messaging on the ported number, replace **only** `media.telephone.texts` in `/etc/kenan/domains/alice.json`:

   ```json
   {"kind":"telnyx","line":"+12025550102","publicKeyPath":"/etc/kenan/telnyx/public-key","messagingProfileId":"ACTUAL_PROFILE_ID"}
   ```

   Restart Beta so the primary JMP XMPP connection stops. `keptLines` is unchanged and reconnects Alice's 438 account. Webhook config itself is read per request; the channel named by `media.telephone.inbound.channel` must be `beta`.
4. Leave `outboundTexts.kind` as `forbidden` until the port and applicable messaging permissions, consent and compliance are ready. Then replace **only** `media.telephone.outboundTexts`:

   ```json
   {"kind":"telnyx","keyPath":"/etc/kenan/telnyx/api-key","fromNumber":"+12025550102","messagingProfileId":"ACTUAL_PROFILE_ID"}
   ```

   This is read on each send; no restart is needed. `send` to `texts:+E164` uses `POST https://api.telnyx.com/v2/messages`. Its `accepted` result is not proof of delivery. Signed `message.finalized` failures notify Kenaznia. An uncertain HTTP/network result must be looked up in Telnyx's message records before resending; the adapter never automatically retries a send.
5. Check one real inbound SMS appears in `inbox` and one permitted reply reaches the intended recipient. No real SMS is sent by installation or the direct adapter check.

This is a Canadian +1 343 number. US 10DLC is not an activation assumption. Telnyx must confirm the requirements for this sender, destination countries and use; enabling an API key alone does not grant messaging permission.

## Public ingress

The canonical Nginx source is `~/tools/household-mesh/public.conf`, installed at `/etc/household-mesh/public.conf` by the host operator. Its single exact POST route strips `/kenan/beta` and forwards to `/run/kenan/beta.sock`. Other public app routes remain unavailable. Reload with `systemctl reload household-mesh-public` after `nginx -t -c /etc/household-mesh/public.conf`.

The hook requires `telnyx-signature-ed25519` and `telnyx-timestamp`. It verifies Ed25519 over the timestamp, a pipe character and the exact raw request bytes, with a five-minute age limit and 256 KiB body limit. It checks the configured profile and called number. Message IDs deduplicate retries in the existing texts feed. SMS/MMS text and media URLs use the same stored feed, sender routing, watcher and text wakes as JMP. No media URL is fetched by the adapter.

Official references: [receive messages](https://developers.telnyx.com/docs/messaging/messages/receive-message), [webhooks and signatures](https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks), [send message](https://developers.telnyx.com/api-reference/messages/send-a-message).

## Voice activation after the port

The existing `sip-trunk` registration format supports Telnyx credential connections; no new call transport is needed. Create a credential connection, assign the ported number and outbound voice profile, and configure the DID to arrive at the registered endpoint. Telnyx's default E.164 DID includes a leading `+`; the existing dialplan strips it. Use the official current [Telnyx Asterisk guide](https://developers.telnyx.com/docs/voice/sip-trunking/asterisk) and SIP signalling network list, not trial addresses copied from a past run.

Write a private `telnyx.json` profile under `/etc/kenan/phone-carriers/alice/` on the **shared edge configuration owner (AX42)**, containing `fromNumber: "+12025550102"`, `sip.carrier`, `sip.from` (Telnyx's current signalling CIDRs), `sip.outbound: {kind:"register",server:"sip.telnyx.com",username:ACTUAL_SIP_USERNAME,passwordPath:PRIVATE_SIP_PASSWORD_FILE}` and `inboundRoute` describing the connection. The existing `kenan-phone-carrier switch alice telnyx` selects that profile and regenerates both shared edge lines. Keep Dave's domain and JMP credentials present. On ResearchCo, use the same carrier/CIDRs but `sip.outbound: {"kind":"edge"}` to use the already managed endpoint without a second owner regenerating it.

Do **not** generate the shared edge from ResearchCo's Alice-only domains directory. The generator refuses a configuration that would remove an existing line endpoint. A carrier switch does not alter SMS settings; activate them separately above. Check the Telnyx registration and one real inbound/outbound call, leaving the JMP 438 and 510 routes intact. Rollback before the actual port is selecting the unchanged JMP profile and XMPP343 settings; after the port, routing the ported number back requires carrier support rather than a local config rollback.
