import Foundation
import PassKit
import Contacts
import BraintreeApplePay

/// Orchestrates the Apple Pay ECS sequence (Braintree iOS SDK v7).
///
/// Two modes:
///  - **Mock**: runs the REAL API calls that work anywhere (client token,
///    isApplePaySupported, makePaymentRequest, cart pricing, transaction.sale
///    via the sandbox fake Apple Pay nonce) and SIMULATES the PassKit sheet
///    callbacks — including the redacted→full address transition. Works in the
///    simulator with zero Apple Pay entitlement setup.
///  - **Real**: presents the actual PKPaymentAuthorizationController. Requires
///    Apple Merchant ID + Braintree Control Panel registration + the Apple Pay
///    capability (see README).
final class ApplePayECSManager: NSObject, ObservableObject {
    @Published var busy = false
    @Published var result: String?

    let console: APIConsole
    private var applePayClient: BTApplePayClient?
    private var pricing: StoreAPI.CartPricing?
    private var shippingMethodID = "standard"
    private var controller: PKPaymentAuthorizationController?

    init(console: APIConsole) {
        self.console = console
    }

    // MARK: - Mock flow (simulated sheet, real gateway calls)

    func runMockFlow() {
        guard !busy else { return }
        setBusy(true)
        Task {
            await mockFlow()
            setBusy(false)
        }
    }

