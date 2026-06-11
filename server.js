/**
 * LumenX Tactical - PayPal + Braintree sandbox demo store
 *
 * Server integrations:
 *  - PayPal Server SDK (@paypal/paypal-server-sdk) -> Orders v2 create / get / capture
 *  - Braintree Server SDK (braintree)              -> clientToken.generate / transaction.sale
 *
 * Frontend integrations (see /public):
 *  - PayPal JS SDK v6 (web components) with ECS "Continue" flow + App Switch
 *  - Braintree Drop-in (card / Venmo / Apple Pay / Google Pay) + Fastlane
 */
require("dotenv").config();

const path = require("path");
const https = require("https");
const express = require("express");
const braintree = require("braintree");
const {
  Client,
  Environment,
  LogLevel,
  OrdersController,
  CheckoutPaymentIntent,
  ApiError
} = require("@paypal/paypal-server-sdk");
const { products, getProduct } = require("./data/products");

const PORT = process.env.PORT || 3000;

/* Demo state-based sales tax rates; anything not listed uses the default. */
const STATE_TAX_RATES = {
  CA: 0.0875, NY: 0.08875, TX: 0.0825, FL: 0.06, WA: 0.095,
  IL: 0.0825, PA: 0.06, NV: 0.0685, AZ: 0.056,
  OR: 0, MT: 0, NH: 0, DE: 0, AK: 0
};
const DEFAULT_TAX_RATE = 0.07;

/* Shipping methods offered in every flow (standard checkout, PayPal ECS
 * review, Google Pay & Apple Pay sheets). Standard is free over $150. */
const SHIPPING_METHODS = {
  standard:  { id: "standard",  label: "Standard",  detail: "5–7 business days",      base: 5.99,  freeOver: 150 },
  express:   { id: "express",   label: "Express",   detail: "2–3 business days",      base: 14.99 },
  overnight: { id: "overnight", label: "Overnight", detail: "Next business day",      base: 29.99 }
};
const DEFAULT_SHIPPING_METHOD = "standard";

function shippingCost(itemTotal, state, methodId) {
  const st = String(state || "CA").trim().toUpperCase();
  const m = SHIPPING_METHODS[methodId] || SHIPPING_METHODS[DEFAULT_SHIPPING_METHOD];
  let shipping = m.freeOver && itemTotal >= m.freeOver ? 0 : m.base;
  if (st === "AK" || st === "HI") shipping += 10; // remote surcharge
  return { shipping, method: m };
}

/** Shipping + tax for a destination state + shipping method (demo rules). */
function shippingAndTax(itemTotal, state, methodId) {
  const st = String(state || "CA").trim().toUpperCase();
  const rate = STATE_TAX_RATES[st] !== undefined ? STATE_TAX_RATES[st] : DEFAULT_TAX_RATE;
  const { shipping, method } = shippingCost(itemTotal, st, methodId);
  const tax = Math.round(itemTotal * rate * 100) / 100;
  return { shipping, tax, rate, method };
}

/** All shipping options priced for a given cart + state (for UIs/wallets). */
function shippingOptionsFor(itemTotal, state) {
  return Object.keys(SHIPPING_METHODS).map((id) => {
    const { shipping, method } = shippingCost(itemTotal, state, id);
    return { id, label: method.label, detail: method.detail, amount: shipping.toFixed(2) };
  });
}
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;

/* ------------------------------------------------------------------ */
/*  PayPal Server SDK client                                           */
/* ------------------------------------------------------------------ */
const paypalClient = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: PAYPAL_CLIENT_ID,
    oAuthClientSecret: PAYPAL_CLIENT_SECRET
  },
  environment: Environment.Sandbox,
  timeout: 0,
  logging: {
    logLevel: LogLevel.Info,
    logRequest: { logBody: false },
    logResponse: { logHeaders: false }
  }
});
const ordersController = new OrdersController(paypalClient);

/* ------------------------------------------------------------------ */
/*  Braintree gateway (server SDK)                                     */
/* ------------------------------------------------------------------ */
const gateway = new braintree.BraintreeGateway({
  environment: braintree.Environment.Sandbox,
  merchantId: process.env.BT_MERCHANT_ID,
  publicKey: process.env.BT_PUBLIC_KEY,
  privateKey: process.env.BT_PRIVATE_KEY
});

/* ------------------------------------------------------------------ */
/*  App setup                                                          */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------------------------------------------ */
/*  API history console: in-memory log of every /api/* call            */
/* ------------------------------------------------------------------ */
const API_LOGS = [];
const MAX_LOGS = 300;
let LOG_SEQ = 0;

function viaFor(path) {
  if (path.startsWith("/api/paypal")) return "PayPal Orders v2 (Server SDK)";
  if (path.startsWith("/api/braintree")) return "Braintree Server SDK";
  return "Store API";
}

