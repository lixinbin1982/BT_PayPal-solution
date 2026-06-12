/**
 * PayPal JS SDK v6 - Express Checkout Shortcut (ECS) integration.
 *
 * Used on BOTH the product page and the cart page:
 *  - <paypal-button> web component (v6)
 *  - commit:false  -> buyer sees "Continue" in the PayPal sheet (ECS review flow)
 *  - onApprove     -> we do NOT capture; we redirect to /checkout.html for
 *                     order review, capture happens there ("continue method")
 *  - App Switch    -> presentationMode "direct-app-switch" attempted first on
 *                     mobile (falls back to "auto"); hasReturned()/resume()
 *                     handle the buyer coming back from the PayPal app.
 *
 * Load the v6 core script before this file:
 *   <script src="https://www.sandbox.paypal.com/web-sdk/v6/core" defer></script>
 */
const PayPalECS = (() => {
  let session = null;
  let sdkInstance = null; // shared between the ECS and Pay Now buttons
  let lastGetItems = null;

  const isMobile = () =>
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  /**
   * Pay Later messaging: keep the <paypal-message> element's amount in sync
   * with the server-priced total (items + shipping + tax).
   */
  async function updateMessageAmount() {
    const el = document.querySelector("paypal-message");
    if (!el || !lastGetItems) return;
    try {
      const items = lastGetItems();
      if (!items.length) return;
      const priced = await fetch("/api/cart/price", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items })
      }).then((r) => r.json());
      el.setAttribute("amount", priced.total);
      el.amount = priced.total; // triggers automatic re-render (v6)
    } catch (e) {
      console.warn("Pay Later message amount update failed:", e);
    }
  }

  /** Server-side order creation (PayPal Server SDK). v6 requires {orderId}. */
  async function createOrder(getItems) {
    const res = await fetch("/api/paypal/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: getItems(),
        // App Switch: PayPal must return the buyer to THIS page so the SDK
        // session can resume() and fire onApprove here (the app reopens the
        // returnUrl without a ?token= param, unlike the redirect flow).
        returnPath: location.pathname + location.search
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Order creation failed");
    // Fallback for returns that lose SDK session state: remember the order
    // so checkout.html can recover it via ?paypalReturn=true.
    try { sessionStorage.setItem("ppOrderId", data.id); } catch (e) {}
    return { orderId: data.id };
  }

  /**
   * @param {Object} cfg
   * @param {string}   cfg.pageType  "product-details" | "cart"
   * @param {Function} cfg.getItems  () => [{id, qty}]
   * @param {string}   [cfg.buttonSelector="paypal-button"]
   */
  async function init(cfg) {
    // JSv6 custom button: any merchant element can launch the session —
    // we use our own styled <button> instead of the <paypal-button> component.
    const buttonSelector = cfg.buttonSelector || "#paypal-custom-btn";
    const statusEl = document.getElementById("paypal-status");
    const say = (msg, cls) => {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.className = msg ? `alert ${cls || "info"}` : "hidden";
    };

    if (!window.paypal || !window.paypal.createInstance) {
      say("PayPal SDK failed to load.", "error");
      return;
    }

    const { paypalClientId } = await fetch("/api/config").then((r) => r.json());

    sdkInstance = await window.paypal.createInstance({
      clientId: paypalClientId,
      components: ["paypal-payments", "paypal-messages"],
      pageType: cfg.pageType
    });

    // Pay Later messaging (auto-bootstrap <paypal-message> elements)
    lastGetItems = cfg.getItems;
    try {
      sdkInstance.createPayPalMessages();
      updateMessageAmount();
    } catch (e) {
      console.warn("Pay Later messages unavailable:", e);
    }

    session = sdkInstance.createPayPalOneTimePaymentSession({
      commit: false, // ECS "Continue" flow - review before pay on merchant site
      async onApprove(data) {
        // Continue method: no capture here. Hand off to checkout review page.
        window.location.href = `/checkout.html?paypalOrderId=${encodeURIComponent(data.orderId)}`;
      },
      onCancel() {
        say("PayPal checkout was cancelled. Your cart is unchanged.", "info");
      },
      onError(err) {
        console.error("PayPal error:", err);
        say(`PayPal error: ${err && err.message ? err.message : err}`, "error");
      }
    });

    // App Switch return path: buyer finished (or cancelled) in the PayPal app
    // and was returned to this page via the order's return URL.
    if (session.hasReturned && session.hasReturned()) {
      say("Returning from PayPal…", "info");
      await session.resume();
      return;
    }

    // Eligibility check before showing the button (v6 best practice)
    try {
      const methods = await sdkInstance.findEligibleMethods({ currencyCode: "USD" });
      if (!methods.isEligible("paypal")) {
        say("PayPal is not eligible for this buyer/currency.", "info");
        return;
      }
    } catch (e) {
      console.warn("Eligibility check failed, showing button anyway", e);
    }

    const btn = document.querySelector(buttonSelector);
    if (!btn) return;
    btn.removeAttribute("hidden");

    btn.addEventListener("click", async () => {
      say("", "");
      if (!cfg.getItems().length) {
        say("Your cart is empty.", "error");
        return;
      }
      const orderPromise = createOrder(cfg.getItems);

      // Prefer App Switch on mobile devices, gracefully fall back to auto
      // (popup -> modal) on desktop or when App Switch is unavailable.
      const modes = isMobile() ? ["direct-app-switch", "auto"] : ["auto"];
      for (const presentationMode of modes) {
        try {
          await session.start({ presentationMode }, orderPromise);
          return;
        } catch (err) {
          console.warn(`presentationMode "${presentationMode}" failed:`, err);
          if (presentationMode === modes[modes.length - 1]) {
            say(`Unable to open PayPal: ${err && err.message ? err.message : err}`, "error");
          }
        }
      }
    });
  }

  /**
   * Pay Now flow (commit:true) — used in the checkout page's "Other payment
   * methods" list. Unlike ECS, the order is created with the FINAL total
   * (items + shipping + tax from the checkout form) and the form's shipping
   * address; the PayPal sheet shows "Pay Now" and the payment is captured
   * immediately in onApprove — no merchant review page.
   *
   * @param {Object} cfg
   * @param {Function} cfg.getItems           () => [{id, qty}]
   * @param {Function} [cfg.getState]          () => "CA"
   * @param {Function} [cfg.getShippingMethod] () => "standard"
   * @param {Function} [cfg.getShipping]       () => {firstName, …, countryCode}
   * @param {string}   [cfg.buttonSelector="#paypal-paynow-btn"]
   * @param {string}   [cfg.statusSelector="#paypal-paynow-status"]
   */
  async function initPayNow(cfg) {
    const btn = document.querySelector(cfg.buttonSelector || "#paypal-paynow-btn");
    if (!btn) return;
    const statusEl = document.querySelector(cfg.statusSelector || "#paypal-paynow-status");
    const say = (msg, cls) => {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.className = msg ? `alert ${cls || "info"}` : "hidden";
    };

    if (!window.paypal || !window.paypal.createInstance) return;
    if (!sdkInstance) {
      const { paypalClientId } = await fetch("/api/config").then((r) => r.json());
      sdkInstance = await window.paypal.createInstance({
        clientId: paypalClientId,
        components: ["paypal-payments", "paypal-messages"],
        pageType: "checkout"
      });
    }

    const payNowSession = sdkInstance.createPayPalOneTimePaymentSession({
      // commit defaults to true -> the sheet shows "Pay Now"
      async onApprove(data) {
        say("Capturing payment…");
        try {
          const res = await fetch(`/api/paypal/orders/${encodeURIComponent(data.orderId)}/capture`, { method: "POST" });
          const cap = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(cap.details || cap.error));
          Store.clearCart();
          window.location.href = `/status.html?type=paypal&id=${encodeURIComponent(data.orderId)}`;
        } catch (err) {
          say(`Capture failed: ${err.message}`, "error");
        }
      },
      onCancel() {
        say("PayPal checkout was cancelled. Nothing was charged.", "info");
      },
      onError(err) {
        console.error("PayPal Pay Now error:", err);
        say(`PayPal error: ${err && err.message ? err.message : err}`, "error");
      }
    });

    btn.removeAttribute("hidden");
    btn.addEventListener("click", async () => {
      say("", "");
      if (!cfg.getItems().length) {
        say("Your cart is empty.", "error");
        return;
      }
      const orderPromise = (async () => {
        const res = await fetch("/api/paypal/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            flow: "paynow",
            items: cfg.getItems(),
            state: cfg.getState ? cfg.getState() : undefined,
            shippingMethod: cfg.getShippingMethod ? cfg.getShippingMethod() : undefined,
            shipping: cfg.getShipping ? cfg.getShipping() : undefined,
            returnPath: location.pathname + location.search
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Order creation failed");
        return { orderId: data.id };
      })();
      try {
        await payNowSession.start({ presentationMode: "auto" }, orderPromise);
      } catch (err) {
        console.error("PayPal Pay Now start failed:", err);
        say(`Unable to open PayPal: ${err && err.message ? err.message : err}`, "error");
      }
    });
  }

  return { init, initPayNow, updateMessageAmount };
})();