    private func mockFlow() async {
        console.clear()
        setResult(nil)
        do {
            // Steps 1–3: client token
            console.log("1", "App → Server", "GET /api/braintree/client-token")
            let token = try await StoreAPI.clientToken()
            console.log("3", "Server → App", "client token",
                        String(token.prefix(20)) + "…", state: .response)

            // Steps 4–5: init client + availability
            console.log("4", "App → BT SDK",
                        "BTApplePayClient(authorization:) · isApplePaySupported()")
            let client = BTApplePayClient(authorization: token)
            applePayClient = client
            let supported = await client.isApplePaySupported()
            console.log("5", "BT SDK → Gateway", "fetch merchant configuration",
                        "applePay enabled on merchant: \(supported ? "yes" : "no (or device can't pay — fine in Mock mode)")",
                        state: .response)

            // Steps 6–7: makePaymentRequest (real BT config call)
            console.log("6", "App → BT SDK", "makePaymentRequest()")
            do {
                let request = try await client.makePaymentRequest()
                console.log("7", "BT SDK → App", "PKPaymentRequest",
                            "merchantId=\(request.merchantIdentifier) · networks=\(request.supportedNetworks.map(\.rawValue).joined(separator: ",")) · \(request.countryCode)/\(request.currencyCode)",
                            state: .response)
            } catch {
                console.log("7", "BT SDK → App", "PKPaymentRequest (skipped)",
                            error.localizedDescription, state: .response)
            }

            // Step 8: configure required fields (THE step that yields addresses)
            console.log("8", "App (local)",
                        "set requiredShipping/BillingContactFields + shippingMethods + summaryItems",
                        "shipping: [postalAddress, name, email, phone] · billing: [postalAddress]")
            shippingMethodID = "standard"
            var p = try await StoreAPI.price(state: "CA", shippingMethod: shippingMethodID)
            pricing = p

            // Step 9: present (simulated)
            console.log("9", "App → PassKit",
                        "PKPaymentAuthorizationController.present()", "[mock sheet]")
            try await pause()

            // Steps 10–12: address selected → REDACTED contact
            console.log("10", "Buyer → Sheet", "select shipping address")
            let redacted = Self.mockRedactedContact()
            let ra = redacted.postalAddress!
            console.log("11", "Sheet → App", "didSelectShippingContact(PKContact)",
                        "REDACTED: zip=\(ra.postalCode) city=\(ra.city) state=\(ra.state) country=\(ra.isoCountryCode) — street & name withheld pre-auth",
                        state: .redacted)
            p = try await StoreAPI.price(state: ra.state, shippingMethod: shippingMethodID)
            pricing = p
            console.log("12", "App → Sheet", "PKPaymentRequestShippingContactUpdate",
                        "items $\(p.itemTotal) + ship $\(p.shipping) + tax $\(p.tax) = $\(p.total)",
                        state: .response)
            try await pause()

            // Steps 13–14: shipping method picked
            console.log("13", "Buyer → Sheet", "pick shipping method: Express")
            shippingMethodID = "express"
            p = try await StoreAPI.price(state: ra.state, shippingMethod: shippingMethodID)
            pricing = p
            console.log("14", "Sheet → App",
                        "didSelectShippingMethod → PKPaymentRequestShippingMethodUpdate",
                        "new total $\(p.total)", state: .redacted)
            try await pause()

            // Steps 15–16: authorization → FULL contact
            console.log("15", "Buyer → Sheet", "authorize (Face ID / Touch ID) [mock]")
            let full = Self.mockFullContact()
            let fa = full.postalAddress!
            console.log("16", "Sheet → App", "didAuthorizePayment(PKPayment)",
                        "FULL: \(full.name!.givenName!) \(full.name!.familyName!), \(fa.street), \(fa.city) \(fa.state) \(fa.postalCode) \(fa.isoCountryCode) · \(full.emailAddress!) · \(full.phoneNumber!.stringValue)",
                        state: .full)

            // Steps 17–19: tokenize — mocked (a real encrypted PKPayment token
            // only exists on Apple hardware after true authorization)
            console.log("17", "App → BT SDK", "tokenize(payment)",
                        "[mock: substituting sandbox \(Config.mockApplePayNonce)]")
            let nonce = Config.mockApplePayNonce
            console.log("19", "BT SDK → App", "BTApplePayCardNonce",
                        "nonce=\(nonce) — note: the nonce carries NO address",
                        state: .response)

            // Steps 20–21: REAL sandbox transaction with the extracted address
            console.log("20", "App → Server", "POST /api/braintree/checkout",
                        "nonce + shipping address extracted from PKPayment", state: .full)
            let tx = try await StoreAPI.checkout(
                nonce: nonce, shippingMethod: shippingMethodID,
                shipping: Self.shippingPayload(from: full))
            console.log("21", "Server → Gateway", "gateway.transaction.sale(...)",
                        "id=\(tx.id) · status=\(tx.status) · $\(tx.amount)", state: .full)

            // Step 22: close the sheet
            console.log("22", "App → Sheet", "PKPaymentAuthorizationResult(.success)",
                        state: .response)
            setResult("✅ Sandbox transaction \(tx.id) — $\(tx.amount) (check the Braintree Control Panel)")
        } catch {
            console.log("✕", "error", "flow aborted", error.localizedDescription)
            setResult("❌ \(error.localizedDescription)")
        }
    }

    // MARK: - Real flow (actual Apple Pay sheet; needs merchant ID setup)

    func runRealFlow() {
        guard !busy else { return }
        setBusy(true)
        Task {
            await realFlow()
            // busy cleared by the delegate when the sheet finishes
        }
    }

    private func realFlow() async {
        console.clear()
        setResult(nil)
        do {
            console.log("1", "App → Server", "GET /api/braintree/client-token")
            let token = try await StoreAPI.clientToken()
            console.log("3", "Server → App", "client token", state: .response)

            let client = BTApplePayClient(authorization: token)
            applePayClient = client
            console.log("4", "App → BT SDK", "isApplePaySupported()")
            guard await client.isApplePaySupported() else {
                console.log("✕", "BT SDK", "Apple Pay not available",
                            "Enable Apple Pay on the BT merchant account, add the Apple Pay capability + Merchant ID in Xcode, and test on a device/simulator with a card in Wallet.")
                setResult("❌ Apple Pay unavailable — see console / README")
                setBusy(false)
                return
            }

            console.log("6", "App → BT SDK", "makePaymentRequest()")
            let request = try await client.makePaymentRequest()
            console.log("7", "BT SDK → App", "PKPaymentRequest",
                        "merchantId=\(request.merchantIdentifier)", state: .response)

            request.requiredShippingContactFields = [.postalAddress, .name, .emailAddress, .phoneNumber]
            request.requiredBillingContactFields = [.postalAddress]
            shippingMethodID = "standard"
            let p = try await StoreAPI.price(state: "CA", shippingMethod: shippingMethodID)
            pricing = p
            request.shippingMethods = Self.pkShippingMethods()
            request.paymentSummaryItems = Self.summaryItems(p)
            console.log("8", "App (local)", "configure PKPaymentRequest",
                        "required fields + shipping methods + summary items")

            console.log("9", "App → PassKit", "PKPaymentAuthorizationController.present()")
            let c = PKPaymentAuthorizationController(paymentRequest: request)
            c.delegate = self
            controller = c
            let shown = await c.present()
            if !shown {
                console.log("✕", "PassKit", "sheet did not present",
                            "Usually a missing Apple Pay entitlement / Merchant ID mismatch.")
                setResult("❌ Sheet failed to present — see README setup steps")
                setBusy(false)
            }
        } catch {
            console.log("✕", "error", "flow aborted", error.localizedDescription)
            setResult("❌ \(error.localizedDescription)")
            setBusy(false)
        }
    }

    // MARK: - helpers

    private func pause() async throws {
        try await Task.sleep(nanoseconds: 700_000_000)
    }

    private func setBusy(_ v: Bool) {
        DispatchQueue.main.async { self.busy = v }
    }

    private func setResult(_ s: String?) {
        DispatchQueue.main.async { self.result = s }
    }

    static func shippingPayload(from contact: PKContact) -> [String: String] {
        let a = contact.postalAddress
        return [
            "firstName": contact.name?.givenName ?? "",
            "lastName": contact.name?.familyName ?? "",
            "streetAddress": a?.street ?? "",
            "locality": a?.city ?? "",
            "region": a?.state ?? "",
            "postalCode": a?.postalCode ?? "",
            "countryCode": a?.isoCountryCode.uppercased() ?? "US"
        ]
    }

    static func pkShippingMethods() -> [PKShippingMethod] {
        // Mirrors server SHIPPING_METHODS (server re-prices authoritatively)
        let defs: [(String, String, String)] = [
            ("standard", "Standard (5–7 days)", "5.99"),
            ("express", "Express (2–3 days)", "14.99"),
            ("overnight", "Overnight", "29.99")
        ]
        return defs.map { id, label, amount in
            let m = PKShippingMethod(label: label, amount: NSDecimalNumber(string: amount))
            m.identifier = id
            m.detail = ""
            return m
        }
    }

    static func summaryItems(_ p: StoreAPI.CartPricing) -> [PKPaymentSummaryItem] {
        [
            PKPaymentSummaryItem(label: "Items", amount: NSDecimalNumber(string: p.itemTotal)),
            PKPaymentSummaryItem(label: "Shipping", amount: NSDecimalNumber(string: p.shipping)),
            PKPaymentSummaryItem(label: "Tax", amount: NSDecimalNumber(string: p.tax)),
            PKPaymentSummaryItem(label: "LumenX Tactical", amount: NSDecimalNumber(string: p.total))
        ]
    }

    static func mockRedactedContact() -> PKContact {
        // What Apple actually sends pre-authorization: no street, no name
        let c = PKContact()
        let a = CNMutablePostalAddress()
        a.city = "San Jose"
        a.state = "CA"
        a.postalCode = "95131"
        a.isoCountryCode = "US"
        c.postalAddress = a
        return c
    }

    static func mockFullContact() -> PKContact {
        let c = PKContact()
        var n = PersonNameComponents()
        n.givenName = "Jane"
        n.familyName = "Appleseed"
        c.name = n
        c.emailAddress = "jane.appleseed@example.com"
        c.phoneNumber = CNPhoneNumber(stringValue: "+1 408 555 0100")
        let a = CNMutablePostalAddress()
        a.street = "1 Infinite Loop"
        a.city = "Cupertino"
        a.state = "CA"
        a.postalCode = "95014"
        a.isoCountryCode = "US"
        c.postalAddress = a
        return c
    }
}

// MARK: - PKPaymentAuthorizationControllerDelegate (Real mode)

extension ApplePayECSManager: PKPaymentAuthorizationControllerDelegate {