/* Source -> destination for each call, so the console shows WHO talks to WHOM. */
function routeFor(path) {
  if (path.startsWith("/api/paypal")) {
    return {
      from: "Browser",
      to: "Merchant Server → api-m.sandbox.paypal.com (PayPal Orders v2)"
    };
  }
  if (path.startsWith("/api/braintree")) {
    return {
      from: "Browser",
      to: "Merchant Server → api.sandbox.braintreegateway.com (Braintree Gateway)"
    };
  }
  return { from: "Browser", to: "Merchant Server (local pricing/config — no external call)" };
}

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/logs")) return next(); // don't log the console itself
  const entry = {
    id: ++LOG_SEQ,
    time: new Date().toISOString(),
    method: req.method,
    path: "/api" + req.path,
    via: viaFor("/api" + req.path),
    ...routeFor("/api" + req.path),
    query: Object.keys(req.query || {}).length ? req.query : undefined,
    requestBody: req.body && Object.keys(req.body).length ? req.body : undefined,
    status: null,
    durationMs: null,
    responseBody: null
  };
  const started = Date.now();
  const record = (body) => {
    if (entry.status !== null) return; // record once (json() calls send())
    entry.status = res.statusCode;
    entry.durationMs = Date.now() - started;
    entry.responseBody = body;
    API_LOGS.push(entry);
    if (API_LOGS.length > MAX_LOGS) API_LOGS.shift();
  };
  const origJson = res.json.bind(res);
  res.json = (body) => { record(body); return origJson(body); };
  const origSend = res.send.bind(res);
  res.send = (body) => {
    let parsed = body;
    if (typeof body === "string") { try { parsed = JSON.parse(body); } catch (_) { /* raw */ } }
    record(parsed);
    return origSend(body);
  };
  next();
});

app.get("/api/logs", (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  res.json({ seq: LOG_SEQ, logs: API_LOGS.filter((l) => l.id > since) });
});
app.delete("/api/logs", (req, res) => {
  API_LOGS.length = 0;
  res.json({ cleared: true });
});
/* Client-side SDK events (Braintree JS / Google Pay JS) reported by the
   browser so the console shows the FULL payment sequence, not just our
   server calls. */
app.post("/api/logs/client", (req, res) => {
  const b = req.body || {};
  API_LOGS.push({
    id: ++LOG_SEQ,
    time: new Date().toISOString(),
    method: b.method || "SDK",
    path: b.path || "(client event)",
    via: b.via || "Browser SDK",
    from: b.from || "Browser",
    to: b.to || "(client-side)",
    requestBody: b.request,
    status: b.status || 200,
    durationMs: b.durationMs ?? 0,
    responseBody: b.response
  });
  if (API_LOGS.length > MAX_LOGS) API_LOGS.shift();
  res.json({ ok: true, seq: LOG_SEQ });
});

function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  return `${proto}://${req.get("host")}`;
}

/** Compute totals server-side from [{id, qty}] - never trust client amounts. */
function priceCart(items, state, shippingMethod) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Cart is empty");
  }
  let itemTotal = 0;
  const lineItems = items.map(({ id, qty }) => {
    const product = getProduct(id);
    const quantity = Math.max(1, Math.min(99, parseInt(qty, 10) || 1));
    if (!product) throw new Error(`Unknown product: ${id}`);
    itemTotal += product.price * quantity;
    return {
      name: product.name,
      sku: product.id,
      unitAmount: { currencyCode: "USD", value: product.price.toFixed(2) },
      quantity: String(quantity),
      category: "PHYSICAL_GOODS"
    };
  });
  const { shipping, tax, method } = shippingAndTax(itemTotal, state, shippingMethod);
  const total = itemTotal + shipping + tax;
  return {
    lineItems,
    itemTotal: itemTotal.toFixed(2),
    shipping: shipping.toFixed(2),
    shippingMethod: method.id,
    tax: tax.toFixed(2),
    total: total.toFixed(2),
    // All options priced for this state so UIs/wallet sheets can render them
    shippingOptions: shippingOptionsFor(itemTotal, state)
  };
}

/* ------------------------------------------------------------------ */
/*  Generic config / catalog APIs                                      */
/* ------------------------------------------------------------------ */
/**
 * Same-origin proxy for the Google Pay base library. Ad/privacy blockers
 * often block <script src="https://pay.google.com/gp/p/js/pay.js"> by URL;
 * serving it from our own origin lets the Google Pay button render anyway.
 */
app.get("/js/gpay.js", (req, res) => {
  https
    .get("https://pay.google.com/gp/p/js/pay.js", (r) => {
      res.set("Content-Type", "application/javascript");
      res.set("Cache-Control", "public, max-age=3600");
      r.pipe(res);
    })
    .on("error", () => res.status(502).send("// pay.js proxy failed"));
});

