/**
 * Braintree checkout integration (Braintree JS SDKs):
 *  - Fastlane (accelerated guest checkout): braintree-web client + data-collector
 *    + fastlane component. Email lookup -> OTP for members -> saved card; guests
 *    get the Fastlane card component and are enrolled.
 *  - Drop-in UI: card + Venmo + Google Pay + Apple Pay in one widget.
 *  - Both paths produce a payment method nonce -> POST /api/braintree/checkout
 *    (server uses the Braintree Node Server SDK transaction.sale).
 */
const BTCheckout = (() => {
  let clientToken = null;
  let clientInstance = null;
  let deviceData = null;
  let dropinInstance = null;
  let fastlaneInstance = null;
  let fastlanePaymentComponent = null;
  let priced = null;

  const $ = (s) => document.querySelector(s);
  const show = (s) => $(s) && $(s).classList.remove("hidden");
  const hide = (s) => $(s) && $(s).classList.add("hidden");
  const say = (msg, cls = "info") => {
    const el = $("#bt-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = msg ? `alert ${cls}` : "hidden";
  };

  async function init(pricedCart) {
    priced = pricedCart;
    const res = await fetch("/api/braintree/client-token").then((r) => r.json());
    clientToken = res.clientToken;

    clientInstance = await braintree.client.create({ authorization: clientToken });

    // Device data (fraud tools) - used by Venmo and Fastlane
    try {
      const dc = await braintree.dataCollector.create({ client: clientInstance });
      deviceData = dc.deviceData;
    } catch (e) {
      console.warn("dataCollector unavailable:", e);
    }

    await Promise.all([initFastlane(), initDropin()]);
  }

  /* ----------------------- Fastlane ----------------------- */
  async function initFastlane() {
    try {
      // Must be set BEFORE fastlane.create so the component targets the
      // sandbox identity environment.
      window.localStorage.setItem("fastlaneEnv", "sandbox");
      fastlaneInstance = await braintree.fastlane.create({
        authorization: clientToken,
        client: clientInstance,
        deviceData
      });

      // Watermark ("Powered by PayPal / Fastlane")
      try {
        const watermark = fastlaneInstance.FastlaneWatermarkComponent
          ? await fastlaneInstance.FastlaneWatermarkComponent({ includeAdditionalInfo: true })
          : null;
        if (watermark) watermark.render("#fastlane-watermark");
      } catch (e) { /* non-fatal */ }

      show("#fastlane-section");
      wireAutoLookup();
    } catch (err) {
      console.error("Fastlane init failed:", err);
      const el = $("#fastlane-unavailable");
      if (el) {
        el.textContent = `Fastlane could not be initialized: ${err && (err.message || err.code) || err}`;
        el.classList.remove("hidden");
      }
    }
  }

  /**
   * Auto-trigger the Fastlane email lookup (no button): fires directly while
   * typing — as soon as the input contains a valid email (debounced), plus on
   * blur / Enter / autofill change as fallbacks.
   */
  let lastLookedUpEmail = null;
  let lookupDebounce = null;
  function wireAutoLookup() {
    const input = $("#fastlane-email");
    if (!input) return;
    const maybeLookup = () => {
      const email = input.value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
      if (email === lastLookedUpEmail) return; // don't re-run the same email
      lastLookedUpEmail = email;
      fastlaneLookup();
    };
    // Lookup directly once a complete email has been entered (debounced so
    // we don't fire on every keystroke mid-typing).
    input.addEventListener("input", () => {
      clearTimeout(lookupDebounce);
      lookupDebounce = setTimeout(maybeLookup, 700);
    });
    input.addEventListener("blur", maybeLookup);
    input.addEventListener("change", maybeLookup); // browser autofill
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); maybeLookup(); }
    });
  }

  /** Email lookup: members get OTP auth + saved profile; guests get card form. */
  async function fastlaneLookup() {
    const email = $("#fastlane-email").value.trim();
    if (!email) return;
    if (!fastlaneInstance) return say("Fastlane is not available on this account.", "error");
    show("#fastlane-lookup-spinner");
    say("Looking up Fastlane profile…");

    try {
      const { identity } = fastlaneInstance;
      const lookup = await identity.lookupCustomerByEmail(email);

      let profileData = null;
      if (lookup && lookup.customerContextId) {
        // Recognized Fastlane member -> OTP authentication flow
        const auth = await identity.triggerAuthenticationFlow(lookup.customerContextId);
        if (auth && auth.authenticationState === "succeeded") {
          profileData = auth.profileData;
          say(`Welcome back! Fastlane profile found for ${email}.`, "success");
        } else {
          say("Fastlane authentication was not completed - continuing as guest.", "info");
        }
      } else {
        say("No Fastlane profile found - continue as guest and you can be enrolled.", "info");
      }

      // Render the Fastlane payment component (members: saved card, guests: card form)
      const options = profileData && profileData.card ? {} : { fields: { phoneNumber: { prefill: "" } } };
      fastlanePaymentComponent = await fastlaneInstance.FastlanePaymentComponent({
        options,
        ...(profileData && profileData.shippingAddress
          ? { shippingAddress: profileData.shippingAddress }
          : {})
      });
      $("#fastlane-payment-container").innerHTML = "";
      await fastlanePaymentComponent.render("#fastlane-payment-container");
      show("#fastlane-pay-wrap");
      if (profileData && profileData.shippingAddress) {
        prefillShipping(profileData);
      }
    } catch (err) {
      console.error("Fastlane lookup error:", err);
      say(`Fastlane error: ${err.message || err}`, "error");
    } finally {
      hide("#fastlane-lookup-spinner");
    }
  }

  /**
   * Step 1 -> Step 2: on successful Fastlane lookup, copy the saved shipping
   * address from the Fastlane profile into the shipping form, then trigger a
   * re-price (shipping fee + tax for the profile's state).
   */
  function prefillShipping(profileData) {
    const a = profileData.shippingAddress || {};
    const name = a.name || {};
    const setVal = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
    setVal("ship-first", name.firstName);
    setVal("ship-last", name.lastName);
    setVal("ship-street", (a.address && a.address.addressLine1) || a.addressLine1);
    setVal("ship-city", (a.address && a.address.adminArea2) || a.adminArea2);
    setVal("ship-state", (a.address && a.address.adminArea1) || a.adminArea1);
    setVal("ship-zip", (a.address && a.address.postalCode) || a.postalCode);
    show("#fastlane-prefilled");
    // Recalculate totals for the Fastlane address (checkout page listens for this)
    const st = document.getElementById("ship-state");
    if (st) st.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function payWithFastlane() {
    if (!fastlanePaymentComponent) return;
    try {
      say("Tokenizing with Fastlane…");
      const tokenResult = await fastlanePaymentComponent.getPaymentToken({
        billingAddress: null
      });
      const nonce = tokenResult && (tokenResult.id || tokenResult.nonce);
      if (!nonce) throw new Error("Fastlane did not return a payment token");
      await submitToServer(nonce, "Fastlane");
    } catch (err) {
      console.error(err);
      say(`Fastlane payment error: ${err.message || err}`, "error");
    }
  }

  /* ----------------------- Drop-in ----------------------- */
  async function initDropin() {
    // Drop-in's Google Pay also needs pay.js — load via same-origin proxy
    // if the CDN tag was blocked by an ad/privacy extension.
    if (window.GPayLoader) await GPayLoader.ensure();
    const total = priced ? priced.total : "0.00";
    try {
      dropinInstance = await braintree.dropin.create({
        authorization: clientToken,
        container: "#dropin-container",
        dataCollector: true,
        // Venmo (US mobile + desktop QR)
        venmo: { allowDesktop: true, paymentMethodUsage: "single_use" },
        // Google Pay (sandbox TEST environment)
        googlePay: {
          googlePayVersion: 2,
          transactionInfo: {
            totalPriceStatus: "FINAL",
            totalPrice: total,
            currencyCode: "USD"
          },
          allowedPaymentMethods: [
            {
              type: "CARD",
              parameters: {
                billingAddressRequired: false
              }
            }
          ]
        },
        // Apple Pay (shows only in Safari on Apple devices over HTTPS
        // with a registered/verified domain)
        applePay: {
          displayName: "LumenX Tactical",
          paymentRequest: {
            total: { label: "LumenX Tactical", amount: total },
            requiredBillingContactFields: ["postalAddress"]
          }
        },
        // Cards
        card: {
          cardholderName: { required: false }
        }
      });
    } catch (err) {
      // Drop-in still renders the methods that ARE available; full failure here
      // usually means a config problem.
      console.error("Drop-in create error:", err);
      say(`Drop-in error: ${err.message || err}`, "error");
      return;
    }
    $("#dropin-pay-btn").disabled = false;
  }

  async function payWithDropin() {
    if (!dropinInstance) return;
    const btn = $("#dropin-pay-btn");
    btn.disabled = true;
    say("Requesting payment method…");
    try {
      const payload = await dropinInstance.requestPaymentMethod();
      await submitToServer(payload.nonce, payload.type, payload.deviceData);
    } catch (err) {
      console.error(err);
      say(`${err.message || "Please choose a payment method."}`, "error");
      btn.disabled = false;
    }
  }

  /* ----------------------- Server sale ----------------------- */
  async function submitToServer(nonce, methodLabel, payloadDeviceData) {
    say(`Processing ${methodLabel} payment…`);
    const shipping = {
      firstName: val("ship-first"),
      lastName: val("ship-last"),
      streetAddress: val("ship-street"),
      locality: val("ship-city"),
      region: val("ship-state"),
      postalCode: val("ship-zip"),
      countryCode: "US"
    };
    const res = await fetch("/api/braintree/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentMethodNonce: nonce,
        deviceData: payloadDeviceData || deviceData,
        items: Store.cartItems(),
        shipping,
        shippingMethod: (document.querySelector('input[name="ship-method"]:checked') || {}).value || "standard"
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      Store.clearCart();
      window.location.href = `/status.html?type=braintree&id=${encodeURIComponent(data.transaction.id)}`;
    } else {
      say(`Transaction failed: ${data.error || "unknown error"}`, "error");
      if (dropinInstance) {
        try { dropinInstance.clearSelectedPaymentMethod(); } catch (e) {}
      }
      const btn = $("#dropin-pay-btn");
      if (btn) btn.disabled = false;
    }
  }

  function val(id) { const el = document.getElementById(id); return el ? el.value : ""; }

  /**
   * Re-price after the buyer edits the shipping address (state): updates the
   * totals that Drop-in passes to Google Pay / Apple Pay sheets.
   */
  function updatePriced(newPriced) {
    priced = newPriced;
    if (!dropinInstance) return;
    try {
      dropinInstance.updateConfiguration("googlePay", "transactionInfo", {
        totalPriceStatus: "FINAL",
        totalPrice: newPriced.total,
        currencyCode: "USD"
      });
      dropinInstance.updateConfiguration("applePay", "paymentRequest", {
        total: { label: "LumenX Tactical", amount: newPriced.total }
      });
    } catch (e) { /* non-fatal */ }
  }

  return { init, fastlaneLookup, payWithFastlane, payWithDropin, updatePriced };
})();