    func paymentAuthorizationController(
        _ controller: PKPaymentAuthorizationController,
        didSelectShippingContact contact: PKContact,
        handler completion: @escaping (PKPaymentRequestShippingContactUpdate) -> Void
    ) {
        let state = contact.postalAddress?.state ?? "CA"
        console.log("11", "Sheet → App", "didSelectShippingContact(PKContact)",
                    "REDACTED: zip=\(contact.postalAddress?.postalCode ?? "?") state=\(state) — street/name withheld",
                    state: .redacted)
        Task {
            do {
                let p = try await StoreAPI.price(state: state, shippingMethod: self.shippingMethodID)
                self.pricing = p
                self.console.log("12", "App → Sheet", "ShippingContactUpdate",
                                 "total $\(p.total)", state: .response)
                completion(PKPaymentRequestShippingContactUpdate(
                    errors: nil,
                    paymentSummaryItems: Self.summaryItems(p),
                    shippingMethods: Self.pkShippingMethods()))
            } catch {
                completion(PKPaymentRequestShippingContactUpdate(
                    errors: [error], paymentSummaryItems: [], shippingMethods: []))
            }
        }
    }

    func paymentAuthorizationController(
        _ controller: PKPaymentAuthorizationController,
        didSelectShippingMethod shippingMethod: PKShippingMethod,
        handler completion: @escaping (PKPaymentRequestShippingMethodUpdate) -> Void
    ) {
        shippingMethodID = shippingMethod.identifier ?? "standard"
        console.log("14", "Sheet → App", "didSelectShippingMethod",
                    shippingMethodID, state: .redacted)
        Task {
            let p = (try? await StoreAPI.price(state: "CA", shippingMethod: self.shippingMethodID))
                ?? self.pricing
            if let p { self.pricing = p }
            completion(PKPaymentRequestShippingMethodUpdate(
                paymentSummaryItems: p.map(Self.summaryItems) ?? []))
        }
    }