app.get("/api/config", (req, res) => {
  res.json({ paypalClientId: PAYPAL_CLIENT_ID, currency: "USD" });
});

app.get("/api/products", (req, res) => res.json(products));

app.post("/api/cart/price", (req, res) => {
  try {
    res.json(priceCart(req.body.items, req.body.state, req.body.shippingMethod));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/*  PayPal - Orders v2 via PayPal Server SDK                           */
/* ------------------------------------------------------------------ */

/**
 * Create order. Called by the JS SDK v6 button on product & cart pages
 * (ECS shortcut flow). userAction=CONTINUE -> buyer sees "Continue" in the
 * PayPal sheet and returns to our checkout page to review before capture.
 * return/cancel URLs are required for App Switch & redirect flows.
 */
app.post("/api/paypal/orders", async (req, res) => {
  try {
    const cart = priceCart(req.body.items);
    // ECS: the order is created with the ITEM TOTAL only. Shipping & tax are
    // calculated AFTER approval from the shipping address on the buyer's
    // PayPal account, and the order amount is patched before capture.
    //
    // App Switch: the PayPal app reopens returnUrl WITHOUT a ?token= param,
    // so the return must go back to the page that STARTED the session — the
    // JS SDK detects it via hasReturned(), resume() fires onApprove(orderId)
    // there, and only then do we navigate to the checkout review page.
    const rp = req.body.returnPath;
    const returnPath =
      typeof rp === "string" && rp.startsWith("/") && !rp.startsWith("//")
        ? rp
        : "/checkout.html";
    const sep = returnPath.includes("?") ? "&" : "?";
    const { result, ...httpResponse } = await ordersController.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            referenceId: "default",
            description: "LumenX Tactical order",
            items: cart.lineItems,
            amount: {
              currencyCode: "USD",
              value: cart.itemTotal,
              breakdown: {
                itemTotal: { currencyCode: "USD", value: cart.itemTotal }
              }
            }
          }
        ],
        paymentSource: {
          paypal: {
            experienceContext: {
              brandName: "LumenX Tactical",
              userAction: "CONTINUE", // ECS: review on merchant site before pay
              shippingPreference: "GET_FROM_FILE",
              returnUrl: `${baseUrl(req)}${returnPath}${sep}paypalReturn=true`,
              cancelUrl: `${baseUrl(req)}/cart.html?paypalCancel=true`
            }
          }
        }
      },
      prefer: "return=representation"
    });
    res.status(httpResponse.statusCode || 201).json({ id: result.id, status: result.status });
  } catch (err) {
    handlePayPalError(err, res);
  }
});

/** Order details for the checkout review page (payer + shipping + totals). */
app.get("/api/paypal/orders/:orderId", async (req, res) => {
  try {
    const { body } = await ordersController.getOrder({ id: req.params.orderId });
    res.type("json").send(body);
  } catch (err) {
    handlePayPalError(err, res);
  }
});

/**
 * ECS step 2: after PayPal approval, read the shipping address the buyer
 * selected from their PayPal account, calculate shipping + tax for that
 * address, and PATCH the order amount. Returns the updated order.
 */
app.post("/api/paypal/orders/:orderId/update-shipping", async (req, res) => {
  try {
    // 1) Get the approved order -> buyer-selected shipping address
    const { body } = await ordersController.getOrder({ id: req.params.orderId });
    const order = JSON.parse(body);
    const pu = (order.purchase_units && order.purchase_units[0]) || {};
    const addr = (pu.shipping && pu.shipping.address) || {};
    const breakdown = (pu.amount && pu.amount.breakdown) || {};
    const itemTotal = parseFloat(
      (breakdown.item_total && breakdown.item_total.value) || pu.amount.value
    );

    // 2) Calculate shipping fee + tax for the PayPal account address.
    // The review page can re-call this endpoint with { shippingMethod } when
    // the buyer picks Standard / Express / Overnight.
    const methodId = (req.body && req.body.shippingMethod) || DEFAULT_SHIPPING_METHOD;
    const { shipping, tax, rate } = shippingAndTax(itemTotal, addr.admin_area_1, methodId);
    const total = (itemTotal + shipping + tax).toFixed(2);

    // 3) PATCH the order amount with the full breakdown
    await ordersController.patchOrder({
      id: req.params.orderId,
      body: [
        {
          op: "replace",
          path: `/purchase_units/@reference_id=='${pu.reference_id || "default"}'/amount`,
          // NOTE: the SDK sends the patch `value` verbatim (typed `unknown`),
          // so it must already be snake_case JSON as the PayPal API expects.
          value: {
            currency_code: "USD",
            value: total,
            breakdown: {
              item_total: { currency_code: "USD", value: itemTotal.toFixed(2) },
              shipping: { currency_code: "USD", value: shipping.toFixed(2) },
              tax_total: { currency_code: "USD", value: tax.toFixed(2) }
            }
          }
        }
      ]
    });

    // 4) Return the updated order + priced shipping options for the review page
    const updated = await ordersController.getOrder({ id: req.params.orderId });
    const updatedOrder = JSON.parse(updated.body);
    updatedOrder.shipping_options = shippingOptionsFor(itemTotal, addr.admin_area_1);
    updatedOrder.selected_shipping_method = methodId;
    res.json(updatedOrder);
  } catch (err) {
    handlePayPalError(err, res);
  }
});

