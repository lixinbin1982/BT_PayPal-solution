# LumenX — Apple Pay ECS Demo (Braintree iOS SDK v7)

SwiftUI demo of the Apple Pay **express checkout (ECS)** flow via `BTApplePayClient`
(braintree_ios v7+), with an in-app API console that logs every step of the
sequence — including the redacted → full address transition.

It talks to the same LumenX demo server as the web store
(`https://web-production-84b119.up.railway.app`, configurable in `Config.swift`).

## Quick start (no Apple Pay setup needed)

1. Open `LumenXApplePayECS.xcodeproj` in Xcode 16+. Wait for SPM to resolve
   `braintree_ios` (first open only).
2. Select any iPhone simulator → Run.
3. Keep the mode picker on **Mock (simulate API calls)** → tap the Apple Pay button.

Mock mode performs the **real** API calls that don't require Apple hardware:

| Step | Call | Real or simulated |
|------|------|-------------------|
| 1–3  | `GET /api/braintree/client-token` → `clientToken.generate()` | REAL |
| 4–5  | `BTApplePayClient(authorization:)` · `isApplePaySupported()` | REAL |
| 6–7  | `makePaymentRequest()` (gateway config fetch) | REAL |
| 8    | required contact fields + shipping methods + summary items | local |
| 9–16 | Apple Pay sheet events (redacted address → shipping method → full address) | SIMULATED |
| 12/14| `POST /api/cart/price` re-pricing on each sheet event | REAL |
| 17–19| `tokenize(payment)` | simulated via sandbox nonce `fake-apple-pay-visa-nonce` |
| 20–21| `POST /api/braintree/checkout` → `gateway.transaction.sale(...)` | REAL — creates an actual sandbox transaction |

So a Mock run ends with a genuine Braintree sandbox transaction ID you can open
in the Control Panel, with the "extracted" shipping address attached.

## Real mode (actual Apple Pay sheet)

Switch the picker to **Real Apple Pay sheet**. Additional one-time setup:

1. Apple Developer portal → Identifiers → create a Merchant ID
   (e.g. `merchant.com.yourname.lumenx`).
2. Braintree **sandbox** Control Panel → Settings → Processing → Apple Pay →
   register that Merchant ID (upload the CSR Braintree gives you, install the
   certificate back in the Apple portal).
3. Xcode target → Signing & Capabilities → set your Team → add the
   **Apple Pay** capability → tick the Merchant ID.
4. Simulator: works with built-in test cards (no iCloud setup).
   Real device: sign into a sandbox iCloud tester account and add an Apple Pay
   test card to Wallet.

Notes:
- The full shipping address is read from `payment.shippingContact` inside
  `didAuthorizePayment` — it is NOT on the Braintree nonce.
- Pre-authorization, `didSelectShippingContact` only receives zip/city/state/
  country (Apple redacts street + name until Face ID).

## Pointing at a local server

Change `Config.serverBase` to `http://localhost:3000` and add an ATS exception
(target → Info → App Transport Security Settings → Allow Local Networking),
then run the Node server from the repo root: `npm start`.
