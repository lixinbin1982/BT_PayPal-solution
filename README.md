# LumenX Tactical — PayPal + Braintree Sandbox Demo

A deployable demo flashlight store (Olight-style) for demonstrating PayPal and Braintree sandbox payments to e-commerce merchants. No real charges are made.

## What's integrated

**PayPal — JS SDK v6 (frontend) + PayPal Server SDK (backend)**

- ECS (Express Checkout Shortcut): PayPal button on the **product page** and **cart page**
- **Continue method** (`commit: false` + `userAction: CONTINUE`): buyer approves in PayPal, returns to a review page on the merchant site, and payment is captured only after clicking "Complete Purchase"
- **App Switch**: on mobile the button attempts `presentationMode: "direct-app-switch"` (opens the PayPal app) with automatic fallback to `auto`; the page resumes the session via `session.hasReturned()` / `session.resume()` on return
- Server: order create / get / capture via `@paypal/paypal-server-sdk` (OrdersController)

**Braintree — braintree-web JS (frontend) + Braintree Node Server SDK (backend)**

- **Drop-in UI** on the checkout page: Card, **Venmo** (desktop QR enabled), **Google Pay** (TEST env), **Apple Pay**
- **Fastlane** accelerated checkout: email lookup → OTP for recognized members with saved card; guest enrollment otherwise (degrades gracefully if Fastlane isn't enabled on the sandbox account)
- **Google Pay & Apple Pay express buttons on the ECS flow** (product + cart pages) next to the PayPal button — wallet sheet → Braintree tokenize → server-side `transaction.sale`
- Server: client token generation, `transaction.sale` (submit for settlement), transaction lookup

## Pages

`/` home · `/product.html?id=…` product · `/cart.html` cart · `/checkout.html` checkout (PayPal review mode or Braintree payment mode) · `/status.html` purchase status

## Run locally

```bash
npm install
cp .env.example .env   # or use the included .env with sandbox credentials
npm start              # http://localhost:3000
```

Sandbox test card: `4111 1111 1111 1111`, any future expiry, any CVV.

## Deploy (Render)

1. Push this folder to a Git repo; Render auto-detects `render.yaml` (or create a Node web service: build `npm install`, start `npm start`).
2. Set the env vars from `.env.example` in the Render dashboard.
3. After the first deploy, set `BASE_URL` to the public URL (e.g. `https://your-app.onrender.com`) and redeploy — **required for PayPal App Switch** return/cancel URLs.

Works the same on Railway or any Node 18+ host.

## Feature requirements / caveats

- **App Switch** needs a public HTTPS URL (`BASE_URL`) and the PayPal app installed on the buyer's phone; otherwise the v6 SDK falls back to the web flow automatically.
- **Apple Pay** shows only in Safari on Apple devices over HTTPS, and the deployed domain must be registered in the Braintree control panel (Settings → Processing → Apple Pay) plus the domain-association file served. The button stays hidden when unsupported.
- **Google Pay** runs in the `TEST` environment — Chrome with a Google account signed in.
- **Venmo** sandbox: desktop shows a QR code; approve with a linked sandbox Venmo account.
- **Fastlane** must be enabled on the Braintree sandbox merchant account; the checkout shows a notice and continues without it if not.
- All pricing is computed server-side from the catalog (`data/products.js`); the client only sends `{id, qty}` pairs.

## Project structure

```
server.js                     Express server, PayPal + Braintree server SDK endpoints
data/products.js              Product catalog (server-side pricing source)
public/
  index.html                  Home / product grid
  product.html                Product detail + PayPal ECS + GPay/Apple Pay express
  cart.html                   Cart + PayPal ECS + GPay/Apple Pay express
  checkout.html               PayPal review/capture OR Braintree (Fastlane + Drop-in)
  status.html                 Purchase status (PayPal order / BT transaction lookup)
  js/store.js                 Catalog + localStorage cart
  js/paypal-ecs.js            PayPal JS SDK v6 session (continue + app switch)
  js/express-wallets.js       Google Pay / Apple Pay express buttons (Braintree)
  js/braintree-checkout.js    Fastlane + Drop-in checkout
  css/style.css               Dark Olight-style theme
```