/** Capture after buyer confirms on our checkout review page. */
app.post("/api/paypal/orders/:orderId/capture", async (req, res) => {
  try {
    const { body } = await ordersController.captureOrder({
      id: req.params.orderId,
      prefer: "return=representation"
    });
    res.type("json").send(body);
  } catch (err) {
    handlePayPalError(err, res);
  }
});

function handlePayPalError(err, res) {
  if (err instanceof ApiError) {
    console.error("PayPal ApiError:", err.statusCode, err.body);
    let details = err.body;
    try { details = JSON.parse(err.body); } catch (_) { /* keep raw */ }
    return res.status(err.statusCode || 500).json({ error: "PayPal API error", details });
  }
  console.error("PayPal error:", err);
  res.status(500).json({ error: err.message });
}

/* ------------------------------------------------------------------ */
/*  Braintree - via Braintree Server SDK                               */
/* ------------------------------------------------------------------ */

/** Client token for Drop-in / braintree-web / Fastlane. */
app.get("/api/braintree/client-token", async (req, res) => {
  try {
    const response = await gateway.clientToken.generate({});
    res.json({ clientToken: response.clientToken });
  } catch (err) {
    console.error("Braintree clientToken error:", err);
    res.status(500).json({ error: err.message });
  }
});

/** Create transaction from a payment method nonce (card / Venmo / wallets / Fastlane). */
app.post("/api/braintree/checkout", async (req, res) => {
  try {
    const { paymentMethodNonce, deviceData, items, shipping } = req.body;
    if (!paymentMethodNonce) {
      return res.status(400).json({ error: "Missing paymentMethodNonce" });
    }
    const cart = priceCart(items, shipping && shipping.region, req.body.shippingMethod);

    const saleRequest = {
      amount: cart.total,
      taxAmount: cart.tax,
      shippingAmount: cart.shipping,
      paymentMethodNonce,
      deviceData,
      orderId: `LMX-${Date.now()}`,
      options: { submitForSettlement: true }
    };
    if (shipping && shipping.firstName) {
      saleRequest.shipping = {
        firstName: shipping.firstName,
        lastName: shipping.lastName || "",
        streetAddress: shipping.streetAddress || "",
        locality: shipping.locality || "",
        region: shipping.region || "",
        postalCode: shipping.postalCode || "",
        countryCodeAlpha2: shipping.countryCode || "US"
      };
    }

    const result = await gateway.transaction.sale(saleRequest);
    if (result.success) {
      const t = result.transaction;
      res.json({
        success: true,
        transaction: {
          id: t.id,
          status: t.status,
          amount: t.amount,
          currencyIsoCode: t.currencyIsoCode,
          paymentInstrumentType: t.paymentInstrumentType,
          cardType: t.creditCard ? t.creditCard.cardType : undefined,
          last4: t.creditCard ? t.creditCard.last4 : undefined
        }
      });
    } else {
      console.error("Braintree sale failed:", result.message);
      res.status(422).json({ success: false, error: result.message });
    }
  } catch (err) {
    console.error("Braintree checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

/** Transaction details for the purchase status page. */
app.get("/api/braintree/transactions/:id", async (req, res) => {
  try {
    const t = await gateway.transaction.find(req.params.id);
    res.json({
      id: t.id,
      status: t.status,
      type: t.type,
      amount: t.amount,
      currencyIsoCode: t.currencyIsoCode,
      paymentInstrumentType: t.paymentInstrumentType,
      createdAt: t.createdAt,
      cardType: t.creditCard ? t.creditCard.cardType : undefined,
      last4: t.creditCard ? t.creditCard.last4 : undefined,
      customer: t.customer
    });
  } catch (err) {
    res.status(404).json({ error: "Transaction not found" });
  }
});

/* ------------------------------------------------------------------ */
app.listen(PORT, () => {
  console.log(`LumenX demo store running on http://localhost:${PORT}`);
  console.log(`PayPal env: SANDBOX | Braintree merchant: ${process.env.BT_MERCHANT_ID}`);
});
