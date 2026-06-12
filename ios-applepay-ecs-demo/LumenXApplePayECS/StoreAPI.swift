import Foundation

/// Thin client for the LumenX demo server (same endpoints the web demo uses).
enum StoreAPI {
    struct Product: Decodable, Identifiable {
        let id: String
        let name: String
        let price: Double
        let tagline: String?
    }

    struct CartPricing: Decodable {
        let itemTotal: String
        let shipping: String
        let tax: String
        let total: String
        let shippingMethod: String?
    }

    struct Transaction: Decodable {
        let id: String
        let status: String
        let amount: String
    }

    struct CheckoutResponse: Decodable {
        let success: Bool?
        let transaction: Transaction?
        let error: String?
    }

    enum APIError: LocalizedError {
        case server(String)
        var errorDescription: String? {
            if case .server(let m) = self { return m }
            return nil
        }
    }

    static func products() async throws -> [Product] {
        try await get("/api/products")
    }

    static func clientToken() async throws -> String {
        struct R: Decodable { let clientToken: String }
        let r: R = try await get("/api/braintree/client-token")
        return r.clientToken
    }

    static func price(state: String, shippingMethod: String) async throws -> CartPricing {
        try await post("/api/cart/price", body: [
            "items": Config.items, "state": state, "shippingMethod": shippingMethod
        ])
    }

    static func checkout(nonce: String, shippingMethod: String,
                         shipping: [String: String]) async throws -> Transaction {
        let r: CheckoutResponse = try await post("/api/braintree/checkout", body: [
            "paymentMethodNonce": nonce,
            "items": Config.items,
            "shippingMethod": shippingMethod,
            "shipping": shipping
        ])
        if let t = r.transaction, r.success == true { return t }
        throw APIError.server(r.error ?? "checkout failed")
    }

    // MARK: - plumbing

    private static func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, resp) = try await URLSession.shared.data(
            from: Config.serverBase.appendingPathComponent(path))
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        var req = URLRequest(url: Config.serverBase.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        try check(resp, data)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func check(_ resp: URLResponse, _ data: Data) throws {
        guard let http = resp as? HTTPURLResponse, http.statusCode < 400 else {
            let msg = String(data: data, encoding: .utf8) ?? "server error"
            throw APIError.server(msg)
        }
    }
}