    func paymentAuthorizationController(
        _ controller: PKPaymentAuthorizationController,
        didAuthorizePayment payment: PKPayment,
        handler completion: @escaping (PKPaymentAuthorizationResult) -> Void
    ) {
        let ship = payment.shippingContact
        let a = ship?.postalAddress
        console.log("16", "Sheet → App", "didAuthorizePayment(PKPayment)",
                    "FULL: \(a?.street ?? "?"), \(a?.city ?? "?") \(a?.state ?? "?") \(a?.postalCode ?? "?")",
                    state: .full)
        Task {
            do {
                guard let client = self.applePayClient else { throw StoreAPI.APIError.server("no client") }
                self.console.log("17", "App → BT SDK", "tokenize(payment)")
                let nonce = try await client.tokenize(payment)
                self.console.log("19", "BT SDK → App", "BTApplePayCardNonce",
                                 "nonce=\(nonce.nonce)", state: .response)

                self.console.log("20", "App → Server", "POST /api/braintree/checkout", state: .full)
                let shipping = ship.map(Self.shippingPayload) ?? [:]
                let tx = try await StoreAPI.checkout(
                    nonce: nonce.nonce, shippingMethod: self.shippingMethodID,
                    shipping: shipping)
                self.console.log("21", "Server → Gateway", "gateway.transaction.sale",
                                 "id=\(tx.id) status=\(tx.status)", state: .full)
                self.setResult("✅ Transaction \(tx.id) — $\(tx.amount)")
                completion(PKPaymentAuthorizationResult(status: .success, errors: nil))
            } catch {
                self.console.log("✕", "error", "authorization failed", error.localizedDescription)
                self.setResult("❌ \(error.localizedDescription)")
                completion(PKPaymentAuthorizationResult(status: .failure, errors: [error]))
            }
        }
    }

    func paymentAuthorizationControllerDidFinish(_ controller: PKPaymentAuthorizationController) {
        controller.dismiss()
        console.log("22", "Sheet → App", "didFinish → dismiss()", state: .response)
        setBusy(false)
    }
}
