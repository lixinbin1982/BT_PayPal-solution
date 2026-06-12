import Foundation

enum Config {
    /// LumenX demo server (issues Braintree client tokens, prices the cart,
    /// creates the transaction). Railway deployment by default — HTTPS, so no
    /// ATS exceptions are needed. For a local server use http://localhost:3000
    /// and add an ATS exception (see README).
    static let serverBase = URL(string: "https://web-production-84b119.up.railway.app")!

    /// Item bought via the express checkout shortcut (matches the web demo catalog).
    static let items: [[String: Any]] = [["id": "baton-4-pro", "qty": 1]]

    /// Braintree sandbox "fake" nonce used in Mock mode — the gateway treats it
    /// as a tokenized Apple Pay Visa card, so transaction.sale really executes.
    static let mockApplePayNonce = "fake-apple-pay-visa-nonce"

    /// Mirror app-side API console entries to POST /api/logs/client so the web
    /// store's 📜 API Console shows the mobile ECS sequence too.
    static let mirrorLogsToServer = true
}
