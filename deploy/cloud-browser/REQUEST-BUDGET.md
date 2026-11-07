# Hard HTTP request budgets

`budget-browser` is an opt-in public-document acquisition wrapper. It launches a disposable **local** Chromium through a mandatory counting HTTP/HTTPS proxy. It does not modify `agent-browser`, cloud profiles, credentials, existing sessions, consent rules or browser selections. No gate is added when this tool is not requested.

Install from committed Kenan Stack source with `sudo bash deploy/install-budget-browser.sh`. The installer supplies `mitmproxy`, `python3-websockets` and `openssl`, and reuses a working Chromium or Google Chrome executable on PATH. If none exists, it attempts to install Debian's `chromium` package; Ubuntu hosts need an actual Chrome installation rather than the snap installer shim. Discovery checks `--version` before selecting a browser. Disposable profiles use the basic password store so no desktop keyring is involved. Test a specific behavior with `/usr/bin/python3 deploy/cloud-browser/budget-browser.test.py BudgetBrowserTest.test_over_budget_resource_never_reaches_server`; the fixtures use only loopback HTTP and HTTPS servers.

## Invocation

```sh
budget-browser --acquisition "$HOME/data/my-public-acquisition" \
  --http-request-budget 20 \
  --url 'https://public.example/document-one' \
  --url 'https://public.example/document-two'
```

Reuse **the same private acquisition directory and original budget** in every later invocation for that acquisition. The cumulative counter is not a page counter or a command counter. The directory must be owned by the invoking user and mode 0700. Do not delete it or create another directory to evade an acquisition limit. Its exclusive lock refuses concurrent use. The write-ahead ledger survives normal exits, reconnects through a later invocation and SIGKILL; an allowance reserved before a crash is spent, not credited back. A corrupt ledger or changed limit is refused.

Every outbound origin HTTP request consumes one reservation before dispatch, including the document, redirect destinations, styles, scripts, images, fonts, XHR, fetch and browser retries. The proxy's local CONNECT handshake and local CDP control messages are not outbound origin requests. HTTPS is terminated with an ephemeral certificate trusted only by its public-key fingerprint in the isolated browser; the proxy still verifies the actual upstream certificate. A private upstream public CA can be supplied using `--upstream-ca PATH`; certificate verification cannot be disabled. An optional repeatable `--allowed-host HOST` limits origin hosts before dispatch. Non-HTTP protocols, upgrades and opaque tunnels are refused; QUIC and non-proxied WebRTC are disabled. DNS and TLS connection setup are not HTTP requests or a byte/spending budget.

The tool prints JSON lines containing each page's rendered text and a final typed result. `BUDGET_EXHAUSTED` exits with status 2 and refuses all subsequent dispatches. This means no allowance remains, even if the last allowed response completed successfully. `BUDGET_PROTOCOL_REFUSED` also exits with status 2. `BUDGET_ENFORCEMENT_UNAVAILABLE` exits with status 1; never relabel these results as a complete successful acquisition. The counter is conservative: failed upstream requests can consume an allowance. A page's text is a partial observation, not proof that all its resources loaded.

## Explicit limitations

Cloud CDP attachment, existing profiles, logins, interactions and arbitrary browser commands are **unsupported**. Supplying options for them returns `BUDGET_CONFIGURATION_UNSUPPORTED` rather than falling back to resource timings. A cloud browser cannot inherit this host's mandatory loopback proxy, and attaching a CDP interceptor after session creation cannot truthfully bound its earlier traffic. A collector that requires residential egress must not use an ordinary cloud session under a literal request cap. It must first obtain a route with an equivalent enforcement boundary or use a separately authorized document-only allowance. This tool does not authorize recollection or any new account, provider, login or CAPTCHA handling.

### Managed residential cloud continuation

The original residential cloud route is **not repaired by the local-only wrapper**. Explicit requests through `cloud-browser start PROFILE --http-request-budget 20` or `cloud-browser attach SESSION --http-request-budget 20` now return the typed `BUDGET_ENFORCEMENT_UNAVAILABLE` result before profile lookup, provider calls, configuration writes, session creation or navigation. Calls without that option are unchanged. Install this narrow client repair with `sudo bash deploy/install-cloud-browser.sh --client-only`; it does not restart services or select another browser.

Two owned local Chromium fixtures establish why a simple remote-CDP counter is insufficient. Disconnecting a Request-stage Fetch interceptor releases its paused request. Separately, Chrome 156.0.8078.73 sent three real HTTP/2 requests for one Request-stage Fetch event when the server returned REFUSED_STREAM, including a case where the third attempt succeeded. Counting intercepted fetches is therefore not a literal HTTP dispatch cap. A prototype isolated context with a persistent unreachable proxy blocked requests after interceptor disconnect, but its residential fetch bridge is unqualified and must not be deployed. Do not relax a twenty-request acquisition into a twenty-fetch limit.

The provider's documented custom proxy replaces its managed residential route rather than chaining with it, and its supported Manifest V3 extensions cannot use debugger or proxy permissions. A request for a provider-enforced dispatch counter or an authorized residential chaining endpoint has been submitted through the existing provider support route. A support acknowledgement is not installed capability. Cloud support remains unfinished until that actual enforcement boundary is available and tested. No acquisition website was recollected, and no cloud session, CAPTCHA interaction, account or spending change was made for these tests.

Only the wrapper's ephemeral browser is terminated on exit. Existing sessions and their exclusive profiles are untouched. Request bodies are not saved by the proxy; temporary proxy certificates, profile and logs are removed on a normal exit. SIGKILL can leave temporary files, which are private and may be removed after confirming the owned children have ended. The durable acquisition ledger remains. The children receive SIGKILL if their parent dies; a dead proxy never permits a direct-network fallback.

Rollback affects only future opt-in invocations: repoint `/usr/local/bin/budget-browser` to the prior immutable toolchain, or remove that link to uninstall. Do not terminate another collector's acquisition or change ordinary browser configurations.
