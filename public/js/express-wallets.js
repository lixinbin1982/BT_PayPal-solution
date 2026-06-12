/**
 * Express wallet buttons (Google Pay + Apple Pay) for the ECS flow.
 * Rendered on the product page and cart page next to the PayPal button.
 *
 * Same scenario as PayPal ECS (Continue flow):
 *   1. Open the wallet sheet with the ITEM TOTAL only (estimated).
 *   2. Read the shipping address the buyer picks INSIDE the wallet sheet.
 *   3. Recalculate shipping + tax for that address (POST /api/cart/price).
 *   4. Update the total shown in the sheet before the buyer authorizes.
 *   5. NOTHING is charged yet: the nonce + wallet shipping address are
 *      stashed and the buyer lands on the merchant REVIEW page
 *      (checkout.html?walletReview=1) to confirm before the sale.
 *
 * Google Pay: shippingAddressRequired + onPaymentDataChanged callback.
 * Apple Pay:  requiredShippingContactFields + onshippingcontactselected.
 */
const ExpressWallets = (() => {
  let getItems = null;
  let clientInstance = null;
  let deviceData = null;
  // "review": ECS continue flow -> merchant review page before the sale.
  // "direct": complete INSIDE the wallet sheet (shipping method picked via
  //           the sheet's callbacks), sale submitted right after authorize.
  let flow = "review";

  /**
   * Report a client-side SDK step to the API history console so the full
   * Braintree <-> Google sequence is visible, not just our server calls.
   * Fire-and-forget: logging must never break the payment flow.
   */
  function logStep(path, via, request, response, durationMs, from, to) {
    try {
      fetch("/api/logs/client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method: "SDK", path, via, request, response, durationMs, from, to })
      }).catch(() => {});
    } catch (_) { /* ignore */ }
  }

  const say = (msg, cls = "info") => {
    const el = document.getElementById("paypal-status"); // shared status strip
    if (!el) return;
    el.textContent = msg || "";
    el.className = msg ? `alert ${cls}` : "hidden";
  };

  // Price the cart for a given US state (region) + shipping method. Server
  // computes state-based tax + shipping (free over $150, AK/HI surcharge)
  // and returns all shippingOptions priced for that state.
  async function priceItems(state, shippingMethod) {
    const items = getItems();
    if (!items || !items.length) throw new Error("Your cart is empty.");
    const priced = await fetch("/api/cart/price", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items, state, shippingMethod })
    }).then((r) => r.json());
    if (priced.error) throw new Error(priced.error);
    return priced;
  }

  /** Direct flow: submit the sale immediately after the sheet authorizes. */
  async function submitNonce(nonce, label, shipping, shippingMethod) {
    say(`Processing ${label} payment…`);
    const res = await fetch("/api/braintree/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentMethodNonce: nonce,
        deviceData,
        items: getItems(),
        // Shipping address + method as selected in the wallet sheet
        shipping,
        shippingMethod: shippingMethod || "standard"
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      Store.clearCart();
      window.location.href = `/status.html?type=braintree&id=${encodeURIComponent(data.transaction.id)}`;
    } else {
      throw new Error(data.error || "Transaction failed");
    }
  }

  /** Per-flow handoff after the wallet sheet authorizes. */
  async function finish(nonce, label, shipping, shippingMethod) {
    if (flow === "direct") return submitNonce(nonce, label, shipping, shippingMethod);
    return goToReview(nonce, label, shipping, shippingMethod);
  }

  /**
   * ECS continue flow: do NOT charge here. Stash the wallet nonce + the
   * shipping address picked in the sheet, then send the buyer to the
   * merchant review page where they confirm before transaction.sale.
   */
  function goToReview(nonce, label, shipping, shippingMethod) {
    sessionStorage.setItem("lumenx_wallet_review", JSON.stringify({
      nonce,
      type: label,
      deviceData,
      // Stash the exact items being bought: on the product page this is the
      // viewed product (buy-now), NOT necessarily the cart contents.
      items: getItems(),
      shipping,
      shippingMethod: shippingMethod || "standard"
    }));
    window.location.href = "/checkout.html?walletReview=1";
  }

  /* ----------------------- Google Pay ----------------------- */
  async function initGooglePay(container) {
    if (!(await GPayLoader.ensure())) {
      console.warn(
        "Google Pay button skipped: pay.js did not load (CDN blocked by an " +
        "ad/privacy blocker and same-origin proxy /js/gpay.js also failed)."
      );
      return;
    }
    try {
      let t0 = Date.now();
      const gpInstance = await braintree.googlePayment.create({
        client: clientInstance,
        googlePayVersion: 2
      });
      // The KEY handshake: Braintree builds Google's PaymentDataRequest with a
      // PAYMENT_GATEWAY tokenizationSpecification (gateway: "braintree" +
      // merchant keys) so Google encrypts the card FOR Braintree.
      const baseRequest = gpInstance.createPaymentDataRequest();
      const cardMethod = baseRequest.allowedPaymentMethods[0] || {};
      logStep(
        "braintree.googlePayment.create()",
        "Braintree JS SDK",
        { client: "(clientInstance from /api/braintree/client-token)", googlePayVersion: 2 },
        {
          step: "1. Braintree generated Google's allowedPaymentMethods. tokenizationSpecification tells Google to encrypt the card FOR the Braintree gateway.",
          allowedCardNetworks: cardMethod.parameters && cardMethod.parameters.allowedCardNetworks,
          tokenizationSpecification: cardMethod.tokenizationSpecification
        },
        Date.now() - t0,
        "Browser (Braintree JS)",
        "local — built from the gateway config fetched in client.create()"
      );

      // Map server shippingOptions -> Google Pay shippingOptionParameters
      const toGpayOptions = (priced, selectedId) => ({
        defaultSelectedOptionId: selectedId || priced.shippingMethod,
        shippingOptions: priced.shippingOptions.map((o) => ({
          id: o.id,
          label: `${o.amount === "0.00" ? "FREE" : "$" + o.amount}: ${o.label}`,
          description: o.detail
        }))
      });

      // Dynamic updates: Google calls onPaymentDataChanged whenever the buyer
      // picks/changes the shipping ADDRESS or the shipping OPTION in the sheet.
      const paymentsClient = new google.payments.api.PaymentsClient({
        environment: "TEST", // sandbox
        paymentDataCallbacks: {
          onPaymentDataChanged: async (intermediate) => {
            const cb0 = Date.now();
            try {
              const state =
                intermediate.shippingAddress &&
                intermediate.shippingAddress.administrativeArea;
              const optionId =
                intermediate.shippingOptionData &&
                intermediate.shippingOptionData.id !== "shipping_option_unselected"
                  ? intermediate.shippingOptionData.id
                  : undefined;
              const priced = await priceItems(state, optionId);
              logStep(
                "google onPaymentDataChanged()",
                "Google Pay JS (callback)",
                {
                  step: "4. Buyer changed shipping address/option INSIDE the Google sheet. Google calls the merchant back to reprice.",
                  callbackTrigger: intermediate.callbackTrigger,
                  shippingAddress: intermediate.shippingAddress,
                  shippingOptionId: optionId
                },
                {
                  repricedVia: "POST /api/cart/price",
                  newTotal: priced.total,
                  shipping: priced.shipping,
                  tax: priced.tax,
                  shippingMethod: priced.shippingMethod
                },
                Date.now() - cb0,
                "pay.google.com (Google Pay sheet)",
                "Browser callback → Merchant Server (POST /api/cart/price) → back to the sheet"
              );
              return {
                newShippingOptionParameters: toGpayOptions(priced, priced.shippingMethod),
                newTransactionInfo: {
                  totalPriceStatus: "FINAL",
                  totalPrice: priced.total,
                  currencyCode: "USD",
                  displayItems: [
                    { label: "Subtotal", type: "SUBTOTAL", price: priced.itemTotal },
                    { label: "Shipping", type: "LINE_ITEM", price: priced.shipping },
                    { label: "Tax", type: "TAX", price: priced.tax }
                  ]
                }
              };
            } catch (err) {
              return {
                error: {
                  reason: "SHIPPING_ADDRESS_UNSERVICEABLE",
                  message: err.message || "Cannot price for this address",
                  intent: "SHIPPING_ADDRESS"
                }
              };
            }
          }
        }
      });

      t0 = Date.now();
      const ready = await paymentsClient.isReadyToPay({
        apiVersion: 2,
        apiVersionMinor: 0,
        allowedPaymentMethods: baseRequest.allowedPaymentMethods,
        existingPaymentMethodRequired: false
      });
      logStep(
        "google isReadyToPay()",
        "Google Pay JS",
        {
          step: "2. Merchant asks Google (env: TEST) if this browser/device can pay with the Braintree-tokenized card methods.",
          allowedPaymentMethods: baseRequest.allowedPaymentMethods
        },
        ready,
        Date.now() - t0,
        "Browser (Google Pay JS)",
        "pay.google.com (Google Pay API)"
      );
      // Google's isReadyToPay resolves to { result: boolean }
      if (!ready.result) return;

      const btn = paymentsClient.createButton({
        buttonType: "checkout",
        buttonColor: "white", // white button stands out on the dark theme
        buttonSizeMode: "fill",
        onClick: async () => {
          try {
            // Open the sheet with item total only — ESTIMATED until the
            // shipping address/option callbacks finalize shipping + tax.
            const priced = await priceItems();
            const paymentDataRequest = gpInstance.createPaymentDataRequest({
              transactionInfo: {
                totalPriceStatus: "ESTIMATED",
                totalPrice: priced.itemTotal,
                currencyCode: "USD"
              },
              shippingAddressRequired: true,
              shippingAddressParameters: { phoneNumberRequired: false },
              shippingOptionRequired: true,
              shippingOptionParameters: toGpayOptions(priced),
              callbackIntents: ["SHIPPING_ADDRESS", "SHIPPING_OPTION"],
              emailRequired: true
            });
            logStep(
              "google loadPaymentData()",
              "Google Pay JS",
              {
                step: "3. Open the Google Pay sheet. Total is ESTIMATED (items only); callbackIntents let Google call us back for shipping address/option repricing.",
                transactionInfo: paymentDataRequest.transactionInfo,
                callbackIntents: paymentDataRequest.callbackIntents,
                shippingOptionParameters: paymentDataRequest.shippingOptionParameters,
                tokenizationSpecification:
                  paymentDataRequest.allowedPaymentMethods[0].tokenizationSpecification
              },
              { note: "sheet opened — buyer is selecting card + shipping" },
              undefined,
              "Browser (Google Pay JS)",
              "pay.google.com (Google Pay sheet)"
            );
            let tLoad = Date.now();
            const paymentData = await paymentsClient.loadPaymentData(paymentDataRequest);
            const gToken = paymentData.paymentMethodData && paymentData.paymentMethodData.tokenizationData;
            logStep(
              "google paymentData (buyer authorized)",
              "Google Pay JS",
              { step: "5. Buyer authorized in the sheet. Google returns final shipping + an ENCRYPTED payment token only Braintree can decrypt." },
              {
                email: paymentData.email,
                shippingAddress: paymentData.shippingAddress,
                shippingOptionId: paymentData.shippingOptionData && paymentData.shippingOptionData.id,
                cardInfo: paymentData.paymentMethodData && paymentData.paymentMethodData.info,
                tokenizationData: gToken && {
                  type: gToken.type, // PAYMENT_GATEWAY
                  token: String(gToken.token || "").slice(0, 120) + "… (truncated, encrypted for Braintree)"
                }
              },
              Date.now() - tLoad,
              "pay.google.com (Google Pay sheet)",
              "Browser — token is encrypted for the Braintree gateway, the merchant cannot read it"
            );
            tLoad = Date.now();
            const result = await gpInstance.parseResponse(paymentData);
            logStep(
              "braintree.googlePayment.parseResponse()",
              "Braintree JS SDK",
              { step: "6. Braintree JS sends Google's encrypted token to the Braintree gateway, which decrypts it and returns a single-use payment method NONCE." },
              {
                nonce: result.nonce,
                type: result.type,
                details: result.details,
                next: "7. Nonce goes to OUR server -> POST /api/braintree/checkout -> braintree.transaction.sale (see next entries)"
              },
              Date.now() - tLoad,
              "Browser (Braintree JS)",
              "api.sandbox.braintreegateway.com (Braintree Gateway — decrypts Google token, mints nonce)"
            );

            // Map the Google Pay shipping address + selected option -> sale
            const a = paymentData.shippingAddress || {};
            const nameParts = String(a.name || "Google Buyer").split(" ");
            const chosenOption =
              (paymentData.shippingOptionData && paymentData.shippingOptionData.id) || "standard";
            await finish(result.nonce, "Google Pay", {
              firstName: nameParts[0] || "Google",
              lastName: nameParts.slice(1).join(" ") || "Buyer",
              streetAddress: a.address1 || "",
              extendedAddress: a.address2 || "",
              locality: a.locality || "",
              region: a.administrativeArea || "",
              postalCode: a.postalCode || "",
              countryCode: a.countryCode || "US"
            }, chosenOption);
          } catch (err) {
            if (err && err.statusCode === "CANCELED") return; // buyer closed sheet
            console.error("Google Pay error:", err);
            say(`Google Pay: ${err.message || err.statusCode || err}`, "error");
          }
        }
      });
      container.appendChild(btn);
      container.classList.remove("hidden");
    } catch (err) {
      console.warn("Google Pay unavailable:", err);
    }
  }

  /* ----------------------- Apple Pay ----------------------- */
  async function initApplePay(container) {
    // Safari exposes ApplePaySession natively; in third-party browsers
    // (Chrome/Edge/Firefox) it comes from the Apple Pay JS SDK script
    // (apple-pay-sdk.js), which since iOS 18 supports a QR-code handoff to
    // the buyer's iPhone. Either way: HTTPS + verified domain required.
    if (!window.ApplePaySession) return;
    if (!ApplePaySession.canMakePayments()) return;
    try {
      const apInstance = await braintree.applePay.create({ client: clientInstance });

      const btn = document.createElement("button");
      btn.className = "apple-pay-btn";
      btn.setAttribute("aria-label", "Apple Pay");
      btn.addEventListener("click", async () => {
        try {
          // Open the sheet with item total only; shipping + tax are added
          // once the buyer's shipping address is known.
          const base = await priceItems();
          const toAppleMethods = (priced) =>
            priced.shippingOptions.map((o) => ({
              identifier: o.id,
              label: o.label,
              detail: o.detail,
              amount: o.amount
            }));
          const request = apInstance.createPaymentRequest({
            total: { label: "LumenX Tactical", amount: base.itemTotal, type: "pending" },
            shippingMethods: toAppleMethods(base),
            requiredBillingContactFields: ["postalAddress"],
            requiredShippingContactFields: ["postalAddress", "name", "email"]
          });
          const session = new ApplePaySession(3, request);
          let lastPriced = base;
          let selectedMethod = base.shippingMethod || "standard";
          let lastState = undefined;

          session.onvalidatemerchant = async (event) => {
            try {
              const merchantSession = await apInstance.performValidation({
                validationURL: event.validationURL,
                displayName: "LumenX Tactical"
              });
              session.completeMerchantValidation(merchantSession);
            } catch (err) {
              console.error("Apple Pay merchant validation failed:", err);
              say("Apple Pay merchant validation failed (domain must be registered in the Braintree control panel).", "error");
              session.abort();
            }
          };

          const lineItems = (p) => [
            { label: "Subtotal", amount: p.itemTotal },
            { label: "Shipping", amount: p.shipping },
            { label: "Tax", amount: p.tax }
          ];

          // Buyer picked/changed a shipping address in the sheet:
          // recalculate shipping + tax and re-price the shipping methods.
          session.onshippingcontactselected = async (event) => {
            try {
              lastState = event.shippingContact && event.shippingContact.administrativeArea;
              lastPriced = await priceItems(lastState, selectedMethod);
              session.completeShippingContactSelection({
                newShippingMethods: toAppleMethods(lastPriced),
                newTotal: { label: "LumenX Tactical", amount: lastPriced.total },
                newLineItems: lineItems(lastPriced)
              });
            } catch (err) {
              session.completeShippingContactSelection({
                errors: [new ApplePayError("shippingContactInvalid", "postalAddress", err.message || "Cannot ship to this address")],
                newTotal: { label: "LumenX Tactical", amount: lastPriced.total }
              });
            }
          };

          // Buyer picked a shipping method (Standard / Express / Overnight)
          session.onshippingmethodselected = async (event) => {
            try {
              selectedMethod = (event.shippingMethod && event.shippingMethod.identifier) || selectedMethod;
              lastPriced = await priceItems(lastState, selectedMethod);
              session.completeShippingMethodSelection({
                newTotal: { label: "LumenX Tactical", amount: lastPriced.total },
                newLineItems: lineItems(lastPriced)
              });
            } catch (err) {
              session.completeShippingMethodSelection({
                newTotal: { label: "LumenX Tactical", amount: lastPriced.total }
              });
            }
          };

          session.onpaymentauthorized = async (event) => {
            try {
              const payload = await apInstance.tokenize({ token: event.payment.token });
              session.completePayment(ApplePaySession.STATUS_SUCCESS);

              // Map the Apple Pay shipping contact -> Braintree shipping
              const c = event.payment.shippingContact || {};
              const lines = c.addressLines || [];
              await finish(payload.nonce, "Apple Pay", {
                firstName: c.givenName || "Apple",
                lastName: c.familyName || "Buyer",
                streetAddress: lines[0] || "",
                extendedAddress: lines[1] || "",
                locality: c.locality || "",
                region: c.administrativeArea || "",
                postalCode: c.postalCode || "",
                countryCode: (c.countryCode || "US").toUpperCase()
              }, selectedMethod);
            } catch (err) {
              session.completePayment(ApplePaySession.STATUS_FAILURE);
              say(`Apple Pay: ${err.message || err}`, "error");
            }
          };

          session.begin();
        } catch (err) {
          console.error("Apple Pay error:", err);
          say(`Apple Pay: ${err.message || err}`, "error");
        }
      });
      container.appendChild(btn);
      container.classList.remove("hidden");
    } catch (err) {
      console.warn("Apple Pay unavailable:", err);
    }
  }

  /* ----------------------- init ----------------------- */
  async function init(opts) {
    getItems = opts.getItems;
    flow = opts.flow || "review";
    const wrap = document.getElementById("express-wallets");
    if (!wrap) return;
    try {
      const { clientToken } = await fetch("/api/braintree/client-token").then((r) => r.json());
      const tClient = Date.now();
      clientInstance = await braintree.client.create({ authorization: clientToken });
      logStep(
        "braintree.client.create()",
        "Braintree JS SDK",
        {
          step: "0. Browser authenticates to the Braintree gateway with the client token minted by OUR server (GET /api/braintree/client-token).",
          authorization: "(clientToken, truncated) " + String(clientToken).slice(0, 24) + "…"
        },
        { clientInstance: "ready — used by googlePayment/applePay/dataCollector components" },
        Date.now() - tClient,
        "Browser (Braintree JS)",
        "api.sandbox.braintreegateway.com (Braintree Gateway — fetch gateway configuration)"
      );
      try {
        const dc = await braintree.dataCollector.create({ client: clientInstance });
        deviceData = dc.deviceData;
      } catch (e) { /* non-fatal */ }

      const gpContainer = document.getElementById("googlepay-button");
      const apContainer = document.getElementById("applepay-button");
      await Promise.all([
        gpContainer ? initGooglePay(gpContainer) : null,
        apContainer ? initApplePay(apContainer) : null
      ]);
    } catch (err) {
      console.warn("Express wallets unavailable:", err);
    }
  }

  return { init };
})();
